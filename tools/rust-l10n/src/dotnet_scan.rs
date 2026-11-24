//! dotnet_scan.rs — сканер .NET-сборки (куча `#US`), порт
//! `.opencode/skills/dump-assets/scripts/dotnet.mts` (1:1).
//!
//! Из DLL берутся два потока строк: ключи `Settings.*` (подпись синтезируется
//! из имени ключа) и автономные UI-строки из кучи пользовательских строк.
//! Оба попадают в поле `settings_keys` дампа — потребитель не различает
//! «настоящую» настройку и UI-строку (это решение эталона, а не дефект).
//!
//! Строковые примитивы — Python-семантика (`str.strip()`/`isupper()`/`len()`),
//! ровно как в TS-зеркале `pystr.mts`: регистр и алфавитность берутся из
//! Unicode-свойств, длина — в code points, пробелы — Unicode White_Space плюс
//! `U+001C..U+001F`. Внешние модули крейта для этого не импортируются:
//! приватные хелперы живут здесь, чтобы правка соседа не меняла паритет.
//!
//! Битые данные не паникуют: чтения за границей буфера трактуются как в JS
//! (`undefined` не равен маркеру, `subarray` клампится), результаты — пустые.

use std::collections::HashSet;

/// Пара «ключ настройки → подпись» из кучи `#US` .NET-сборки.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingEntry {
    /// Имя ключа (`Settings.EnableVSync`) или сама UI-строка.
    pub key: String,
    /// Подпись (`Enable V Sync`); у UI-строки совпадает с ключом.
    pub display: String,
}

/// `Settings.` в UTF-16LE — маркер ключей внутри кучи (18 байт).
const SETTINGS_UTF16: [u8; 18] = [
    0x53, 0x00, 0x65, 0x00, 0x74, 0x00, 0x74, 0x00, 0x69, 0x00, 0x6e, 0x00, 0x67, 0x00, 0x73, 0x00,
    0x2e, 0x00,
];

/// Префикс ключей настроек.
const SETTINGS_PREFIX: &str = "Settings.";

/// Смещение `Settings.` в code units (JS `slice("Settings.".length)`).
const SETTINGS_PREFIX_UNITS: usize = 9;

/// Гласные, по которым `_ui_priority` узнаёт «слово-аббревиатуру».
const VOWELS: &str = "AEIOU";

// ---------------------------------------------------------------- строки (Python/JS)

/// Пробел Python (`str.isspace()`): Unicode White_Space + `U+001C..U+001F`.
fn py_is_space(c: char) -> bool {
    c.is_whitespace() || matches!(c, '\u{1c}'..='\u{1f}')
}

/// `str.strip()` без аргументов.
fn py_strip(s: &str) -> &str {
    s.trim_matches(py_is_space)
}

/// Длина в code points (Python `len`), не в UTF-16 units и не в байтах.
fn cp_len(s: &str) -> usize {
    s.chars().count()
}

/// Python-срез `s[:n]` — по code points.
fn cp_slice(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// JS `s.slice(start)` — по UTF-16 units (эталон режет именно так).
fn js_slice_utf16(s: &str, start: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().skip(start).collect();
    String::from_utf16_lossy(&units)
}

/// Python `ch.isupper()` (Unicode `Uppercase`).
fn py_is_upper_char(c: char) -> bool {
    c.is_uppercase()
}

/// Python `ch.islower()` (Unicode `Lowercase`).
fn py_is_lower_char(c: char) -> bool {
    c.is_lowercase()
}

/// Python `str.isupper()`: есть заглавные, строчных нет.
fn py_is_upper(s: &str) -> bool {
    let mut has_upper = false;
    for c in s.chars() {
        if py_is_lower_char(c) {
            return false;
        }
        if py_is_upper_char(c) {
            has_upper = true;
        }
    }
    has_upper
}

/// Python `str.islower()`: есть строчные, заглавных нет.
fn py_is_lower(s: &str) -> bool {
    let mut has_lower = false;
    for c in s.chars() {
        if py_is_upper_char(c) {
            return false;
        }
        if py_is_lower_char(c) {
            has_lower = true;
        }
    }
    has_lower
}

/// Python `\p{Nd}` — десятичные цифры любой письменности (не `Nl`/`No`).
///
/// Таблица снята с Node (`/\p{Nd}/u` по всем code points) — Rust std не
/// отдаёт Unicode-категорию напрямую, а `char::is_numeric()` шире (Nl/No),
/// что пропустило бы в ключ, например, `²`.
const ND_RANGES: &[(u32, u32)] = &[
    (0x30, 0x39),
    (0x660, 0x669),
    (0x6F0, 0x6F9),
    (0x7C0, 0x7C9),
    (0x966, 0x96F),
    (0x9E6, 0x9EF),
    (0xA66, 0xA6F),
    (0xAE6, 0xAEF),
    (0xB66, 0xB6F),
    (0xBE6, 0xBEF),
    (0xC66, 0xC6F),
    (0xCE6, 0xCEF),
    (0xD66, 0xD6F),
    (0xDE6, 0xDEF),
    (0xE50, 0xE59),
    (0xED0, 0xED9),
    (0xF20, 0xF29),
    (0x1040, 0x1049),
    (0x1090, 0x1099),
    (0x17E0, 0x17E9),
    (0x1810, 0x1819),
    (0x1946, 0x194F),
    (0x19D0, 0x19D9),
    (0x1A80, 0x1A89),
    (0x1A90, 0x1A99),
    (0x1B50, 0x1B59),
    (0x1BB0, 0x1BB9),
    (0x1C40, 0x1C49),
    (0x1C50, 0x1C59),
    (0xA620, 0xA629),
    (0xA8D0, 0xA8D9),
    (0xA900, 0xA909),
    (0xA9D0, 0xA9D9),
    (0xA9F0, 0xA9F9),
    (0xAA50, 0xAA59),
    (0xABF0, 0xABF9),
    (0xFF10, 0xFF19),
    (0x104A0, 0x104A9),
    (0x10D30, 0x10D39),
    (0x10D40, 0x10D49),
    (0x11066, 0x1106F),
    (0x110F0, 0x110F9),
    (0x11136, 0x1113F),
    (0x111D0, 0x111D9),
    (0x112F0, 0x112F9),
    (0x11450, 0x11459),
    (0x114D0, 0x114D9),
    (0x11650, 0x11659),
    (0x116C0, 0x116C9),
    (0x116D0, 0x116E3),
    (0x11730, 0x11739),
    (0x118E0, 0x118E9),
    (0x11950, 0x11959),
    (0x11BF0, 0x11BF9),
    (0x11C50, 0x11C59),
    (0x11D50, 0x11D59),
    (0x11DA0, 0x11DA9),
    (0x11DE0, 0x11DE9),
    (0x11F50, 0x11F59),
    (0x16130, 0x16139),
    (0x16A60, 0x16A69),
    (0x16AC0, 0x16AC9),
    (0x16B50, 0x16B59),
    (0x16D70, 0x16D79),
    (0x1CCF0, 0x1CCF9),
    (0x1D7CE, 0x1D7FF),
    (0x1E140, 0x1E149),
    (0x1E2F0, 0x1E2F9),
    (0x1E4F0, 0x1E4F9),
    (0x1E5F1, 0x1E5FA),
    (0x1E950, 0x1E959),
    (0x1FBF0, 0x1FBF9),
];

/// Десятичная цифра (`\p{Nd}`)?
fn is_nd(c: char) -> bool {
    if c.is_ascii_digit() {
        return true;
    }
    let cp = c as u32;
    ND_RANGES.iter().any(|&(lo, hi)| cp >= lo && cp <= hi)
}

/// `/[\p{Alphabetic}\p{Nd}._]/u` — допустимый хвост имени ключа.
fn is_alnum_or_dot_underscore(c: char) -> bool {
    c.is_alphabetic() || is_nd(c) || c == '.' || c == '_'
}

/// Декодировать UTF-16LE как `TextDecoder`: BOM снимается, непарный суррогат
/// и хвостовой нечётный байт дают `U+FFFD` (проверено на Node).
fn decode_utf16le(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let mut units: Vec<u16> = Vec::with_capacity(bytes.len() / 2 + 1);
    let mut chunks = bytes.chunks_exact(2);
    for chunk in &mut chunks {
        units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
    }
    if !chunks.remainder().is_empty() {
        units.push(0xFFFD);
    }
    if units.first() == Some(&0xFEFF) {
        units.remove(0);
    }
    String::from_utf16_lossy(&units)
}

/// `s.replace(/^\u0000+|\u0000+$/g, "")` — NUL по краям (как Python `strip("\x00")`).
fn strip_nul_ends(s: &str) -> &str {
    s.trim_matches('\0')
}

/// Кусок буфера с клампом границ (как `Uint8Array#subarray`).
fn slice_clamped(data: &[u8], start: usize, end: usize) -> &[u8] {
    let start = start.min(data.len());
    let end = end.clamp(start, data.len());
    &data[start..end]
}

// ---------------------------------------------------------------- куча #US

fn read_u32_le(data: &[u8], pos: usize) -> Option<u32> {
    let b = data.get(pos..pos.checked_add(4)?)?;
    Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

fn read_u16_le(data: &[u8], pos: usize) -> Option<u16> {
    let b = data.get(pos..pos.checked_add(2)?)?;
    Some(u16::from_le_bytes([b[0], b[1]]))
}

/// Найти кучу `#US`: `(offset, size)` или `None`.
///
/// Заголовок метаданных .NET: сигнатура `BSJB`, строка версии (длина u32 +
/// выравнивание до 4), флаги, число потоков, затем по потоку: `offset` (u32),
/// `size` (u32), имя с NUL и выравнивание.
pub fn find_dotnet_us_heap(data: &[u8]) -> Option<(usize, usize)> {
    if data.len() < 4 {
        return None;
    }
    let last_sig = data.len() - 4;
    let sig_offset = (0..=last_sig).find(|&i| &data[i..i + 4] == b"BSJB")?;

    let mut pos = sig_offset.saturating_add(12);
    if pos.saturating_add(4) > data.len() {
        return None;
    }
    let version_len = read_u32_le(data, pos)? as usize;
    pos = pos.saturating_add(4).saturating_add(version_len);
    if pos % 4 != 0 {
        pos += 4 - pos % 4;
    }
    if pos.saturating_add(4) > data.len() {
        return None;
    }
    let streams_count = read_u16_le(data, pos + 2)?;
    pos = pos.saturating_add(4);

    for _ in 0..streams_count {
        if pos.saturating_add(8) > data.len() {
            return None;
        }
        let stream_offset = read_u32_le(data, pos)? as usize;
        let stream_size = read_u32_le(data, pos + 4)? as usize;
        pos += 8;

        let mut name_end = pos;
        while name_end < data.len() && data[name_end] != 0 {
            name_end += 1;
        }
        if name_end >= data.len() {
            return None;
        }
        let name: String = data[pos..name_end]
            .iter()
            .map(|&b| if b <= 0x7f { b as char } else { '\u{fffd}' })
            .collect();
        pos = name_end + 1;
        if pos % 4 != 0 {
            pos += 4 - pos % 4;
        }
        if name == "#US" {
            return Some((sig_offset.saturating_add(stream_offset), stream_size));
        }
    }
    None
}

// ---------------------------------------------------------------- compressed int

/// Прочитать .NET compressed integer (1, 2 или 4 байта).
///
/// Возвращает `(значение, новый offset)`; `None` — как `[-1, offset]` в TS
/// (мусорный первый байт или обрыв данных).
pub fn read_compressed_int(data: &[u8], offset: usize) -> Option<(i32, usize)> {
    let b0 = *data.get(offset)?;
    if b0 < 0x80 {
        return Some((b0 as i32, offset + 1));
    }
    if b0 < 0xc0 {
        let b1 = *data.get(offset.checked_add(1)?)?;
        return Some(((((b0 as i32) & 0x3f) << 8) | b1 as i32, offset + 2));
    }
    if b0 < 0xe0 {
        let b = data.get(offset.checked_add(1)?..offset.checked_add(4)?)?;
        let value = (((b0 as i32) & 0x1f) << 24)
            | ((b[0] as i32) << 16)
            | ((b[1] as i32) << 8)
            | b[2] as i32;
        return Some((value, offset + 4));
    }
    None
}

// ---------------------------------------------------------------- Settings.*

/// `Settings.EnableVSync` → `Enable V Sync`; `Settings.X.Y` → `Y`.
///
/// Слова режет регулярка эталона `[A-Z][a-z]*|[A-Z]+(?=[A-Z][a-z])|[A-Z]+$|^[a-z]+|[0-9]+/g`.
/// Вторая и третья ветки недостижимы: в позиции заглавной буквы первая ветка
/// всегда даёт хотя бы один символ, а JS перебирает альтернативы по порядку
/// (`ABC` → `A B C`, проверено оракулом). `^` у `[a-z]+` — только начало
/// строки, поэтому `foo_bar` → `foo`.
pub fn key_to_display(key: &str) -> Option<String> {
    let suffix = js_slice_utf16(key, SETTINGS_PREFIX_UNITS);
    if suffix.is_empty() {
        return None;
    }
    if suffix.contains('.') {
        return Some(suffix.rsplit('.').next().unwrap_or("").to_string());
    }
    let words = key_words(&suffix);
    if words.is_empty() {
        return Some(suffix);
    }
    Some(words.join(" "))
}

/// Совпадения `[A-Z][a-z]*`, `^[a-z]+`, `[0-9]+` по порядку слева направо.
fn key_words(s: &str) -> Vec<&str> {
    let bytes = s.as_bytes();
    let mut out: Vec<&str> = Vec::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        let b = bytes[pos];
        if b.is_ascii_uppercase() {
            // `[A-Z][a-z]*`: одна заглавная плюс строчные за ней.
            let mut end = pos + 1;
            while end < bytes.len() && bytes[end].is_ascii_lowercase() {
                end += 1;
            }
            out.push(&s[pos..end]);
            pos = end;
        } else if pos == 0 && b.is_ascii_lowercase() {
            // `^[a-z]+` — только от начала строки.
            let mut end = pos + 1;
            while end < bytes.len() && bytes[end].is_ascii_lowercase() {
                end += 1;
            }
            out.push(&s[pos..end]);
            pos = end;
        } else if b.is_ascii_digit() {
            let mut end = pos + 1;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            out.push(&s[pos..end]);
            pos = end;
        } else {
            // Мультибайтовый символ не совпадает ни с одной веткой; шаг на байт
            // безопасен — совпадения состоят только из ASCII.
            pos += 1;
        }
    }
    out
}

/// Найти пару «ключ → подпись» в куче `#US` (подпись синтезируется из имени).
///
/// Куча ищется целиком в `data`; без сигнатуры `BSJB` сканируется весь буфер
/// (так работает эталон).
pub fn scan_dotnet_settings(data: &[u8]) -> Vec<SettingEntry> {
    let heap = find_dotnet_us_heap(data);
    let us_start = heap.map(|h| h.0).unwrap_or(0);
    let us_end = heap.map(|h| h.0.saturating_add(h.1)).unwrap_or(data.len());

    let mut results: Vec<SettingEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut i = us_start;

    // Последнее возможное начало маркера: он должен целиком влезть в кучу.
    let marker_last = us_end.min(data.len()).saturating_sub(SETTINGS_UTF16.len());
    let find_marker = |from: usize| -> Option<usize> {
        let mut p = from;
        while p <= marker_last {
            if data[p..p + SETTINGS_UTF16.len()] == SETTINGS_UTF16 {
                return Some(p);
            }
            p += 1;
        }
        None
    };

    while i < us_end.saturating_sub(SETTINGS_UTF16.len()) {
        let Some(pos) = find_marker(i) else { break };
        if pos >= us_end {
            break;
        }
        if pos == 0 {
            i = pos + 1;
            continue;
        }
        let key_start = pos - 1;
        let prefix = data[key_start];
        // Длина записи — compressed int ПЕРЕД строкой. Двухбайтовую ветку
        // эталон читает «задом наперёд»: старший байт берётся из байта перед
        // ключом. Для наших ключей (≤200 байт UTF-16) она недостижима, но
        // формула перенесена буквально.
        let total_bytes: i64 = if prefix < 0x80 {
            prefix as i64
        } else if prefix < 0xc0 && key_start >= 1 {
            (((prefix as i64) & 0x3f) << 8) | data[key_start - 1] as i64
        } else {
            i = pos + 1;
            continue;
        };
        let key_data_start = if prefix < 0x80 {
            key_start + 1
        } else {
            key_start + 2
        };
        let utf16_bytes = total_bytes - 1;
        if utf16_bytes < 10 || utf16_bytes > 200 || utf16_bytes % 2 != 0 {
            i = pos + 1;
            continue;
        }
        let key_data_end = key_data_start.saturating_add(utf16_bytes as usize);
        if key_data_end > data.len() {
            i = pos + 1;
            continue;
        }
        let key_text = decode_utf16le(&data[key_data_start..key_data_end]);
        let tail = js_slice_utf16(&key_text, SETTINGS_PREFIX_UNITS);
        if !key_text.starts_with(SETTINGS_PREFIX) || !tail.chars().all(is_alnum_or_dot_underscore) {
            i = pos + 1;
            continue;
        }
        if seen.contains(&key_text) {
            i = pos + 1;
            continue;
        }
        match key_to_display(&key_text) {
            None => {
                i = pos + SETTINGS_UTF16.len();
            }
            Some(display) => {
                results.push(SettingEntry {
                    key: key_text.clone(),
                    display: cp_slice(&display, 500),
                });
                seen.insert(key_text);
                i = pos + SETTINGS_UTF16.len();
            }
        }
    }
    results
}

// ---------------------------------------------------------------- UI-строки

/// Похоже ли на подпись UI (порт `_looks_like_display_text`).
pub fn looks_like_display_text(s: &str) -> bool {
    let length = cp_len(s);
    if s.is_empty() || length < 2 || length > 80 {
        return false;
    }
    if s.starts_with("Settings.") || s.starts_with("System.") {
        return false;
    }
    // Змеиный регистр — идентификатор, а не подпись (но «snake_case текст» — текст).
    if s.contains('_') && !s.contains(' ') {
        return false;
    }
    if s.chars().any(|c| "{}[]<>();=".contains(c)) {
        return false;
    }
    if py_is_lower(s) {
        return false;
    }
    if s.contains(' ') {
        return true;
    }
    if s.chars().any(py_is_upper_char) {
        return true;
    }
    py_is_upper(s) && VOWELS.chars().any(|v| s.contains(v))
}

/// Отбросить лимитом хвост, вернуть `(строки, сколько отброшено)`.
fn cap_strings(items: &mut Vec<String>, limit: Option<usize>) -> usize {
    let Some(limit) = limit else { return 0 };
    if items.len() <= limit {
        return 0;
    }
    let dropped = items.len() - limit;
    items.truncate(limit);
    dropped
}

/// Автономные UI-строки из кучи `#US` (структурный проход по префиксам длины).
///
/// `heap` — границы кучи, если она уже вырезана из сборки (декодер отдал
/// только её): тогда заголовок `BSJB` не ищется, а сканируется ровно диапазон.
///
/// `limit` — лимит строк на сборку (`None` — без лимита, как в эталоне по
/// умолчанию). Возвращает строки и число отброшенных лимитом (для отчёта
/// об обрезках: тихая обрезка была дефектом).
pub fn scan_dotnet_ui_strings(
    data: &[u8],
    heap: Option<(usize, usize)>,
    limit: Option<usize>,
) -> (Vec<String>, usize) {
    let Some((us_start, us_size)) = heap.or_else(|| find_dotnet_us_heap(data)) else {
        return (Vec::new(), 0);
    };
    let us_end = us_start.saturating_add(us_size);

    let mut results: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut i = us_start;

    while i < us_end.saturating_sub(2) {
        // За концом буфера каждое чтение в JS даёт `undefined` и цикл просто
        // дошагивает до `us_end`; прыжок вперёд даёт тот же результат.
        if i >= data.len() {
            break;
        }
        let b0 = data[i];
        if b0 == 0 {
            i += 1;
            continue;
        }
        let (total_bytes, prefix_size) = if b0 < 0x80 {
            (b0 as i64, 1usize)
        } else if b0 < 0xc0 {
            if i + 1 >= us_end {
                break;
            }
            let b1 = data.get(i + 1).copied().unwrap_or(0) as i64;
            ((((b0 as i64) & 0x3f) << 8) | b1, 2)
        } else {
            i += 1;
            continue;
        };
        let utf16_bytes = total_bytes - 1;
        if utf16_bytes < 2 || utf16_bytes > 300 || utf16_bytes % 2 != 0 {
            i += prefix_size;
            continue;
        }
        let data_start = i + prefix_size;
        let data_end = data_start + utf16_bytes as usize;
        if data_end + 1 > us_end {
            break;
        }
        // Терминатор записи: 0x00 или 0x01 (в #US последний байт — флаг).
        match data.get(data_end).copied() {
            Some(0x00) | Some(0x01) => {}
            _ => {
                i += prefix_size;
                continue;
            }
        }
        let raw = decode_utf16le(slice_clamped(data, data_start, data_end));
        let s = py_strip(strip_nul_ends(&raw)).to_string();
        i = data_end + 1;

        let length = cp_len(&s);
        if seen.contains(&s) || length < 3 || length > 80 {
            continue;
        }
        if !looks_like_display_text(&s) {
            continue;
        }
        if !s.contains(' ') && !s.contains('_') {
            // Одно слово оставляем только аббревиатурой/капсом с гласной
            // («SETTINGS»), иначе в UI попадут идентификаторы.
            let caps_vowel = py_is_upper(&s) && VOWELS.chars().any(|v| s.contains(v));
            if !(caps_vowel && (2..=20).contains(&length)) {
                continue;
            }
        }
        seen.insert(s.clone());
        results.push(s);
    }

    // Стабильная сортировка по «похожести на UI»: `sort(key=..., reverse=True)`.
    results.sort_by_key(|text| std::cmp::Reverse(dotnet_ui_priority(text)));
    let dropped = cap_strings(&mut results, limit);
    (results, dropped)
}

/// Порт `_ui_priority` (сортировка по «похожести на UI»).
pub fn dotnet_ui_priority(s: &str) -> i32 {
    if s.contains(' ') {
        // Путь — точно не подпись.
        if s.contains('/') || s.contains('\\') {
            return -10;
        }
        return 100;
    }
    if py_is_upper(s) {
        let has_vowel = VOWELS.chars().any(|v| s.contains(v));
        let length = cp_len(s);
        if has_vowel && !s.contains('_') && (2..=20).contains(&length) {
            return 80;
        }
    }
    let Some(first) = s.chars().next() else {
        return 0;
    };
    if py_is_upper_char(first) && s.chars().skip(1).any(py_is_lower_char) {
        return 50;
    }
    if s.starts_with('_') {
        return -50;
    }
    if py_is_lower_char(first) && s.chars().skip(1).any(py_is_upper_char) {
        return 20;
    }
    0
}

/// settings + UI-строки, которых нет среди display (ровно как `scanDotnetStrings`).
///
/// Возвращает пары и число UI-строк, отброшенных лимитом.
pub fn scan_dotnet_strings(
    data: &[u8],
    heap: Option<(usize, usize)>,
    ui_limit: Option<usize>,
) -> (Vec<SettingEntry>, usize) {
    let mut settings = scan_dotnet_settings(data);
    let (ui_strings, dropped) = scan_dotnet_ui_strings(data, heap, ui_limit);
    let displays: HashSet<String> = settings.iter().map(|item| item.display.clone()).collect();
    for text in ui_strings {
        if !displays.contains(&text) {
            settings.push(SettingEntry {
                key: text.clone(),
                display: text,
            });
        }
    }
    (settings, dropped)
}

// ---------------------------------------------------------------- тесты

#[cfg(test)]
mod tests {
    use super::*;

    // ---- сборка синтетических входов (как в оракуле на Node) ----

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    fn u16le_units(units: &[u16]) -> Vec<u8> {
        units.iter().flat_map(|u| u.to_le_bytes()).collect()
    }

    /// .NET compressed integer (для префиксов длины).
    fn cmp_int(n: usize) -> Vec<u8> {
        if n < 0x80 {
            vec![n as u8]
        } else if n < 0x4000 {
            vec![0x80 | (n >> 8) as u8, (n & 0xff) as u8]
        } else {
            vec![
                0xc0 | (n >> 24) as u8,
                (n >> 16) as u8,
                (n >> 8) as u8,
                n as u8,
            ]
        }
    }

    /// Запись `#US`: `[len+1][UTF-16LE][терминатор]`.
    fn us_entry(units: &[u16]) -> Vec<u8> {
        let bytes = u16le_units(units);
        let mut out = cmp_int(bytes.len() + 1);
        out.extend(bytes);
        out.push(0);
        out
    }

    fn us_payload(strings: &[&str]) -> Vec<u8> {
        strings.iter().flat_map(|s| us_entry(&units(s))).collect()
    }

    /// Ключи `Settings.*` с однобайтовым префиксом длины.
    fn settings_payload(keys: &[&str]) -> Vec<u8> {
        keys.iter().flat_map(|key| us_entry(&units(key))).collect()
    }

    /// Сборка с валидным заголовком метаданных и единственным потоком `#US`
    /// на абсолютном смещении 40.
    fn with_meta(payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 40];
        out[0..4].copy_from_slice(b"BSJB");
        out[12..16].copy_from_slice(&4u32.to_le_bytes()); // длина строки версии
        out[16..20].copy_from_slice(b"v4.0");
        out[22..24].copy_from_slice(&1u16.to_le_bytes()); // число потоков
        out[24..28].copy_from_slice(&40u32.to_le_bytes()); // смещение потока
        out[28..32].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        out[32..35].copy_from_slice(b"#US");
        out.extend_from_slice(payload);
        out
    }

    fn entry(key: &str, display: &str) -> SettingEntry {
        SettingEntry {
            key: key.to_string(),
            display: display.to_string(),
        }
    }

    // ---- оракул: `.opencode/skills/dump-assets/scripts/dotnet.mts` ----

    #[test]
    fn key_to_display_matches_oracle() {
        let cases: &[(&str, Option<&str>)] = &[
            ("Settings.EnableVSync", Some("Enable V Sync")),
            ("Settings.Audio.MasterVolume", Some("MasterVolume")),
            ("Settings.", None),
            ("Settings.UI", Some("U I")),
            ("Settings.X", Some("X")),
            ("NotASettings.Key", Some("Key")),
            ("Settings.MSFAAntialiasing", Some("M S F A Antialiasing")),
            ("Settings.2PlayerMode", Some("2 Player Mode")),
            ("Settings.fooBar", Some("foo Bar")),
            ("Settings.HTTPServerPort", Some("H T T P Server Port")),
            ("Settings.A1B2C3", Some("A 1 B 2 C 3")),
            ("Settings.ABC", Some("A B C")),
            ("Settings.ABc", Some("A Bc")),
            ("Settings.foo_bar", Some("foo")),
            ("Settings.X.Y.Z", Some("Z")),
            ("Settings.a1", Some("a 1")),
            ("Settings.A/B", Some("A B")),
        ];
        for &(key, expected) in cases {
            assert_eq!(
                key_to_display(key).as_deref(),
                expected,
                "key_to_display({key:?})"
            );
        }
    }

    #[test]
    fn looks_like_display_text_matches_oracle() {
        let cases: &[(&str, bool)] = &[
            ("New Game", true),
            ("Continue", true),
            ("Settings.EnableVSync", false),
            ("System.Memory", false),
            ("some_variable_name", false),
            ("restart()", false),
            ("ABC", true),
            ("Loading Screen", true),
            ("/path/to/file", false),
            ("12345", false),
            ("HELLO WORLD", true),
            ("Options", true),
            ("a", false),
            ("  Sprite  ", true),
        ];
        for &(text, expected) in cases {
            assert_eq!(
                looks_like_display_text(text),
                expected,
                "looks_like_display_text({text:?})"
            );
        }
    }

    #[test]
    fn read_compressed_int_matches_oracle() {
        let cases: &[(&[u8], Option<(i32, usize)>)] = &[
            (&[0x00], Some((0, 1))),
            (&[0x7f], Some((127, 1))),
            (&[0x80, 0x05], Some((5, 2))),
            (&[0xbf, 0xff], Some((16383, 2))),
            (&[0xc0, 0x00, 0x00, 0x01], Some((1, 4))),
            (&[0xdf, 0xff, 0xff, 0xff], Some((536_870_911, 4))),
            (&[0x80], None),
            (&[0xc0, 0x00], None),
            (&[0xe0], None),
            (&[], None),
        ];
        for &(bytes, expected) in cases {
            assert_eq!(read_compressed_int(bytes, 0), expected, "bytes {bytes:?}");
        }
        // Смещение внутри буфера и за концом.
        assert_eq!(read_compressed_int(&[0xff, 0x42], 1), Some((66, 2)));
        assert_eq!(read_compressed_int(&[0xff, 0x81, 0x02], 1), Some((258, 3)));
        assert_eq!(read_compressed_int(&[0x01], 3), None);
    }

    #[test]
    fn nd_table_matches_unicode_categories() {
        // Nd: арабские, математические жирные цифры, полноширинные.
        for c in ['0', '9', '\u{0660}', '\u{FF11}', '\u{1D7CE}', '\u{1D7FF}'] {
            assert!(is_nd(c), "{c:?} должно быть Nd");
        }
        // Nl (римская XII), No (½, ², ①) — НЕ Nd (в эталоне это не цифра).
        for c in ['\u{216B}', '\u{00BD}', '\u{00B2}', '\u{2460}', 'a', '.'] {
            assert!(!is_nd(c), "{c:?} не должно быть Nd");
        }
    }

    #[test]
    fn scan_dotnet_settings_matches_oracle() {
        let keys = [
            "Settings.EnableVSync",
            "Settings.Audio.MasterVolume",
            "Settings.UI",
            "Settings.EnableVSync", // дубликат
            "Settings.Bad-Key",     // дефис в хвосте недопустим
        ];
        let expected = vec![
            entry("Settings.EnableVSync", "Enable V Sync"),
            entry("Settings.Audio.MasterVolume", "MasterVolume"),
            entry("Settings.UI", "U I"),
        ];

        // Метаданные находятся: сканируется ровно куча #US.
        assert_eq!(
            scan_dotnet_settings(&with_meta(&settings_payload(&keys))),
            expected
        );
        // Без сигнатуры BSJB эталон сканирует весь буфер.
        assert_eq!(scan_dotnet_settings(&settings_payload(&keys)), expected);
        // UI-строка после ключей не превращается в настройку.
        let mixed = [settings_payload(&keys), us_payload(&["Continue"])].concat();
        assert_eq!(scan_dotnet_settings(&with_meta(&mixed)), expected);
        // Пустой/битый вход — пусто, без паники.
        assert!(scan_dotnet_settings(&[]).is_empty());
        assert!(scan_dotnet_settings(&[0x42, 0x53, 0x4a]).is_empty());
    }

    #[test]
    fn scan_dotnet_ui_strings_matches_oracle() {
        let ui = [
            "New Game",
            "Continue",
            "SETTINGS",
            "some_variable",
            "Save Game",
            "Load Game",
            "AB",
            "restart()",
            "Options",
            "New Game", // дубликат
            "Loading Screen",
            "Continue Game",
        ];
        let payload = us_payload(&ui);
        let dll = with_meta(&payload);
        let expected: Vec<String> = [
            "New Game",
            "Save Game",
            "Load Game",
            "Loading Screen",
            "Continue Game",
            "SETTINGS",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        // Без лимита и через заголовок сборки, и через готовый диапазон кучи.
        assert_eq!(
            scan_dotnet_ui_strings(&dll, None, None),
            (expected.clone(), 0)
        );
        assert_eq!(
            scan_dotnet_ui_strings(&payload, Some((0, payload.len())), None),
            (expected.clone(), 0)
        );
        // Лимит режет хвост и считает отброшенное.
        assert_eq!(
            scan_dotnet_ui_strings(&dll, None, Some(3)),
            (expected[..3].to_vec(), 3)
        );
        assert_eq!(
            scan_dotnet_ui_strings(&dll, None, Some(99)),
            (expected.clone(), 0)
        );
        assert_eq!(scan_dotnet_ui_strings(&dll, None, Some(0)), (Vec::new(), 6));
        // Кучи нет — пусто.
        assert_eq!(
            scan_dotnet_ui_strings(&[1, 2, 3], None, None),
            (Vec::new(), 0)
        );
    }

    #[test]
    fn scan_dotnet_ui_strings_unicode_edges() {
        // Длинная строка переключает префикс длины на двухбайтовый;
        // BOM снимается декодером; непарный суррогат → U+FFFD.
        let long = "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India J";
        let bom_units: Vec<u16> = std::iter::once(0xFEFF)
            .chain(units("Hello World"))
            .collect();
        let surrogate_units: Vec<u16> = std::iter::once(0xD800).chain(units("Game Over")).collect();
        let payload: Vec<u8> = [
            us_entry(&units("New Game")),
            us_entry(&units(long)),
            us_entry(&bom_units),
            us_entry(&surrogate_units),
            us_entry(&units("Save Game")),
        ]
        .concat();
        let expected: Vec<String> = [
            "New Game",
            long,
            "Hello World",
            "\u{fffd}Game Over",
            "Save Game",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            scan_dotnet_ui_strings(&with_meta(&payload), None, None),
            (expected, 0)
        );
    }

    #[test]
    fn scan_dotnet_strings_matches_oracle() {
        let mut keys = Vec::new();
        keys.extend(settings_payload(&[
            "Settings.EnableVSync",
            "Settings.Audio.MasterVolume",
        ]));
        keys.extend(us_payload(&["Enable V Sync", "New Game", "SETTINGS"]));
        let dll = with_meta(&keys);

        // «Enable V Sync» уже есть как display ключа — UI-строка не дублируется.
        let (all, dropped) = scan_dotnet_strings(&dll, None, None);
        assert_eq!(
            all,
            vec![
                entry("Settings.EnableVSync", "Enable V Sync"),
                entry("Settings.Audio.MasterVolume", "MasterVolume"),
                entry("New Game", "New Game"),
                entry("SETTINGS", "SETTINGS"),
            ]
        );
        assert_eq!(dropped, 0);

        // Лимит 1 оставляет только «Enable V Sync» — он уже есть среди display
        // ключей, поэтому в результат не добавляется; две UI-строки отброшены.
        let (capped, dropped) = scan_dotnet_strings(&dll, None, Some(1));
        assert_eq!(
            capped,
            vec![
                entry("Settings.EnableVSync", "Enable V Sync"),
                entry("Settings.Audio.MasterVolume", "MasterVolume"),
            ]
        );
        assert_eq!(dropped, 2);
    }

    #[test]
    fn broken_data_never_panics() {
        // Детерминированный LCG: битые/усечённые буферы не должны паниковать.
        let mut state: u64 = 0x1234_5678_9abc_def0;
        let mut next = || {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) as usize
        };
        for _ in 0..200 {
            let len = next() % 96;
            let data: Vec<u8> = (0..len).map(|_| (next() & 0xff) as u8).collect();
            let heap_start = next() % (data.len() + 1);
            let heap_size = next() % (data.len() + 1);
            let offset = next() % (data.len() + 4);

            let _ = read_compressed_int(&data, offset);
            let _ = find_dotnet_us_heap(&data);
            let _ = scan_dotnet_settings(&data);
            let _ = scan_dotnet_ui_strings(&data, None, Some(3));
            let _ = scan_dotnet_ui_strings(&data, Some((heap_start, heap_size)), None);
            let _ = scan_dotnet_ui_strings(&data, Some((0, usize::MAX)), Some(1));
            let _ = scan_dotnet_strings(&data, Some((heap_start, heap_size)), Some(2));
        }
    }

    #[test]
    fn dotnet_ui_priority_matches_oracle() {
        let cases: &[(&str, i32)] = &[
            ("New Game", 100),
            ("SETTINGS", 80),
            ("Continue", 50),
            ("_Hidden", -50),
            ("aBc", 20),
            ("path/to/x y", -10),
            ("Settings", 50),
            ("", 0),
            ("new game", 100),
            ("AB", 80),
            ("A1B2", 80),
            ("_x", -50),
            ("x_", 0),
            ("Hello", 50),
            ("hello", 0),
            ("HELLO", 80),
        ];
        for &(text, expected) in cases {
            assert_eq!(
                dotnet_ui_priority(text),
                expected,
                "dotnet_ui_priority({text:?})"
            );
        }
    }
}
