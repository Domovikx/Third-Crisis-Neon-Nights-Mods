//! rawscan.rs — сканеры «сырых» байтов Unity-объектов и файлов.
//!
//! Байтовый уровень: строки ищутся прямо в байтах, без разбора типов.
//! Поведение скопировано поштучно с `rawscan.mts` (а тот — с Python-эталона):
//! те же границы, тот же порядок, те же причуды (например, `\n` внутри
//! JSON-строки становится буквой `n` — так делает эталон).
//!
//! Семантика («это UI-текст?», приоритеты, дедуп между ассетами) сюда НЕ
//! входит: её делает TS поверх готовых фактов.

use std::collections::HashSet;

/// Максимальная длина строки в дампе (обрезка как `py_slice`).
pub const MAX_STRING_LEN: usize = 500;
/// Минимальная длина raw-строки.
pub const MIN_RAW_LEN: usize = 3;

/// Python-пробел для `str.strip()` (Unicode White_Space + \x1c-\x1f).
fn is_py_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0b}'
            | '\u{0c}'
            | '\r'
            | ' '
            | '\u{1c}'..='\u{1f}'
            | '\u{85}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
    )
}

/// `str.strip()` без аргументов.
pub fn py_strip(text: &str) -> &str {
    text.trim_matches(is_py_space)
}

/// Python-срез `s[:n]` — по code points.
pub fn py_slice(text: &str, n: usize) -> &str {
    match text.char_indices().nth(n) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

/// `bytes.decode("ascii", errors="replace")` — байты >127 становятся U+FFFD.
pub fn decode_ascii_replace(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| if *b <= 0x7f { *b as char } else { '\u{fffd}' })
        .collect()
}

/// Python `str.isalnum()` для строки после `decode_ascii_replace`
/// (алфавит ASCII + U+FFFD, который не альфа и не цифра).
fn py_is_alnum(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Номер первой позиции `needle` в `haystack`, начиная с `from`.
fn index_of(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let last = haystack.len() - needle.len();
    let mut i = from;
    while i <= last {
        if haystack[i] == needle[0] && &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

// ---------------------------------------------------------------- scan_raw_strings

/// Одна найденная raw-строка (`offset/text/flags/letters` в эталоне).
#[derive(Debug, Clone, PartialEq)]
pub struct RawString {
    pub offset: usize,
    pub text: String,
    pub letters: usize,
}

/// Сколько ASCII-букв в строке (Python `sum(c.isalpha())`).
fn ascii_letters(text: &str) -> usize {
    text.bytes().filter(|b| b.is_ascii_alphabetic()).count()
}

/// Найти печатные ASCII-строки: ≥3 символа и ≥2 буквы.
pub fn scan_raw_strings(raw: &[u8], base_offset: usize) -> Vec<RawString> {
    let mut results = Vec::new();
    let mut i = 0usize;
    while i < raw.len() {
        if (32..=126).contains(&raw[i]) {
            let start = i;
            while i < raw.len() && (32..=126).contains(&raw[i]) {
                i += 1;
            }
            let run = decode_ascii_replace(&raw[start..i]);
            let stripped = py_strip(&run);
            if stripped.len() >= MIN_RAW_LEN {
                let letters = ascii_letters(stripped);
                if letters >= 2 {
                    results.push(RawString {
                        offset: base_offset + start,
                        text: py_slice(stripped, MAX_STRING_LEN).to_string(),
                        letters,
                    });
                }
            }
        } else {
            i += 1;
        }
    }
    results
}

// ---------------------------------------------------------------- JSON-диалоги

/// Прочитать JSON-строку сразу после открывающей кавычки.
///
/// Экранирование как в эталоне: `\"`/`\\`/`\n`/`\r`/`\t` дают САМ байт после
/// слэша (`\n` → буква `n`), `\uXXXX` — символ с кодом.
pub fn extract_json_string(data: &[u8], start: usize) -> (Option<String>, usize) {
    let mut i = start;
    let mut out: Vec<u8> = Vec::new();
    while i < data.len() {
        let b = data[i];
        if b == 0x22 {
            return (Some(String::from_utf8_lossy(&out).into_owned()), i + 1);
        }
        if b == 0x5c {
            if i + 1 < data.len() {
                let next = data[i + 1];
                if next == 0x22 || next == 0x5c || next == 0x6e || next == 0x72 || next == 0x74 {
                    out.push(next);
                    i += 2;
                } else if next == 0x75 {
                    if i + 5 < data.len() {
                        match parse_int_hex(&data[i + 2..i + 6]) {
                            Some(code)
                                if !(0xd800..=0xdfff).contains(&code) && code <= 0x10ffff =>
                            {
                                let ch = char::from_u32(code as u32).unwrap_or('\u{fffd}');
                                let mut buf = [0u8; 4];
                                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                                i += 6;
                            }
                            _ => i += 2,
                        }
                    } else {
                        i += 2;
                    }
                } else {
                    out.push(next);
                    i += 2;
                }
            } else {
                break;
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    (None, i)
}

/// `int(x, 16)` из Python для 4 байт: пробелы/знак/подчёркивания допустимы.
fn parse_int_hex(bytes: &[u8]) -> Option<i64> {
    let text = decode_ascii_replace(bytes).replace('_', "");
    let trimmed = text.trim();
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let value = i64::from_str_radix(digits, 16).ok()?;
    Some(if negative { -value } else { value })
}

/// Одна пара диалога из raw-скана.
#[derive(Debug, Clone, PartialEq)]
pub struct Dialogue {
    pub offset: usize,
    pub speaker: String,
    pub text: String,
    pub rich_text: String,
}

const SPEAKER_MARKER: &[u8] = b"\"Speaker\":\"";
const TEXT_MARKER: &[u8] = b",\"Text\":\"";

/// Убрать rich-теги `<...>` (порт `text.replace(/<[^>]+>/g, "")`).
pub fn strip_rich_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if let Some(close) = bytes[i + 1..].iter().position(|b| *b == b'>') {
                i += close + 2;
                continue;
            }
        }
        // Копируем посимвольно, чтобы не разорвать UTF-8.
        let ch = text[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Вытащить пары `Speaker`/`Text` из сырых байтов объекта.
pub fn parse_dialogue_from_raw(raw: &[u8], base_offset: usize) -> Vec<Dialogue> {
    let mut results = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut i = 0usize;
    while i < raw.len() {
        let Some(pos) = index_of(raw, SPEAKER_MARKER, i) else {
            break;
        };
        let (speaker, speaker_end) = extract_json_string(raw, pos + SPEAKER_MARKER.len());
        let Some(speaker) = speaker else {
            i = pos + 1;
            continue;
        };
        let Some(text_pos) = index_of(raw, TEXT_MARKER, speaker_end) else {
            i = speaker_end;
            continue;
        };
        let (text, text_end) = extract_json_string(raw, text_pos + TEXT_MARKER.len());
        let Some(text) = text else {
            i = text_pos + 1;
            continue;
        };

        let clean = py_strip(&strip_rich_tags(&text)).to_string();
        if !clean.is_empty() && !seen.contains(&format!("{}|{}", speaker, clean)) {
            seen.insert(format!("{}|{}", speaker, clean));
            results.push(Dialogue {
                offset: base_offset + pos,
                speaker,
                text: py_slice(&clean, MAX_STRING_LEN).to_string(),
                rich_text: py_slice(&text, MAX_STRING_LEN).to_string(),
            });
        }
        i = text_end;
    }
    results
}

// ---------------------------------------------------------------- ColorParserList

/// Python `round()`: округление к чётному (banker's).
fn py_round(x: f64) -> f64 {
    let floor = x.floor();
    let diff = x - floor;
    if diff > 0.5 {
        return floor + 1.0;
    }
    if diff < 0.5 {
        return floor;
    }
    // Ровно .5 — к чётному (banker's rounding).
    if (floor as i64) % 2 == 0 {
        floor
    } else {
        floor + 1.0
    }
}

fn read_i32_le(data: &[u8], at: usize) -> i32 {
    i32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

fn read_f32_le(data: &[u8], at: usize) -> f32 {
    f32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

fn hex2(value: i32) -> String {
    format!("{:02X}", value)
}

struct ColorEntry {
    name: String,
    rgb: (i32, i32, i32),
    next: usize,
}

fn read_color_entry(raw: &[u8], offset: usize) -> Option<ColorEntry> {
    let len = raw.len();
    if offset + 4 > len {
        return None;
    }
    let str_len = read_i32_le(raw, offset);
    if str_len <= 0 || str_len > 100 || offset + 4 + str_len as usize > len {
        return None;
    }
    let name = decode_ascii_replace(&raw[offset + 4..offset + 4 + str_len as usize]);
    if !py_is_alnum(&name.replace('_', "")) {
        return None;
    }
    let mut off2 = offset + 4 + str_len as usize;
    if !off2.is_multiple_of(4) {
        off2 += 4 - (off2 % 4);
    }
    if off2 + 24 > len {
        return None;
    }
    let r = read_f32_le(raw, off2);
    let g = read_f32_le(raw, off2 + 4);
    let b = read_f32_le(raw, off2 + 8);
    let a = read_f32_le(raw, off2 + 12);
    for value in [r, g, b, a] {
        if !(0.0..=1.0).contains(&value) {
            return None;
        }
    }
    let scale = |v: f32| -> i32 {
        let scaled = py_round(v as f64 * 255.0);
        (scaled as i32).clamp(0, 255)
    };
    Some(ColorEntry {
        name,
        rgb: (scale(r), scale(g), scale(b)),
        next: off2 + 24,
    })
}

/// Разобрать `ColorParserList` MonoBehaviour (`{имя: #RRGGBB}`).
///
/// Скан, не разбор по смещению: ищем 4-выровненный `int32 count`, затем
/// `count` записей `int32 len, char[len], pad, float[4]`.
pub fn parse_color_parser_list(raw: &[u8]) -> Option<Vec<(String, String)>> {
    let len = raw.len();
    if len < 25 {
        return None;
    }
    let mut off = 0usize;
    while off < len - 24 {
        let count = read_i32_le(raw, off);
        if count <= 0 || count > 50 {
            off += 4;
            continue;
        }
        let mut entries: Vec<(String, String)> = Vec::new();
        let mut ok = true;
        let mut cursor = off + 4;
        for _ in 0..count {
            let Some(entry) = read_color_entry(raw, cursor) else {
                ok = false;
                break;
            };
            let hex = format!(
                "#{}{}{}",
                hex2(entry.rgb.0),
                hex2(entry.rgb.1),
                hex2(entry.rgb.2)
            );
            match entries.iter_mut().find(|(name, _)| *name == entry.name) {
                Some(slot) => slot.1 = hex,
                None => entries.push((entry.name, hex)),
            }
            cursor = entry.next;
        }
        if ok && entries.len() == count as usize {
            return Some(entries);
        }
        off += 4;
    }
    None
}

// ---------------------------------------------------------------- Settings.* в raw

/// Пара «ключ настройки → подпись» из raw-байтов ассета.
#[derive(Debug, Clone, PartialEq)]
pub struct SettingKey {
    pub key: String,
    pub display: String,
}

const SETTINGS_MARKER: &[u8] = b"Settings.";

/// Найти пары `Settings.X` + UTF-8 подпись в сырых байтах файла.
pub fn scan_settings_keys(data: &[u8]) -> Vec<SettingKey> {
    let mut results: Vec<SettingKey> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut i = 0usize;
    while i < data.len() {
        let Some(pos) = index_of(data, SETTINGS_MARKER, i) else {
            break;
        };
        if pos < 4 {
            i = pos + 1;
            continue;
        }
        let key_len =
            u32::from_le_bytes([data[pos - 4], data[pos - 3], data[pos - 2], data[pos - 1]])
                as usize;
        if (9..=60).contains(&key_len) {
            let key = decode_ascii_replace(&data[pos..(pos + key_len).min(data.len())]);
            if key.starts_with("Settings.") && key.chars().count() > 9 {
                let mut after_key = pos + key_len;
                while after_key < data.len() && data[after_key] == 0 {
                    after_key += 1;
                }
                if after_key + 4 < data.len() {
                    let display_len = u32::from_le_bytes([
                        data[after_key],
                        data[after_key + 1],
                        data[after_key + 2],
                        data[after_key + 3],
                    ]) as usize;
                    if (1..=100).contains(&display_len) {
                        let start = after_key + 4;
                        let end = (start + display_len).min(data.len());
                        let display = String::from_utf8_lossy(&data[start..end]).into_owned();
                        if !display.is_empty() && !seen.contains(&key) {
                            seen.insert(key.clone());
                            results.push(SettingKey {
                                key,
                                display: py_slice(&display, MAX_STRING_LEN).to_string(),
                            });
                        }
                    }
                }
            }
        }
        i = pos + 1;
    }
    results
}

// ---------------------------------------------------------------- printable runs

/// Уникальные печатные ASCII-строки файла в порядке первого появления.
///
/// Это ФАКТ (что вообще напечатано в файле), а не решение «строка ли это UI»:
/// фильтр и приоритеты живут в TS (`isGlobalStringCandidate`/`uiPriority`).
pub fn scan_runs(data: &[u8]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < data.len() {
        if (32..=126).contains(&data[i]) {
            let start = i;
            while i < data.len() && (32..=126).contains(&data[i]) {
                i += 1;
            }
            let run = decode_ascii_replace(&data[start..i]);
            let stripped = py_strip(&run);
            if !seen.contains(stripped) {
                seen.insert(stripped.to_string());
                out.push(stripped.to_string());
            }
        } else {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_строки_порог_и_обрезка() {
        let mut raw = b"\x01ab\x01abcdef\x01a b\x01".to_vec();
        raw.extend_from_slice("x".repeat(600).as_bytes());
        let found = scan_raw_strings(&raw, 10);
        let texts: Vec<&str> = found.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["abcdef", "a b", "x".repeat(500).as_str()]);
        assert_eq!(found[0].offset, 14);
        assert_eq!(found[0].letters, 6);
    }

    #[test]
    fn json_строка_причуды_эталона() {
        // Текст: abc\nq\"z\u0041\q" — экранирования в байтах, закрывающая кавычка в конце.
        let data = b"abc\\nq\\\"z\\u0041\\q\"";
        let (text, end) = extract_json_string(data, 0);
        // `\n` — буква n, `\"` — кавычка, `\u0041` — A, `\q` — q.
        assert_eq!(text.unwrap(), "abcnq\"zAq");
        assert_eq!(end, data.len());
    }

    #[test]
    fn диалоги_и_rich_text() {
        let raw = br#"x{"Speaker":"Zoey","Text":"Hello <color=perversion>there</color>!"}"#;
        let found = parse_dialogue_from_raw(raw, 0);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].speaker, "Zoey");
        assert_eq!(found[0].text, "Hello there!");
        assert_eq!(found[0].rich_text, "Hello <color=perversion>there</color>!");
        assert_eq!(found[0].offset, 2);
    }

    #[test]
    fn суррогат_в_u_escape_пропускается() {
        // Как в эталоне: суррогат не кодируется, `\u` пропускается, а hex-цифры
        // остаются обычными символами (i += 2, а не i += 6).
        let (text, end) = extract_json_string(b"\\ud83d\\ude00x\"", 0);
        assert_eq!(text.unwrap(), "d83dde00x");
        assert_eq!(end, 14);
    }

    #[test]
    fn color_parser_list_разбирается() {
        // [count=2] [len=3]"Red" pad float4 [len=4]"Blue" pad float4
        let mut raw = Vec::new();
        raw.extend_from_slice(&2i32.to_le_bytes());
        for (name, rgb) in [("Red", [1.0f32, 0.0, 0.0]), ("Blue", [0.0, 0.0, 1.0])] {
            raw.extend_from_slice(&(name.len() as i32).to_le_bytes());
            raw.extend_from_slice(name.as_bytes());
            while raw.len() % 4 != 0 {
                raw.push(0);
            }
            for v in rgb {
                raw.extend_from_slice(&v.to_le_bytes());
            }
            raw.extend_from_slice(&1.0f32.to_le_bytes());
            raw.extend_from_slice(&[0u8; 8]); // запись = 24 байта (как в эталоне)
        }
        let colors = parse_color_parser_list(&raw).expect("список валиден");
        assert_eq!(
            colors,
            vec![
                ("Red".to_string(), "#FF0000".to_string()),
                ("Blue".to_string(), "#0000FF".to_string())
            ]
        );
    }

    #[test]
    fn color_parser_list_мусор_даёт_none() {
        assert!(parse_color_parser_list(&[0u8; 64]).is_none());
    }

    #[test]
    fn settings_keys_и_подписи() {
        let mut data = Vec::new();
        data.extend_from_slice(&[0xaa; 4]);
        let key = b"Settings.EnableVSync";
        data.extend_from_slice(&(key.len() as u32).to_le_bytes());
        data.extend_from_slice(key);
        data.push(0);
        let display = "Enable VSync".as_bytes();
        data.extend_from_slice(&(display.len() as u32).to_le_bytes());
        data.extend_from_slice(display);
        let found = scan_settings_keys(&data);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].key, "Settings.EnableVSync");
        assert_eq!(found[0].display, "Enable VSync");
    }

    #[test]
    fn runs_уникальны_и_обрезаны() {
        let raw = b"  abc  \x00abc\x00  ab  \x00def ghi";
        let runs = scan_runs(raw);
        assert_eq!(runs, vec!["abc", "ab", "def ghi"]);
    }

    #[test]
    fn python_strip_набор_пробелов() {
        assert_eq!(py_strip("\u{a0} hi \u{3000}"), "hi");
        assert_eq!(py_strip("\u{feff}hi"), "\u{feff}hi"); // BOM не пробел
    }
}
