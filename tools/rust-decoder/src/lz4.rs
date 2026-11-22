//! lz4.rs — декодер LZ4 block-формата (порт `lz4.mts`, свой код без зависимостей).
//!
//! Unity пакует блоки бандлов LZ4/LZ4HC, но на распаковке это ОДИН формат:
//! LZ4HC — тот же block-формат, отличается только стратегией сжатия. Фреймовый
//! формат (magic 0x184D2204) не поддерживается: Unity его не использует.
//!
//! Последовательность: token (4 бита литералов | 4 бита длины матча),
//! расширение длины байтами 255+остаток, литералы, offset (2 байта LE), матч.
//! Последняя последовательность — только литералы, без offset.

use crate::binio::{fail, Result};

/// Распаковать LZ4-блок в буфер ровно заданного размера.
pub fn block_decompress(src: &[u8], expected_size: usize) -> Result<Vec<u8>> {
    let mut dst = vec![0u8; expected_size];
    let mut sp = 0usize;
    let mut dp = 0usize;

    while sp < src.len() {
        let token = src[sp];
        sp += 1;

        // --- литералы ---
        let mut lit_len = (token >> 4) as usize;
        if lit_len == 15 {
            loop {
                if sp >= src.len() {
                    return fail("LZ4: длина литералов обрывается", sp);
                }
                let b = src[sp];
                sp += 1;
                lit_len += b as usize;
                if b != 255 {
                    break;
                }
            }
        }
        if sp + lit_len > src.len() {
            return fail(
                format!("LZ4: литерал ({} байт) выходит за конец блока", lit_len),
                sp,
            );
        }
        if dp + lit_len > dst.len() {
            return fail(
                format!(
                    "LZ4: литералы переполняют выход ({} > {})",
                    dp + lit_len,
                    dst.len()
                ),
                sp,
            );
        }
        dst[dp..dp + lit_len].copy_from_slice(&src[sp..sp + lit_len]);
        sp += lit_len;
        dp += lit_len;

        // Последняя последовательность — только литералы.
        if sp >= src.len() {
            break;
        }

        // --- матч ---
        if sp + 2 > src.len() {
            return fail("LZ4: обрезан offset матча", sp);
        }
        let offset = src[sp] as usize | ((src[sp + 1] as usize) << 8);
        sp += 2;
        if offset == 0 {
            return fail("LZ4: offset матча равен 0", sp - 2);
        }
        if offset > dp {
            return fail(
                format!("LZ4: offset {} больше распакованного окна {}", offset, dp),
                sp - 2,
            );
        }

        let mut match_len = (token & 0x0f) as usize + 4;
        if (token & 0x0f) == 15 {
            loop {
                if sp >= src.len() {
                    return fail("LZ4: длина матча обрывается", sp);
                }
                let b = src[sp];
                sp += 1;
                match_len += b as usize;
                if b != 255 {
                    break;
                }
            }
        }
        if dp + match_len > dst.len() {
            return fail(
                format!(
                    "LZ4: матч переполняет выход ({} > {})",
                    dp + match_len,
                    dst.len()
                ),
                sp,
            );
        }
        // Матч может перекрывать сам себя — копируем байт за байтом.
        for mp in (dp - offset..).take(match_len) {
            dst[dp] = dst[mp];
            dp += 1;
        }
    }

    if dp != expected_size {
        return fail(
            format!(
                "LZ4: распаковано {} байт вместо {} (блок обрезан или заголовок врёт)",
                dp, expected_size
            ),
            sp,
        );
    }
    Ok(dst)
}

/// LZ4-блок «только литералы» — для тестовых фикстур (не энкодер).
#[cfg(test)]
pub fn literals(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if data.is_empty() {
        return vec![0];
    }
    if data.len() < 15 {
        out.push((data.len() as u8) << 4);
    } else {
        out.push(0xf0);
        let mut rest = data.len() - 15;
        while rest >= 255 {
            out.push(255);
            rest -= 255;
        }
        out.push(rest as u8);
    }
    out.extend_from_slice(data);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn пустой_блок() {
        assert_eq!(block_decompress(&[0x00], 0).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn только_литералы() {
        let out = block_decompress(&[0x50, b'h', b'e', b'l', b'l', b'o'], 5).unwrap();
        assert_eq!(out, b"hello");
    }

    #[test]
    fn расширение_длины_литералов() {
        let payload = b"0123456789abcdefgh";
        let block = literals(payload);
        assert_eq!(block_decompress(&block, payload.len()).unwrap(), payload);
    }

    #[test]
    fn матч_offset_1() {
        let out = block_decompress(&[0x10, b'a', 0x01, 0x00], 5).unwrap();
        assert_eq!(out, b"aaaaa");
    }

    #[test]
    fn перекрывающийся_матч() {
        let out = block_decompress(&[0x24, b'a', b'b', 0x02, 0x00], 10).unwrap();
        assert_eq!(out, b"ababababab");
    }

    #[test]
    fn расширение_длины_матча() {
        let out = block_decompress(&[0x1f, b'a', 0x01, 0x00, 0x02], 22).unwrap();
        assert_eq!(out, b"a".repeat(22));
    }

    #[test]
    fn offset_0_ошибка() {
        assert!(block_decompress(&[0x10, b'a', 0x00, 0x00], 5).is_err());
    }

    #[test]
    fn размер_не_сошёлся() {
        assert!(block_decompress(&[0x10, b'a', 0x01, 0x00], 6).is_err());
    }
}
