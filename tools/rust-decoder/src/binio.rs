//! binio.rs — курсор по байтам для парсеров Unity (порт `binary.mts`).
//!
//! Один тип на весь декодер: LE/BE-числа, строки с нулевым терминатором,
//! выравнивание. Ошибка несёт позицию: при разборе битого файла должно быть
//! видно, ГДЕ парсер споткнулся.
//!
//! Порядок байт — свойство ридера (контейнер UnityFS и legacy-префикс
//! SerializedFile пишутся big-endian, содержимое — как указано флагом).

use std::fmt;

/// Ошибка формата: сообщение + позиция в разбираемом буфере.
#[derive(Debug, Clone)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Ошибка с позицией (`смещение N` — как в TS-версии).
pub fn fail<T>(message: impl Into<String>, position: usize) -> Result<T> {
    Err(Error(format!("{} (смещение {})", message.into(), position)))
}

/// Курсор чтения.
pub struct Reader<'a> {
    pub data: &'a [u8],
    pub pos: usize,
    /// true — big-endian (по умолчанию методы читают в этом порядке).
    pub be: bool,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8], be: bool) -> Self {
        Reader { data, pos: 0, be }
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn need(&self, n: usize) -> Result<()> {
        if self.pos + n > self.data.len() {
            return fail(
                format!(
                    "усечённые данные: нужно {} байт, осталось {}",
                    n,
                    self.remaining()
                ),
                self.pos,
            );
        }
        Ok(())
    }

    pub fn u8(&mut self) -> Result<u8> {
        self.need(1)?;
        let v = self.data[self.pos];
        self.pos += 1;
        Ok(v)
    }

    pub fn i8(&mut self) -> Result<i8> {
        Ok(self.u8()? as i8)
    }

    pub fn u16(&mut self) -> Result<u16> {
        self.need(2)?;
        let b = &self.data[self.pos..self.pos + 2];
        self.pos += 2;
        Ok(if self.be {
            u16::from_be_bytes([b[0], b[1]])
        } else {
            u16::from_le_bytes([b[0], b[1]])
        })
    }

    pub fn i16(&mut self) -> Result<i16> {
        Ok(self.u16()? as i16)
    }

    pub fn u32(&mut self) -> Result<u32> {
        self.need(4)?;
        let b = &self.data[self.pos..self.pos + 4];
        self.pos += 4;
        Ok(if self.be {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        })
    }

    pub fn i32(&mut self) -> Result<i32> {
        Ok(self.u32()? as i32)
    }

    pub fn u64(&mut self) -> Result<u64> {
        self.need(8)?;
        let b = &self.data[self.pos..self.pos + 8];
        self.pos += 8;
        let mut arr = [0u8; 8];
        arr.copy_from_slice(b);
        Ok(if self.be {
            u64::from_be_bytes(arr)
        } else {
            u64::from_le_bytes(arr)
        })
    }

    pub fn i64(&mut self) -> Result<i64> {
        Ok(self.u64()? as i64)
    }

    pub fn f32(&mut self) -> Result<f32> {
        Ok(f32::from_bits(self.u32()?))
    }

    pub fn f64(&mut self) -> Result<f64> {
        Ok(f64::from_bits(self.u64()?))
    }

    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        self.need(n)?;
        let out = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    /// Строка UTF-8 до нулевого байта.
    pub fn cstring(&mut self) -> Result<String> {
        self.cstring_limited(32767)
    }

    pub fn cstring_limited(&mut self, max_length: usize) -> Result<String> {
        let start = self.pos;
        let limit = self.data.len().min(start + max_length);
        let end = self.data[start..limit]
            .iter()
            .position(|b| *b == 0)
            .map(|offset| start + offset);
        let Some(end) = end else {
            return fail("строка без нулевого терминатора", self.pos);
        };
        let text = String::from_utf8_lossy(&self.data[start..end]).into_owned();
        self.pos = end + 1;
        Ok(text)
    }

    pub fn align(&mut self, alignment: usize) {
        let rem = self.pos % alignment;
        if rem != 0 {
            self.pos += alignment - rem;
        }
    }

    pub fn seek(&mut self, position: usize) -> Result<()> {
        if position > self.data.len() {
            return fail(
                format!("выход за границы буфера: запрошена позиция {}", position),
                self.pos,
            );
        }
        self.pos = position;
        Ok(())
    }

    pub fn skip(&mut self, n: usize) -> Result<()> {
        self.need(n)?;
        self.pos += n;
        Ok(())
    }
}

/// i64 → usize с проверкой: молча терять точность нельзя.
pub fn i64_to_usize(value: i64, what: &str, position: usize) -> Result<usize> {
    if value < 0 {
        return fail(format!("{} отрицательный: {}", what, value), position);
    }
    usize::try_from(value as u64).map_err(|_| Error(format!("{} не влезает: {}", what, value)))
}

/// Первые байты строкой latin1 — для определения сигнатуры файла.
pub fn signature(data: &[u8], length: usize) -> String {
    data.iter()
        .take(length.min(data.len()))
        .map(|b| *b as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn числа_le_и_be() {
        let data = [0x01, 0x02, 0x03, 0x04];
        let mut le = Reader::new(&data, false);
        assert_eq!(le.u32().unwrap(), 0x0403_0201);
        let mut be = Reader::new(&data, true);
        assert_eq!(be.u32().unwrap(), 0x0102_0304);
    }

    #[test]
    fn cstring_и_выравнивание() {
        let data = b"ab\0\0\xff";
        let mut r = Reader::new(data, false);
        assert_eq!(r.cstring().unwrap(), "ab");
        assert_eq!(r.pos, 3);
        r.align(4);
        assert_eq!(r.pos, 4);
    }

    #[test]
    fn усечённые_данные_несут_позицию() {
        let mut r = Reader::new(&[0, 0], false);
        let error = r.u32().unwrap_err();
        assert!(error.0.contains("смещение 0"));
    }
}
