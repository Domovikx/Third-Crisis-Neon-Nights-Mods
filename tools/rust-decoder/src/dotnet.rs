//! dotnet.rs —找到 .NET-сборку и её кучу `#US` (порт `dotnet.mts`).
//!
//! Байтовый уровень: разбирается только метаданные (сигнатура `BSJB`,
//! заголовок потоков, куча `#US`). Какие строки из кучи считать настройками
//! или UI-текстом — семантика TS (`scanDotnetSettings`/`scanDotnetUiStrings`),
//! поэтому здесь отдаётся сама куча, а не списки ключей.

/// Сигнатура метаданных .NET.
const BSJB: &[u8] = &[0x42, 0x53, 0x4a, 0x42];

/// Найти кучу `#US`: `(offset, size)` от начала файла.
pub fn find_us_heap(data: &[u8]) -> Option<(usize, usize)> {
    let sig_offset = data.windows(BSJB.len()).position(|window| window == BSJB)?;

    let view = |at: usize| -> Option<u32> {
        if at + 4 > data.len() {
            return None;
        }
        Some(u32::from_le_bytes([
            data[at],
            data[at + 1],
            data[at + 2],
            data[at + 3],
        ]))
    };

    let mut pos = sig_offset + 12;
    let version_len = view(pos)? as usize;
    pos += 4 + version_len;
    if pos % 4 != 0 {
        pos += 4 - (pos % 4);
    }
    if pos + 4 > data.len() {
        return None;
    }
    let streams_count = u16::from_le_bytes([data[pos + 2], data[pos + 3]]) as usize;
    pos += 4;

    for _ in 0..streams_count {
        if pos + 8 > data.len() {
            return None;
        }
        let stream_offset = view(pos)? as usize;
        let stream_size = view(pos + 4)? as usize;
        pos += 8;
        let name_end = data[pos..].iter().position(|b| *b == 0)? + pos;
        let name = String::from_utf8_lossy(&data[pos..name_end]).into_owned();
        pos = name_end + 1;
        if pos % 4 != 0 {
            pos += 4 - (pos % 4);
        }
        if name == "#US" {
            return Some((sig_offset + stream_offset, stream_size));
        }
    }
    None
}

/// Срез кучи `#US` (с зажимом по границам буфера, как `subarray` в JS).
pub fn us_heap_slice(data: &[u8], heap: (usize, usize)) -> &[u8] {
    let start = heap.0.min(data.len());
    let end = (heap.0 + heap.1).min(data.len());
    &data[start..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Минимальная .NET-сборка: PE-мусор, `BSJB`, версия, потоки `#~` и `#US`.
    pub fn build_dotnet(us_payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 16]; // «PE-заголовок» (не разбирается)
        let sig_at = out.len();
        out.extend_from_slice(BSJB);
        out.extend_from_slice(&[0, 0, 0, 0]); // major/minor
        out.extend_from_slice(&[0, 0, 0, 0]); // reserved
        let version = b"v4.0.30319\0\0";
        out.extend_from_slice(&(version.len() as u32).to_le_bytes());
        out.extend_from_slice(version);
        while !out.len().is_multiple_of(4) {
            out.push(0);
        }
        // Заголовок потоков: flags(2) + count(2).
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(&2u16.to_le_bytes());

        // Первый поток: #~ (пустой) — проверяем, что перебор доходит до #US.
        let streams_header_at = out.len();
        out.extend_from_slice(&[0; 8]); // offset + size = 0
        out.extend_from_slice(b"#~\0\0");
        let us_header_at = out.len();
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(b"#US\0");
        while !out.len().is_multiple_of(4) {
            out.push(0);
        }
        let us_start = out.len();
        out.extend_from_slice(us_payload);
        let us_size = out.len() - us_start;

        // Патчим смещения/размеры потоков (относительно сигнатуры).
        let patch = |at: usize, offset: usize, size: usize, out: &mut Vec<u8>| {
            out[at..at + 4].copy_from_slice(&((offset) as u32).to_le_bytes());
            out[at + 4..at + 8].copy_from_slice(&(size as u32).to_le_bytes());
        };
        patch(streams_header_at, 0, 0, &mut out);
        patch(us_header_at, us_start - sig_at, us_size, &mut out);
        out
    }

    #[test]
    fn куча_us_находится() {
        let dll = build_dotnet(&[0x05, 0, b'H', 0, b'i', 0, 0]);
        let heap = find_us_heap(&dll).expect("куча есть");
        assert_eq!(us_heap_slice(&dll, heap), &[0x05, 0, b'H', 0, b'i', 0, 0]);
    }

    #[test]
    fn без_сигнатуры_кучи_нет() {
        assert!(find_us_heap(b"not a dotnet assembly").is_none());
    }
}
