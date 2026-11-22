//! unityfs.rs — контейнер UnityFS (AssetBundle), порт `unityfs.mts`.
//!
//! Заголовок (ВСЁ big-endian):
//!   cstring signature, u32 formatVersion, cstring playerVersion,
//!   cstring engineVersion, i64 size, u32 compressedBlocksInfoSize,
//!   u32 uncompressedBlocksInfoSize, u32 flags
//!   [выравнивание до 16 при formatVersion >= 7]
//!
//! Внутри blocksInfo (тоже big-endian): hash(16), i32 blockCount,
//! blocks*(u32 uncompressed, u32 compressed, u16 flags), i32 nodeCount,
//! nodes*(i64 offset, i64 size, u32 flags, cstring path).
//!
//! Сжатие: 0 — нет, 1 — LZMA, 2/3 — LZ4/LZ4HC (на распаковке один формат).

use crate::binio::{fail, i64_to_usize, signature, Reader, Result};
use crate::lz4;
use crate::lzma;

const COMPRESSION_NONE: u32 = 0;
const COMPRESSION_LZMA: u32 = 1;
const COMPRESSION_LZ4: u32 = 2;
const COMPRESSION_LZ4HC: u32 = 3;
const COMPRESSION_TYPE_MASK: u32 = 0x3f;

/// blocks+directory в одном блоке.
pub const FLAG_BLOCKS_AND_DIRECTORY_INFO_COMBINED: u32 = 0x40;
/// blocksInfo лежит в конце файла.
pub const FLAG_BLOCKS_INFO_AT_END: u32 = 0x80;
/// Новые бандлы: выравнивание перед блоками данных; старые: бит шифрования.
pub const FLAG_BLOCK_INFO_NEED_PADDING_AT_START: u32 = 0x200;
/// Новые бандлы: биты шифрования.
const FLAG_NEW_ENCRYPTION: u32 = 0x1400;

#[derive(Debug, Clone)]
pub struct Header {
    pub format_version: u32,
    pub player_version: String,
    pub engine_version: String,
    pub flags: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct Block {
    pub uncompressed_size: u32,
    pub compressed_size: u32,
    pub flags: u32,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub path: String,
    pub offset: usize,
    pub size: usize,
    pub flags: u32,
}

/// Разобранный архив: распакованные блоки склеены в `data`.
pub struct Archive {
    pub header: Header,
    pub blocks: Vec<Block>,
    pub entries: Vec<Entry>,
    pub data: Vec<u8>,
}

impl Archive {
    /// Данные entry по индексу (границы уже проверены при разборе).
    pub fn read_entry(&self, entry: &Entry) -> &[u8] {
        &self.data[entry.offset..entry.offset + entry.size]
    }
}

/// Сигнатура файла — UnityFS?
pub fn is_unityfs(data: &[u8]) -> bool {
    signature(data, 8) == "UnityFS\0"
}

/// Старый набор флагов (до фикса выравнивания). Границы — как в UnityPy.
pub fn uses_legacy_archive_flags(engine_version: &str) -> bool {
    // `2020.3.34f1`: хвост после цифр отбрасываем (как regex в эталоне).
    let mut parts = engine_version.split('.').map(leading_digits);
    let major: u32 = match parts.next() {
        Some(v) => v,
        None => return true,
    };
    let minor: u32 = match parts.next() {
        Some(v) => v,
        None => return true,
    };
    let patch: u32 = parts.next().unwrap_or(0);
    if major < 2020 {
        return true;
    }
    if major == 2020 {
        return minor < 3 || (minor == 3 && patch < 34);
    }
    if major == 2021 {
        return minor < 3 || (minor == 3 && patch < 2);
    }
    if major == 2022 {
        return minor < 1 || (minor == 1 && patch < 1);
    }
    false
}

fn leading_digits(text: &str) -> u32 {
    let digits: String = text.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(0)
}

fn decompress_block(compressed: &[u8], uncompressed_size: usize, flags: u32) -> Result<Vec<u8>> {
    match flags & COMPRESSION_TYPE_MASK {
        COMPRESSION_NONE => {
            if compressed.len() != uncompressed_size {
                return fail(
                    format!(
                        "UnityFS: блок без сжатия имеет размер {}, ожидался {}",
                        compressed.len(),
                        uncompressed_size
                    ),
                    0,
                );
            }
            Ok(compressed.to_vec())
        }
        COMPRESSION_LZ4 | COMPRESSION_LZ4HC => lz4::block_decompress(compressed, uncompressed_size),
        COMPRESSION_LZMA => lzma::raw_decompress(compressed, uncompressed_size),
        other => fail(format!("UnityFS: неизвестный тип сжатия {}", other), 0),
    }
}

/// Разобрать контейнер UnityFS.
pub fn read_unityfs(data: &[u8]) -> Result<Archive> {
    let mut r = Reader::new(data, true);

    let sig = r.cstring()?;
    if sig != "UnityFS" {
        return fail(
            format!("UnityFS: сигнатура \"{}\", ожидалась \"UnityFS\"", sig),
            0,
        );
    }
    let format_version = r.u32()?;
    let player_version = r.cstring()?;
    let engine_version = r.cstring()?;
    let _size = r.i64()?;
    let compressed_blocks_info_size = r.u32()? as usize;
    let uncompressed_blocks_info_size = r.u32()? as usize;
    let flags = r.u32()?;

    let header = Header {
        format_version,
        player_version,
        engine_version: engine_version.clone(),
        flags,
    };

    let legacy = uses_legacy_archive_flags(&engine_version);
    let encrypted = if legacy {
        (flags & FLAG_BLOCK_INFO_NEED_PADDING_AT_START) != 0
    } else {
        (flags & FLAG_NEW_ENCRYPTION) != 0
    };
    if encrypted {
        return fail(
            "UnityFS: бандл зашифрован (ArchiveStorage), расшифровка не поддерживается",
            0,
        );
    }

    // Выравнивание после заголовка появилось в formatVersion 7.
    if format_version >= 7 {
        r.align(16);
    }

    let data_start = r.pos;
    let blocks_info_at_end = (flags & FLAG_BLOCKS_INFO_AT_END) != 0;
    let blocks_info_start = if blocks_info_at_end {
        match data.len().checked_sub(compressed_blocks_info_size) {
            Some(v) => v,
            None => return fail("UnityFS: blocksInfo выходит за начало файла", 0),
        }
    } else {
        data_start
    };
    r.seek(blocks_info_start)?;
    let blocks_info_compressed = r.bytes(compressed_blocks_info_size)?.to_vec();
    let blocks_info = decompress_block(
        &blocks_info_compressed,
        uncompressed_blocks_info_size,
        flags,
    )?;

    let mut br = Reader::new(&blocks_info, true);
    br.skip(16)?; // uncompressedDataHash — для распаковки не нужен
    let block_count = br.i32()?;
    if block_count < 0 || (block_count as usize) * 10 > br.remaining() {
        return fail(
            format!("UnityFS: некорректное число блоков {}", block_count),
            br.pos,
        );
    }
    let mut blocks = Vec::with_capacity(block_count as usize);
    for _ in 0..block_count {
        blocks.push(Block {
            uncompressed_size: br.u32()?,
            compressed_size: br.u32()?,
            flags: br.u16()? as u32,
        });
    }

    let node_count = br.i32()?;
    if node_count < 0 || node_count as usize > br.remaining() {
        return fail(
            format!("UnityFS: некорректное число entry {}", node_count),
            br.pos,
        );
    }
    let mut entries = Vec::with_capacity(node_count as usize);
    for _ in 0..node_count {
        let offset = i64_to_usize(br.i64()?, "UnityFS: offset entry", br.pos)?;
        let size = i64_to_usize(br.i64()?, "UnityFS: размер entry", br.pos)?;
        let entry_flags = br.u32()?;
        let path = br.cstring()?;
        entries.push(Entry {
            path,
            offset,
            size,
            flags: entry_flags,
        });
    }

    // Данные блоков начинаются после blocksInfo (+ паддинг в новых бандлах).
    if blocks_info_at_end {
        r.seek(data_start)?;
    } else {
        r.seek(blocks_info_start + compressed_blocks_info_size)?;
    }
    if !legacy && (flags & FLAG_BLOCK_INFO_NEED_PADDING_AT_START) != 0 {
        r.align(16);
    }

    let total: usize = blocks.iter().map(|b| b.uncompressed_size as usize).sum();
    let mut block_data: Vec<u8> = Vec::with_capacity(total);
    for block in &blocks {
        let compressed = r.bytes(block.compressed_size as usize)?;
        let part = decompress_block(compressed, block.uncompressed_size as usize, block.flags)?;
        block_data.extend_from_slice(&part);
    }

    for entry in &entries {
        if entry.offset + entry.size > block_data.len() {
            return fail(
                format!(
                    "UnityFS: entry \"{}\" выходит за данные ({} + {} > {})",
                    entry.path,
                    entry.offset,
                    entry.size,
                    block_data.len()
                ),
                0,
            );
        }
    }

    Ok(Archive {
        header,
        blocks,
        entries,
        data: block_data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{build_blocks_info, build_unityfs, BuildUnityFs};

    #[test]
    fn распаковка_без_сжатия() {
        let body = b"CAB-test-payload".to_vec();
        let blocks_info = build_blocks_info(
            &[(body.len() as u32, body.len() as u32, 0)],
            &[("CAB-test", 0, body.len())],
        );
        let file = build_unityfs(&BuildUnityFs {
            blocks_info: &blocks_info,
            blocks: vec![(body.clone(), 0, body.len())],
            flags: FLAG_BLOCKS_AND_DIRECTORY_INFO_COMBINED,
            engine_version: "2022.3.62f3",
            format_version: 8,
            blocks_info_at_end: false,
        });
        let archive = read_unityfs(&file).unwrap();
        assert_eq!(archive.entries.len(), 1);
        assert_eq!(archive.entries[0].path, "CAB-test");
        assert_eq!(archive.read_entry(&archive.entries[0]), &body[..]);
    }

    #[test]
    fn lz4_блок_распаковывается() {
        let payload = b"hello hello hello hello".to_vec();
        let stored = lz4::literals(&payload);
        let blocks_info = build_blocks_info(
            &[(payload.len() as u32, stored.len() as u32, 2)],
            &[("CAB-lz4", 0, payload.len())],
        );
        let file = build_unityfs(&BuildUnityFs {
            blocks_info: &blocks_info,
            blocks: vec![(stored, 2, payload.len())],
            flags: FLAG_BLOCKS_AND_DIRECTORY_INFO_COMBINED,
            engine_version: "2022.3.62f3",
            format_version: 8,
            blocks_info_at_end: false,
        });
        let archive = read_unityfs(&file).unwrap();
        assert_eq!(archive.read_entry(&archive.entries[0]), &payload[..]);
    }

    #[test]
    fn blocksinfo_в_конце_файла() {
        let body = b"tail-info".to_vec();
        let blocks_info = build_blocks_info(&[(9, 9, 0)], &[("CAB-tail", 0, 9)]);
        let file = build_unityfs(&BuildUnityFs {
            blocks_info: &blocks_info,
            blocks: vec![(body.clone(), 0, 9)],
            flags: FLAG_BLOCKS_AND_DIRECTORY_INFO_COMBINED | FLAG_BLOCKS_INFO_AT_END,
            engine_version: "2022.3.62f3",
            format_version: 8,
            blocks_info_at_end: true,
        });
        let archive = read_unityfs(&file).unwrap();
        assert_eq!(archive.read_entry(&archive.entries[0]), &body[..]);
    }

    #[test]
    fn битая_сигнатура() {
        assert!(read_unityfs(b"NotUnity").is_err());
    }

    #[test]
    fn легаси_границы_флагов() {
        assert!(uses_legacy_archive_flags("2020.3.33f1"));
        assert!(!uses_legacy_archive_flags("2020.3.34f1"));
        assert!(uses_legacy_archive_flags("2022.1.0f1"));
        assert!(!uses_legacy_archive_flags("2022.1.1f1"));
        assert!(!uses_legacy_archive_flags("2022.3.62f3"));
    }
}
