//! rd1read.rs — чтение промежуточного rd1 (`tmp/raw/<дамп>.rd1.jsonl`).
//!
//! Зачем свой парсер, а не `serde_json`: rd1 пишет наш же `json.rs` в
//! `rust-decoder`, набор конструкций закрытый (объекты, массивы, строки,
//! целые, `true/false`), а объём на реальном дампе — 530 МБ. Побайтовый
//! разбор со срезом по `\n` даёт поток без аллокаций на «общий» JSON-дом и
//! без риска, что чужие экранирования поедут в паритет.
//!
//! Формат записей — `tools/rust-decoder/src/rd1.rs` (там же порядок ключей):
//!
//! ```text
//! {"t":"asset","asset","path","kind"[,"entries"][,"error"]}
//! {"t":"sf","i","name","unityVersion","headerVersion","typeTreeEnabled","objectCount","endian"}
//! {"t":"type","sf","typeId","classId","nodeCount","stringSize","blob"}
//! {"t":"obj","sf","typeId","classId","pathId"[,"raw"]["rs"]["dl"]["cpl"]}
//! {"t":"warn","texts":[...]}
//! {"t":"runs","texts":[...]}
//! {"t":"keys","keys":[{"key","display"}]}
//! {"t":"us","heap"}
//! ```
//!
//! Неизвестные ключи пропускаются (`skip_value`), поэтому добавление поля в
//! rd1 не ломает читатель.

/// Спикер/текст, найденный в сыром объекте (`dl`).
#[derive(Clone, Debug, Default)]
pub struct Dlg {
    pub offset: i64,
    pub speaker: String,
    pub text: String,
    pub rich_text: String,
}

/// Один объект (`obj`).
#[derive(Clone, Debug, Default)]
pub struct ObjRecord {
    pub sf: usize,
    pub type_id: usize,
    pub class_id: i32,
    /// 64-битный id как десятичная строка (в JSONL он тоже строкой числа).
    pub path_id: String,
    /// Байты объекта — только у типизированных (есть type tree).
    pub raw: Option<Vec<u8>>,
    /// Печатные строки raw-скана (тексты).
    pub rs: Vec<String>,
    pub dl: Vec<Dlg>,
    /// ColorParserList: имя → hex.
    pub cpl: Option<Vec<(String, String)>>,
}

/// Запись rd1.
#[derive(Clone, Debug)]
pub enum Record {
    Asset {
        asset: String,
        kind: String,
        error: Option<String>,
    },
    Sf {
        i: usize,
        endian_be: bool,
        type_tree_enabled: bool,
        object_count: usize,
    },
    Type {
        sf: usize,
        type_id: usize,
        class_id: i32,
        node_count: usize,
        string_size: i32,
        blob: Vec<u8>,
    },
    Obj(ObjRecord),
    Warn(Vec<String>),
    Runs(Vec<String>),
    Keys(Vec<(String, String)>),
    Us(Vec<u8>),
}

/// Позиция в буфере строки rd1.
struct P<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> P<'a> {
    fn new(b: &'a [u8]) -> Self {
        P { b, i: 0 }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let c = self.peek()?;
        self.i += 1;
        Some(c)
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.i += 1;
        }
    }

    fn expect(&mut self, c: u8) -> Option<()> {
        self.ws();
        if self.peek()? == c {
            self.i += 1;
            Some(())
        } else {
            None
        }
    }

    /// Ключ объекта: срез без разэкранирования (в rd1 ключи — простой ASCII).
    fn key(&mut self) -> Option<&'a [u8]> {
        self.ws();
        if self.bump()? != b'"' {
            return None;
        }
        let start = self.i;
        while let Some(c) = self.peek() {
            match c {
                b'"' => break,
                b'\\' => return None,
                _ => self.i += 1,
            }
        }
        let end = self.i;
        if self.bump()? != b'"' {
            return None;
        }
        Some(&self.b[start..end])
    }

    /// Строка в кавычках с разэкранированием.
    ///
    /// Быстрый путь — без `\\`: копируем срез как есть (в rd1 так почти всё).
    fn string(&mut self) -> Option<String> {
        self.ws();
        if self.bump()? != b'"' {
            return None;
        }
        let start = self.i;
        let mut escaped = false;
        while let Some(c) = self.peek() {
            match c {
                b'"' => break,
                b'\\' => {
                    escaped = true;
                    self.i += 2;
                }
                _ => self.i += 1,
            }
        }
        let end = self.i;
        if self.bump()? != b'"' {
            return None;
        }
        let raw = &self.b[start..end];
        if !escaped {
            return Some(String::from_utf8_lossy(raw).into_owned());
        }
        Some(unescape(raw))
    }

    fn int(&mut self) -> Option<i64> {
        self.ws();
        let start = self.i;
        if matches!(self.peek(), Some(b'-' | b'+')) {
            self.i += 1;
        }
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        std::str::from_utf8(&self.b[start..self.i])
            .ok()?
            .parse()
            .ok()
    }

    fn boolean(&mut self) -> Option<bool> {
        self.ws();
        if self.b[self.i..].starts_with(b"true") {
            self.i += 4;
            return Some(true);
        }
        if self.b[self.i..].starts_with(b"false") {
            self.i += 5;
            return Some(false);
        }
        None
    }

    /// Пропустить значение любого типа (неизвестный ключ).
    fn skip_value(&mut self) -> Option<()> {
        self.ws();
        match self.peek()? {
            b'"' => {
                self.string()?;
                Some(())
            }
            b'{' => {
                self.i += 1;
                self.ws();
                if self.peek()? == b'}' {
                    self.i += 1;
                    return Some(());
                }
                loop {
                    self.key()?;
                    self.expect(b':')?;
                    self.skip_value()?;
                    self.ws();
                    match self.bump()? {
                        b',' => continue,
                        b'}' => return Some(()),
                        _ => return None,
                    }
                }
            }
            b'[' => {
                self.i += 1;
                self.ws();
                if self.peek()? == b']' {
                    self.i += 1;
                    return Some(());
                }
                loop {
                    self.skip_value()?;
                    self.ws();
                    match self.bump()? {
                        b',' => continue,
                        b']' => return Some(()),
                        _ => return None,
                    }
                }
            }
            _ => {
                while let Some(c) = self.peek() {
                    if matches!(c, b',' | b'}' | b']') {
                        break;
                    }
                    self.i += 1;
                }
                Some(())
            }
        }
    }

    fn string_array(&mut self) -> Option<Vec<String>> {
        self.expect(b'[')?;
        let mut out = Vec::new();
        self.ws();
        if self.peek()? == b']' {
            self.i += 1;
            return Some(out);
        }
        loop {
            out.push(self.string()?);
            self.ws();
            match self.bump()? {
                b',' => continue,
                b']' => return Some(out),
                _ => return None,
            }
        }
    }

    fn dialogue_array(&mut self) -> Option<Vec<Dlg>> {
        self.expect(b'[')?;
        let mut out = Vec::new();
        self.ws();
        if self.peek()? == b']' {
            self.i += 1;
            return Some(out);
        }
        loop {
            let mut dlg = Dlg::default();
            self.expect(b'{')?;
            loop {
                let key = self.string()?;
                self.expect(b':')?;
                match key.as_str() {
                    "offset" => dlg.offset = self.int()?,
                    "speaker" => dlg.speaker = self.string()?,
                    "text" => dlg.text = self.string()?,
                    "rich_text" => dlg.rich_text = self.string()?,
                    _ => self.skip_value()?,
                }
                self.ws();
                match self.bump()? {
                    b',' => continue,
                    b'}' => break,
                    _ => return None,
                }
            }
            out.push(dlg);
            self.ws();
            match self.bump()? {
                b',' => continue,
                b']' => return Some(out),
                _ => return None,
            }
        }
    }

    fn pair_object(&mut self) -> Option<Vec<(String, String)>> {
        self.expect(b'{')?;
        let mut out = Vec::new();
        self.ws();
        if self.peek()? == b'}' {
            self.i += 1;
            return Some(out);
        }
        loop {
            let key = self.string()?;
            self.expect(b':')?;
            let value = self.string()?;
            out.push((key, value));
            self.ws();
            match self.bump()? {
                b',' => continue,
                b'}' => return Some(out),
                _ => return None,
            }
        }
    }

    fn base64_string(&mut self) -> Option<Vec<u8>> {
        let text = self.string()?;
        base64_decode(text.as_bytes())
    }
}

/// Разэкранировать строку rd1 (`json.rs::escape` — обратная операция).
fn unescape(raw: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let c = raw[i];
        if c != b'\\' || i + 1 >= raw.len() {
            out.push(c);
            i += 1;
            continue;
        }
        i += 1;
        match raw[i] {
            b'"' => out.push(b'"'),
            b'\\' => out.push(b'\\'),
            b'/' => out.push(b'/'),
            b'b' => out.push(0x08),
            b'f' => out.push(0x0c),
            b'n' => out.push(b'\n'),
            b'r' => out.push(b'\r'),
            b't' => out.push(b'\t'),
            b'u' => {
                // В rd1 `\uXXXX` — только управляющие символы (`\u00xx`).
                if i + 4 < raw.len() {
                    let hex = std::str::from_utf8(&raw[i + 1..i + 5]).unwrap_or("0000");
                    let code = u32::from_str_radix(hex, 16).unwrap_or(0xFFFD);
                    let ch = char::from_u32(code).unwrap_or('\u{FFFD}');
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                    i += 4;
                }
            }
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Разбор одной строки rd1.
pub fn parse_line(line: &[u8]) -> Option<Record> {
    let mut p = P::new(line);
    p.ws();
    p.expect(b'{')?;

    // Поля собираются по мере появления ключей: порядок в rd1 фиксирован, но
    // читатель от него не зависит.
    let mut tag = String::new();
    let mut asset = String::new();
    let mut kind = String::new();
    let mut error: Option<String> = None;
    let mut sf_index = 0usize;
    let mut endian_be = false;
    let mut type_tree_enabled = false;
    let mut object_count = 0usize;
    let mut type_sf = 0usize;
    let mut type_id = 0usize;
    let mut class_id = 0i32;
    let mut node_count = 0usize;
    let mut string_size = 0i32;
    let mut blob: Vec<u8> = Vec::new();
    let mut obj = ObjRecord::default();
    let mut texts: Vec<String> = Vec::new();
    let mut keys: Vec<(String, String)> = Vec::new();
    let mut heap: Vec<u8> = Vec::new();

    p.ws();
    if p.peek()? == b'}' {
        return None;
    }
    loop {
        let key = p.key()?;
        p.expect(b':')?;
        match key {
            b"t" => tag = p.string()?,
            b"asset" => asset = p.string()?,
            b"kind" => kind = p.string()?,
            b"error" => error = Some(p.string()?),
            b"i" => sf_index = p.int()? as usize,
            b"endian" => endian_be = p.string()? == "be",
            b"typeTreeEnabled" => type_tree_enabled = p.boolean()?,
            b"objectCount" => object_count = p.int()? as usize,
            b"sf" => type_sf = p.int()? as usize,
            b"typeId" => type_id = p.int()? as usize,
            b"classId" => class_id = p.int()? as i32,
            b"nodeCount" => node_count = p.int()? as usize,
            b"stringSize" => string_size = p.int()? as i32,
            b"blob" => blob = p.base64_string()?,
            b"pathId" => obj.path_id = p.string()?,
            b"raw" => obj.raw = Some(p.base64_string()?),
            b"rs" => obj.rs = p.string_array()?,
            b"dl" => obj.dl = p.dialogue_array()?,
            b"cpl" => obj.cpl = Some(p.pair_object()?),
            b"texts" => texts = p.string_array()?,
            b"keys" => {
                p.expect(b'[')?;
                p.ws();
                if p.peek()? != b']' {
                    loop {
                        let mut k = String::new();
                        let mut d = String::new();
                        p.expect(b'{')?;
                        loop {
                            let name = p.key()?;
                            p.expect(b':')?;
                            match name {
                                b"key" => k = p.string()?,
                                b"display" => d = p.string()?,
                                _ => p.skip_value()?,
                            }
                            p.ws();
                            match p.bump()? {
                                b',' => continue,
                                b'}' => break,
                                _ => return None,
                            }
                        }
                        keys.push((k, d));
                        p.ws();
                        match p.bump()? {
                            b',' => continue,
                            b']' => break,
                            _ => return None,
                        }
                    }
                } else {
                    p.i += 1;
                }
            }
            b"heap" => heap = p.base64_string()?,
            _ => p.skip_value()?,
        }
        p.ws();
        match p.bump()? {
            b',' => {
                p.ws();
                continue;
            }
            b'}' => break,
            _ => return None,
        }
    }

    obj.sf = type_sf;
    obj.type_id = type_id;
    obj.class_id = class_id;

    Some(match tag.as_str() {
        "asset" => Record::Asset { asset, kind, error },
        "sf" => Record::Sf {
            i: sf_index,
            endian_be,
            type_tree_enabled,
            object_count,
        },
        "type" => Record::Type {
            sf: type_sf,
            type_id,
            class_id,
            node_count,
            string_size,
            blob,
        },
        "obj" => Record::Obj(obj),
        "warn" => Record::Warn(texts),
        "runs" => Record::Runs(texts),
        "keys" => Record::Keys(keys),
        "us" => Record::Us(heap),
        _ => return None,
    })
}

/// Base64 → байты (стандартный алфавит с `=`; переводы строк не встречаются).
pub fn base64_decode(src: &[u8]) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    }
    if src.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(src.len() / 4 * 3);
    let mut i = 0;
    while i < src.len() {
        let chunk = &src[i..i + 4];
        let pad = chunk.iter().filter(|c| **c == b'=').count();
        let mut acc: u32 = 0;
        for (k, c) in chunk.iter().enumerate() {
            let v = if *c == b'=' { 0 } else { val(*c)? as u32 };
            acc |= v << (18 - 6 * k);
        }
        out.push((acc >> 16) as u8);
        if pad < 2 {
            out.push((acc >> 8) as u8);
        }
        if pad < 1 {
            out.push(acc as u8);
        }
        i += 4;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        assert_eq!(base64_decode(b"aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode(b"YQ==").unwrap(), b"a");
        assert_eq!(base64_decode(b"").unwrap(), b"");
    }

    #[test]
    fn unescape_short_forms_and_unicode() {
        assert_eq!(unescape(b"a\\nb"), "a\nb");
        assert_eq!(unescape(b"\\u0001x"), "\u{1}x");
        assert_eq!(unescape("привет".as_bytes()), "привет");
        assert_eq!(unescape(b"q\\\"q"), "q\"q");
    }

    #[test]
    fn parses_asset_record() {
        let line = br#"{"t":"asset","asset":"level0","path":"C:/x/level0","kind":"serialized"}"#;
        match parse_line(line).unwrap() {
            Record::Asset { asset, kind, error } => {
                assert_eq!(asset, "level0");
                assert_eq!(kind, "serialized");
                assert!(error.is_none());
            }
            _ => panic!("не asset"),
        }
    }

    #[test]
    fn parses_obj_record_with_scans() {
        let line = br#"{"t":"obj","sf":0,"typeId":1,"classId":114,"pathId":"-42","raw":"YQ==","rs":["a","b"],"dl":[{"offset":7,"speaker":"S","text":"T","rich_text":"<i>T</i>"}],"cpl":{"White":"FFFFFF"}}"#;
        match parse_line(line).unwrap() {
            Record::Obj(obj) => {
                assert_eq!(obj.sf, 0);
                assert_eq!(obj.type_id, 1);
                assert_eq!(obj.class_id, 114);
                assert_eq!(obj.path_id, "-42");
                assert_eq!(obj.raw.unwrap(), b"a");
                assert_eq!(obj.rs, vec!["a", "b"]);
                assert_eq!(obj.dl.len(), 1);
                assert_eq!(obj.dl[0].text, "T");
                assert_eq!(obj.dl[0].offset, 7);
                assert_eq!(
                    obj.cpl.unwrap(),
                    vec![("White".to_string(), "FFFFFF".to_string())]
                );
            }
            _ => panic!("не obj"),
        }
    }

    #[test]
    fn skips_unknown_keys() {
        let line = br#"{"t":"sf","i":0,"name":"x","unityVersion":"2021","headerVersion":22,"typeTreeEnabled":true,"objectCount":3,"endian":"le","extra":{"a":[1,2]}}"#;
        match parse_line(line).unwrap() {
            Record::Sf {
                i,
                endian_be,
                type_tree_enabled,
                object_count,
            } => {
                assert_eq!(i, 0);
                assert!(!endian_be);
                assert!(type_tree_enabled);
                assert_eq!(object_count, 3);
            }
            _ => panic!("не sf"),
        }
    }
}
