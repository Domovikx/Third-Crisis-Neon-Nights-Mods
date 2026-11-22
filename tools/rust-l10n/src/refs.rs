//! refs.rs — порядок `#:` ссылок записи PO (earliest-ref).
//!
//! Одно правило на два инструмента: `po2dat` выбирает победителя среди
//! переводов одного текста, `po_update` — среди дублей одного ключа. Правило
//! повторяет first-wins загрузчика C#: сначала legacy-файлы
//! `translations/...` (по имени), затем стабильные ссылки `[spk:...]`
//! (тоже по имени), иначе `~` (запись без ссылок — последняя).

use rust_l10n_core::po::PoEntry;

/// Ключ сортировки «earliest ref»: чем меньше строка, тем раньше запись.
pub fn ref_sort_key(e: &PoEntry) -> String {
    let mut files: Vec<&str> = e
        .refs
        .iter()
        .filter(|r| r.starts_with("translations/"))
        .map(String::as_str)
        .collect();
    files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut stable: Vec<&str> = e
        .refs
        .iter()
        .filter(|r| r.starts_with('['))
        .map(String::as_str)
        .collect();
    stable.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    files.extend(stable);
    files
        .first()
        .map(|s| (*s).to_string())
        .unwrap_or_else(|| "~".to_string())
}
