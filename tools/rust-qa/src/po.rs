//! po.rs — минимальный парсер PO/POT, побайтово совпадающий с TS-эталоном
//! (`.opencode/skills/extract-text/scripts/po_file.mts`, функция `parsePo`).
//!
//! Это НЕ полный gettext: поддерживается ровно то подмножество, которое пишут
//! наши генераторы и Poedit/Weblate. Поведение (регулярки, порядок веток,
//! когда запись «сбрасывается») переносится 1:1 — иначе паритет QA развалится
//! на краевых строках.

/// Запись PO. Поля повторяют `PoEntry` из TS.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PoEntry {
    pub msgid: String,
    pub msgctxt: String,
    pub msgstr: String,
    pub refs: Vec<String>,
    pub comments: Vec<String>,
    pub flags: Vec<String>,
    pub translator: Vec<String>,
}

/// Пробельный символ по JS-определению `\s` (и `trim()`).
///
/// Rust `char::is_whitespace` почти совпадает, но НЕ включает BOM (U+FEFF),
/// который JS считает пробелом, и включает U+0085, которого в JS `\s` нет.
pub fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Аналог `String.prototype.trim()` (JS-набор пробелов).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_ws)
}

/// Разбиение по `/\r\n|\r|\n/` (CRLF — ОДИН разделитель, не два).
fn js_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                out.push(&text[start..i]);
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    i += 1;
                }
                i += 1;
                start = i;
            }
            b'\n' => {
                out.push(&text[start..i]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    out.push(&text[start..]);
    out
}

/// Раскодировать PO-эскейпы (`\n`, `\r`, `\t`, `\"`, `\\`; прочее — «как есть»,
/// то есть `\a` → `a`, одиночный `\` в конце строки сохраняется).
pub fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Msgid,
    Msgctxt,
    Msgstr,
}

fn set_field(e: &mut PoEntry, f: Field, v: String) {
    match f {
        Field::Msgid => e.msgid = v,
        Field::Msgctxt => e.msgctxt = v,
        Field::Msgstr => e.msgstr = v,
    }
}

fn append_field(e: &mut PoEntry, f: Field, v: &str) {
    match f {
        Field::Msgid => e.msgid.push_str(v),
        Field::Msgctxt => e.msgctxt.push_str(v),
        Field::Msgstr => e.msgstr.push_str(v),
    }
}

/// `msgid`/`msgctxt`/`msgstr "..."` (регекс `^(msgid|msgctxt|msgstr)\s+"(.*)"$`).
///
/// `.*` в JS жадный, поэтому содержимое — всё между ПЕРВОЙ кавычкой после
/// ключевого слова и ПОСЛЕДНЕЙ кавычкой строки (внутренние кавычки допустимы).
fn msg_line(line: &str) -> Option<(Field, &str)> {
    let (field, kw_len) = if line.starts_with("msgid") {
        (Field::Msgid, 5)
    } else if line.starts_with("msgctxt") {
        (Field::Msgctxt, 7)
    } else if line.starts_with("msgstr") {
        (Field::Msgstr, 6)
    } else {
        return None;
    };
    let rest = &line[kw_len..];
    let ws_bytes = rest
        .char_indices()
        .take_while(|(_, c)| js_ws(*c))
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    if ws_bytes == 0 {
        return None;
    }
    let rest = &rest[ws_bytes..];
    if rest.len() < 2 || !rest.starts_with('"') || !rest.ends_with('"') {
        return None;
    }
    Some((field, &rest[1..rest.len() - 1]))
}

/// `"..."` — продолжение предыдущего поля (регекс `^"(.*)"$`).
fn cont_line(line: &str) -> Option<&str> {
    if line.len() >= 2 && line.starts_with('"') && line.ends_with('"') {
        Some(&line[1..line.len() - 1])
    } else {
        None
    }
}

/// Префикс `prefix` + один или более ПРОБЕЛОВ (регекс `^#: +(.+)$` и аналоги);
/// возвращает остаток строки (`.+` — минимум один символ).
fn prefixed<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(prefix)?;
    let spaces = rest.len() - rest.trim_start_matches(' ').len();
    if spaces == 0 {
        return None;
    }
    let rest = &rest[spaces..];
    if rest.is_empty() {
        None
    } else {
        Some(rest)
    }
}

/// Разобрать PO/POT в записи (порядок = порядок файла).
pub fn parse_po(text: &str) -> Vec<PoEntry> {
    let mut entries: Vec<PoEntry> = Vec::new();
    let mut cur: Option<PoEntry> = None;
    let mut field: Option<Field> = None;

    fn flush(cur: &mut Option<PoEntry>, entries: &mut Vec<PoEntry>) {
        if let Some(e) = cur.take() {
            if !(e.msgid.is_empty()
                && e.msgstr.is_empty()
                && e.msgctxt.is_empty()
                && e.refs.is_empty())
            {
                entries.push(e);
            }
        }
    }
    fn ensure(cur: &mut Option<PoEntry>) -> &mut PoEntry {
        if cur.is_none() {
            *cur = Some(PoEntry::default());
        }
        cur.as_mut().expect("запись создана")
    }

    for raw in js_lines(text) {
        let line = js_trim(raw);
        if line.is_empty() {
            flush(&mut cur, &mut entries);
            field = None;
            continue;
        }

        if let Some((f, value)) = msg_line(line) {
            field = Some(f);
            set_field(ensure(&mut cur), f, unescape(value));
            continue;
        }

        if let (Some(f), Some(_)) = (field, cur.as_ref()) {
            if let Some(content) = cont_line(line) {
                append_field(ensure(&mut cur), f, &unescape(content));
                continue;
            }
        }

        if let Some(rest) = prefixed(line, "#:") {
            // Одна ссылка на строку `#:` (пробелы внутри — часть ссылки).
            ensure(&mut cur).refs.push(js_trim(rest).to_string());
            field = None;
            continue;
        }

        if let Some(rest) = prefixed(line, "#,") {
            let names: Vec<String> = rest.split(',').map(|x| js_trim(x).to_string()).collect();
            ensure(&mut cur).flags.extend(names);
            field = None;
            continue;
        }

        if let Some(rest) = prefixed(line, "#.") {
            ensure(&mut cur).comments.push(rest.to_string());
            field = None;
            continue;
        }

        if let Some(rest) = prefixed(line, "#") {
            ensure(&mut cur).translator.push(rest.to_string());
            field = None;
            continue;
        }

        // Неизвестная строка: закрывает продолжение поля, иначе игнорируется.
        field = None;
    }

    flush(&mut cur, &mut entries);
    entries
}
