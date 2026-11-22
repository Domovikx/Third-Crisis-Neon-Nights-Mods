//! json.rs — минимальный JSON-писатель промежуточного формата (свой код).
//!
//! Зачем не `serde_json`: контракт промежуточного JSONL сравнивается с выходом
//! TS-эталона ПОБАЙТОВО (`JSON.stringify`), а `serde_json` печатает свои
//! экранирования и порядок ключей. Здесь ровно те правила, что у JS:
//!
//!   - экранируются только `"` `\` и управляющие `0x00..0x1f` (короткие формы
//!     `\b \t \n \f \r`, остальные — `\u00XX` в нижнем регистре);
//!   - не-ASCII идёт как есть (UTF-8), `0x7f` не экранируется;
//!   - числа — только целые (в формате нет float: он живёт в TS-семантике).
//!
//! Base64 — для сырых байтов объектов и #US-кучи: бинарь в JSONL без него не
//! положить, а hex удваивает объём.

use std::io::{self, Write};

/// Писатель с буфером: `raw` — готовый JSON-текст, `str` — экранированная строка.
pub struct Out<W: Write> {
    inner: W,
    buffer: Vec<u8>,
    flush_at: usize,
}

impl<W: Write> Out<W> {
    pub fn new(inner: W) -> Self {
        Out {
            inner,
            buffer: Vec::with_capacity(1 << 16),
            flush_at: 1 << 20,
        }
    }

    pub fn raw(&mut self, text: &str) -> io::Result<()> {
        self.buffer.extend_from_slice(text.as_bytes());
        self.maybe_flush()
    }

    pub fn num(&mut self, value: i64) -> io::Result<()> {
        let mut scratch = [0u8; 20];
        let text = format_i64(value, &mut scratch);
        self.raw(text)
    }

    pub fn unum(&mut self, value: u64) -> io::Result<()> {
        self.raw(&value.to_string())
    }

    /// Строка в кавычках, экранирование как у `JSON.stringify`.
    pub fn string(&mut self, text: &str) -> io::Result<()> {
        self.buffer.push(b'"');
        for &b in text.as_bytes() {
            match b {
                b'"' => self.buffer.extend_from_slice(b"\\\""),
                b'\\' => self.buffer.extend_from_slice(b"\\\\"),
                0x08 => self.buffer.extend_from_slice(b"\\b"),
                0x09 => self.buffer.extend_from_slice(b"\\t"),
                0x0a => self.buffer.extend_from_slice(b"\\n"),
                0x0c => self.buffer.extend_from_slice(b"\\f"),
                0x0d => self.buffer.extend_from_slice(b"\\r"),
                b if b < 0x20 => {
                    self.buffer.extend_from_slice(b"\\u00");
                    self.buffer.push(hex_digit(b >> 4));
                    self.buffer.push(hex_digit(b & 0x0f));
                }
                b => self.buffer.push(b),
            }
        }
        self.buffer.push(b'"');
        self.maybe_flush()
    }

    /// Сырые байты как base64-строка в кавычках.
    pub fn base64(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.buffer.push(b'"');
        encode_base64_into(bytes, &mut self.buffer);
        self.buffer.push(b'"');
        self.maybe_flush()
    }

    pub fn newline(&mut self) -> io::Result<()> {
        self.buffer.push(b'\n');
        self.maybe_flush()
    }

    fn maybe_flush(&mut self) -> io::Result<()> {
        if self.buffer.len() >= self.flush_at {
            self.inner.write_all(&self.buffer)?;
            self.buffer.clear();
        }
        Ok(())
    }

    pub fn finish(mut self) -> io::Result<W> {
        self.inner.write_all(&self.buffer)?;
        self.inner.flush()?;
        Ok(self.inner)
    }
}

fn hex_digit(v: u8) -> u8 {
    match v {
        0..=9 => b'0' + v,
        _ => b'a' + (v - 10),
    }
}

fn format_i64(value: i64, scratch: &mut [u8; 20]) -> &str {
    let negative = value < 0;
    let mut magnitude = value.unsigned_abs();
    let mut at = scratch.len();
    loop {
        at -= 1;
        scratch[at] = b'0' + (magnitude % 10) as u8;
        magnitude /= 10;
        if magnitude == 0 {
            break;
        }
    }
    if negative {
        at -= 1;
        scratch[at] = b'-';
    }
    std::str::from_utf8(&scratch[at..]).expect("цифры — валидный UTF-8")
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode_base64_into(bytes: &[u8], out: &mut Vec<u8>) {
    let (chunks, rest) = bytes.as_chunks::<3>();
    for chunk in chunks {
        let value = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | chunk[2] as u32;
        out.push(BASE64_ALPHABET[(value >> 18) as usize & 63]);
        out.push(BASE64_ALPHABET[(value >> 12) as usize & 63]);
        out.push(BASE64_ALPHABET[(value >> 6) as usize & 63]);
        out.push(BASE64_ALPHABET[value as usize & 63]);
    }
    match rest.len() {
        1 => {
            let value = (rest[0] as u32) << 16;
            out.push(BASE64_ALPHABET[(value >> 18) as usize & 63]);
            out.push(BASE64_ALPHABET[(value >> 12) as usize & 63]);
            out.extend_from_slice(b"==");
        }
        2 => {
            let value = ((rest[0] as u32) << 16) | ((rest[1] as u32) << 8);
            out.push(BASE64_ALPHABET[(value >> 18) as usize & 63]);
            out.push(BASE64_ALPHABET[(value >> 12) as usize & 63]);
            out.push(BASE64_ALPHABET[(value >> 6) as usize & 63]);
            out.push(b'=');
        }
        _ => {}
    }
}

/// Декодер base64 — нужен тестам (векторы в base64) и `--files` в тестах.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(f: impl FnOnce(&mut Out<Vec<u8>>) -> io::Result<()>) -> String {
        let mut out = Out::new(Vec::new());
        f(&mut out).unwrap();
        String::from_utf8(out.finish().unwrap()).unwrap()
    }

    #[test]
    fn экранирование_как_json_stringify() {
        let text = "a\"b\\c\n\t\u{1}\u{7f}привет";
        assert_eq!(
            render(|o| o.string(text)),
            "\"a\\\"b\\\\c\\n\\t\\u0001\u{7f}привет\""
        );
    }

    #[test]
    fn base64_совпадает_с_node() {
        for (bytes, expected) in [
            (b"".to_vec(), ""),
            (b"f".to_vec(), "Zg=="),
            (b"fo".to_vec(), "Zm8="),
            (b"foo".to_vec(), "Zm9v"),
            (b"foobar".to_vec(), "Zm9vYmFy"),
        ] {
            let mut buf = Vec::new();
            encode_base64_into(&bytes, &mut buf);
            assert_eq!(String::from_utf8(buf).unwrap(), expected);
            assert_eq!(base64_decode(expected).unwrap(), bytes);
        }
    }

    #[test]
    fn целые_числа() {
        assert_eq!(render(|o| o.num(-42)), "-42");
        assert_eq!(
            render(|o| o.unum(9_007_199_254_740_993)),
            "9007199254740993"
        );
    }
}
