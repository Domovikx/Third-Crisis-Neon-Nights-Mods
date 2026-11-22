//! lzma.rs — декодер LZMA1 для блоков UnityFS.
//!
//! Единственная внешняя зависимость проекта — крейт `lzma-rs` (чистый Rust,
//! без unsafe и C-кода): писать LZMA-декодер руками ради нулевой пользы
//! значило бы поддерживать 300 строк криптографически-подобной арифметики.
//! Используется его raw-режим: Unity кладёт поток как «1 байт свойств +
//! 4 байта dictSize (LE) + range-coded данные», без .lzma-заголовка и без
//! размера — размер известен из заголовка блока.
//!
//! Все бандлы Third Crisis Neon Nights сжаты LZ4HC, поэтому ветка проверена
//! синтетическим вектором (эталонный xz), как и в TS-версии.

use lzma_rs::decompress::raw::{LzmaDecoder, LzmaParams, LzmaProperties};

use crate::binio::{fail, Error, Result};

/// Распаковать raw LZMA1-поток (props + dictSize + данные) до `expected_size`.
pub fn raw_decompress(src: &[u8], expected_size: usize) -> Result<Vec<u8>> {
    if src.len() < 5 {
        return fail("LZMA: заголовок свойств обрезан", 0);
    }
    let props = src[0];
    if props >= 9 * 5 * 5 {
        return fail(format!("LZMA: битые свойства 0x{:x}", props), 0);
    }
    let lc = (props % 9) as u32;
    let rest = props / 9;
    let lp = (rest % 5) as u32;
    let pb = (rest / 5) as u32;

    let dict_size = u32::from_le_bytes([src[1], src[2], src[3], src[4]]);
    let stream = &src[5..];
    if stream.is_empty() || stream[0] != 0 {
        return fail("LZMA: первый байт потока должен быть 0", 5);
    }

    let params = LzmaParams::new(
        LzmaProperties { lc, lp, pb },
        dict_size,
        Some(expected_size as u64),
    );
    let mut decoder = LzmaDecoder::new(params, None).map_err(|e| Error(e.to_string()))?;
    let mut out: Vec<u8> = Vec::with_capacity(expected_size);
    let mut input = stream;
    decoder
        .decompress(&mut input, &mut out)
        .map_err(|e| Error(format!("LZMA: {}", e)))?;
    if out.len() != expected_size {
        return fail(
            format!(
                "LZMA: распаковано {} байт вместо {}",
                out.len(),
                expected_size
            ),
            0,
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Вектор из TS-тестов (helpers.mts): свой синтетический текст, сжатый xz.
    const VECTOR_B64: &str = "XQAAgAAAJhaFvEXxKMD3vJdaVM3YmZYIcuGfomC80YMctBvJLU+G8az9Ak1+IPD899S/t4cN1zZIecm7zvzpfkthpBTKC0quwsPpIIMIn/ZPx9eJco6L/F6M4dBKM1IoO1+mphP//9bu4AA=";

    fn text() -> String {
        "LZMA raw decoder test. Hello, hello, hello! The quick brown fox jumps over the lazy dog. 0123456789.\n".repeat(6)
    }

    fn vector() -> Vec<u8> {
        crate::json::base64_decode(VECTOR_B64).expect("вектор декодируется")
    }

    #[test]
    fn raw_поток_декодируется() {
        let out = raw_decompress(&vector(), text().len()).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), text());
    }

    #[test]
    fn обрезанный_заголовок() {
        assert!(raw_decompress(&[0x5d, 0x00], 10).is_err());
    }

    #[test]
    fn первый_байт_потока() {
        let mut bytes = vector();
        bytes[5] = 1;
        assert!(raw_decompress(&bytes, text().len()).is_err());
    }

    #[test]
    fn размер_больше_потока() {
        assert!(raw_decompress(&vector(), text().len() + 500).is_err());
    }
}
