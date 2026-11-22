//! testkit.rs — синтетические фикстуры для тестов (UnityFS + SerializedFile).
//!
//! ВАЖНО: файлы игры в репозиторий НЕ кладём (это перераспространение
//! контента). Всё собирается байтами здесь — контейнер и ассет в миниатюре.
//! Тот же приём, что в `tests/helpers.mts` у TS-версии.

/// Type tree фикстуры: узлы (по 32 байта) + строковый буфер.
pub type FixtureTypeTree = (Vec<u8>, Vec<u8>);

pub struct SerializedFixture {
    pub enable_type_tree: bool,
    /// (classId, type tree)
    pub types: Vec<(i32, Option<FixtureTypeTree>)>,
    /// (pathId, typeId, данные объекта)
    pub objects: Vec<(i64, usize, Vec<u8>)>,
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_i32(out: &mut Vec<u8>, value: i32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_i64(out: &mut Vec<u8>, value: i64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_be_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_be_i64(out: &mut Vec<u8>, value: i64) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_cstring(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(text.as_bytes());
    out.push(0);
}

fn align(out: &mut Vec<u8>, alignment: usize) {
    while !out.len().is_multiple_of(alignment) {
        out.push(0);
    }
}

/// Собрать минимальный SerializedFile версии 22 (little-endian).
pub fn build_serialized_file(fixture: &SerializedFixture) -> Vec<u8> {
    let mut meta = Vec::new();
    push_cstring(&mut meta, "2022.3.62f3");
    push_i32(&mut meta, 19); // targetPlatform
    meta.push(if fixture.enable_type_tree { 1 } else { 0 });
    push_i32(&mut meta, fixture.types.len() as i32);
    for (class_id, type_tree) in &fixture.types {
        push_i32(&mut meta, *class_id);
        meta.push(0); // isStrippedType
        push_u16(&mut meta, 0); // scriptTypeIndex
        if *class_id == 114 {
            meta.extend_from_slice(&[0u8; 16]); // scriptId
        }
        meta.extend_from_slice(&[0u8; 16]); // oldTypeHash
        if fixture.enable_type_tree {
            let (nodes, strings) = type_tree
                .as_ref()
                .map(|(n, s)| (n.clone(), s.clone()))
                .unwrap_or_else(|| (vec![0u8; 32], vec![0u8]));
            push_i32(&mut meta, (nodes.len() / 32) as i32);
            push_i32(&mut meta, strings.len() as i32);
            meta.extend_from_slice(&nodes);
            meta.extend_from_slice(&strings);
            push_i32(&mut meta, 0); // type_dependencies
        }
    }

    // byte_start в таблице хранится ОТНОСИТЕЛЬНО dataOffset — патчим после.
    push_i32(&mut meta, fixture.objects.len() as i32);
    let mut byte_start_at: Vec<usize> = Vec::new();
    for (path_id, type_id, data) in &fixture.objects {
        align(&mut meta, 4);
        push_i64(&mut meta, *path_id);
        byte_start_at.push(meta.len());
        push_i64(&mut meta, 0);
        push_u32(&mut meta, data.len() as u32);
        push_i32(&mut meta, *type_id as i32);
    }

    push_i32(&mut meta, 0); // scripts
    push_i32(&mut meta, 0); // externals
    push_i32(&mut meta, 0); // ref types
    push_cstring(&mut meta, ""); // userInformation

    let data_offset = 48 + meta.len();
    let mut cursor = data_offset as i64;
    for (index, (_, _, data)) in fixture.objects.iter().enumerate() {
        let relative = cursor - data_offset as i64;
        meta[byte_start_at[index]..byte_start_at[index] + 8]
            .copy_from_slice(&relative.to_le_bytes());
        cursor += data.len() as i64;
    }
    let file_size = cursor;

    let mut header = Vec::new();
    push_be_u32(&mut header, 0); // legacy metadataSize
    push_be_u32(&mut header, 0); // legacy fileSize
    push_be_u32(&mut header, 22); // version
    push_be_u32(&mut header, 0); // legacy dataOffset
    header.push(0); // endian: LE
    header.extend_from_slice(&[0u8; 3]);
    push_be_u32(&mut header, meta.len() as u32);
    push_be_i64(&mut header, file_size);
    push_be_i64(&mut header, data_offset as i64);
    push_be_i64(&mut header, 0);

    let mut out = header;
    out.extend_from_slice(&meta);
    for (_, _, data) in &fixture.objects {
        out.extend_from_slice(data);
    }
    out
}

/// Блок blocksInfo UnityFS (big-endian), hash — нули.
pub fn build_blocks_info(blocks: &[(u32, u32, u32)], nodes: &[(&str, usize, usize)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&[0u8; 16]); // uncompressedDataHash
    push_be_u32(&mut out, blocks.len() as u32);
    for (uncompressed, compressed, flags) in blocks {
        push_be_u32(&mut out, *uncompressed);
        push_be_u32(&mut out, *compressed);
        out.extend_from_slice(&(*flags as u16).to_be_bytes());
    }
    push_be_u32(&mut out, nodes.len() as u32);
    for (path, offset, size) in nodes {
        push_be_i64(&mut out, *offset as i64);
        push_be_i64(&mut out, *size as i64);
        push_be_u32(&mut out, 4);
        push_cstring(&mut out, path);
    }
    out
}

pub struct BuildUnityFs<'a> {
    pub blocks_info: &'a [u8],
    /// (сохранённые байты блока, флаг сжатия, распакованный размер)
    pub blocks: Vec<(Vec<u8>, u32, usize)>,
    pub flags: u32,
    pub engine_version: &'a str,
    pub format_version: u32,
    pub blocks_info_at_end: bool,
}

/// Собрать минимальный UnityFS-контейнер (без сжатия blocksInfo).
pub fn build_unityfs(opts: &BuildUnityFs<'_>) -> Vec<u8> {
    let mut header = Vec::new();
    push_cstring(&mut header, "UnityFS");
    push_be_u32(&mut header, opts.format_version);
    push_cstring(&mut header, "5.x.x");
    push_cstring(&mut header, opts.engine_version);
    let size_at = header.len();
    push_be_i64(&mut header, 0);
    push_be_u32(&mut header, opts.blocks_info.len() as u32);
    push_be_u32(&mut header, opts.blocks_info.len() as u32);
    push_be_u32(&mut header, opts.flags);
    if opts.format_version >= 7 {
        align(&mut header, 16);
    }

    let mut block_data = Vec::new();
    for (stored, _, _) in &opts.blocks {
        block_data.extend_from_slice(stored);
    }

    let mut out = header;
    if opts.blocks_info_at_end {
        out.extend_from_slice(&block_data);
        out.extend_from_slice(opts.blocks_info);
    } else {
        out.extend_from_slice(opts.blocks_info);
        out.extend_from_slice(&block_data);
    }
    let size = out.len() as i64;
    out[size_at..size_at + 8].copy_from_slice(&size.to_be_bytes());
    out
}
