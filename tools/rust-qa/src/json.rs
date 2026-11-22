//! json.rs — писатель JSON, совместимый с `JSON.stringify` побайтово.
//!
//! Паритет QA проверяется сравнением строк вывода TS и Rust, поэтому «почти
//! такой же JSON» не годится: набор эскейпов и порядок ключей обязаны совпасть.

/// Экранировать строку как `JSON.stringify` (без внешних кавычек).
///
/// `"` и `\` экранируются, управляющие `\b \t \n \f \r` — короткими формами,
/// остальные `< 0x20` — `\u00XX` (нижний регистр hex). Всё остальное, включая
/// не-ASCII, пишется как есть.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Строка в кавычках, готовая для вставки в JSON.
pub fn quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    out.push_str(&escape(s));
    out.push('"');
    out
}

/// Число так, как его печатает JS (`JSON.stringify`): целые — без `.0`,
/// конечные дроби — кратчайшее представление. Покрытие лежит в 0..100, где Rust
/// `Display` и JS дают одинаковые цифры.
pub fn number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// Массив строк `["a","b"]` (как `JSON.stringify(strings)`).
pub fn quoted_array(values: &[String]) -> String {
    let mut out = String::from("[");
    for (i, v) in values.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&quoted(v));
    }
    out.push(']');
    out
}
