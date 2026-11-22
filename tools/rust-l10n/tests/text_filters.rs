//! Фильтры пайплайна: зеркало `text_filters.mts` (авто-триаж и rich-снятие).

use rust_l10n::text_filters::{
    is_asset_name, is_garbage_fragment, is_skip_prefix, strip_rich,
};

#[test]
fn имена_ассетов() {
    assert!(is_asset_name("NNHsvRenderer"));
    assert!(is_asset_name("EventSystem"));
    assert!(is_asset_name("Zone2"));
    assert!(is_asset_name("AMS_Foo"));
    assert!(!is_asset_name("Zone 2"));
    assert!(!is_asset_name("Ok"));
    assert!(!is_asset_name(""));
}

#[test]
fn бинарный_мусор() {
    assert!(is_garbage_fragment("Bff?D"));
    assert!(is_garbage_fragment("H\\?d"));
    assert!(is_garbage_fragment("%IR"));
    assert!(!is_garbage_fragment("Really?"));
    assert!(!is_garbage_fragment("?!"));
    assert!(!is_garbage_fragment("50%"));
    assert!(!is_garbage_fragment("50 %"));
    assert!(!is_garbage_fragment(""));
}

#[test]
fn префиксы_пропуска() {
    assert!(is_skip_prefix("line_0"));
    assert!(is_skip_prefix("expressions/seductive"));
    assert!(is_skip_prefix("Char_Foo"));
    assert!(!is_skip_prefix("Dialogue Log"));
}

#[test]
fn strip_rich_режет_теги_и_обрезает_пробелы() {
    assert_eq!(strip_rich("<b>Hi</b>"), "Hi");
    assert_eq!(strip_rich("  a <color=#fff>b</color>  "), "a b");
    assert_eq!(strip_rich("plain"), "plain");
    // `<>` — не тег (нужен хотя бы один символ между скобками).
    assert_eq!(strip_rich("a<>b"), "a<>b");
}
