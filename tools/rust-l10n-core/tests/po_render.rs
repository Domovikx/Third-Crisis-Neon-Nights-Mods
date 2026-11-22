//! Рендер PO/POT: поведение 1:1 с `renderPo`/`poEscape` из TS-эталона.

use rust_l10n_core::po::{escape_po, parse_po, render_po, PoEntry};

#[test]
fn экранирование_как_poescape() {
    assert_eq!(escape_po("a\\b\"c\rd\ne\tf"), "a\\\\b\\\"c\\rd\\ne\\tf");
    // Порядок замен не перетирает уже добавленные обратные слэши.
    assert_eq!(escape_po("\\n"), "\\\\n");
    assert_eq!(escape_po("привет"), "привет");
}

#[test]
fn рендер_шапки_и_записей() {
    let header = vec![
        "# header".to_string(),
        "msgid \"\"".to_string(),
        "msgstr \"\"".to_string(),
    ];
    let entries = vec![PoEntry {
        msgctxt: "speaker:Z".to_string(),
        msgid: "Hi".to_string(),
        comments: vec!["rich_text: <b>Hi</b>".to_string()],
        refs: vec!["translations/a.yaml".to_string()],
        translator: vec!["note".to_string()],
        flags: vec!["fuzzy".to_string(), String::new()],
        ..PoEntry::default()
    }];
    let text = render_po(&entries, &header);
    assert_eq!(
        text,
        "# header\nmsgid \"\"\nmsgstr \"\"\n\n\
         #: translations/a.yaml\n\
         #. rich_text: <b>Hi</b>\n\
         # note\n\
         #, fuzzy\n\
         msgctxt \"speaker:Z\"\n\
         msgid \"Hi\"\n\
         msgstr \"\"\n"
    );
}

#[test]
fn пустой_ввод_даёт_один_перевод_строки() {
    assert_eq!(render_po(&[], &[]), "\n");
}

#[test]
fn msgctxt_не_пишется_если_пуст_а_флаги_фильтруются() {
    let entries = vec![PoEntry {
        msgid: "x".to_string(),
        flags: vec![String::new()],
        ..PoEntry::default()
    }];
    let text = render_po(&entries, &[]);
    assert!(!text.contains("msgctxt"));
    assert!(!text.contains("#,"));
}

#[test]
fn parse_render_roundtrip() {
    let source = "\
msgid \"\"
msgstr \"Project-Id-Version: x\\n\"

#. rich_text: <color=#fff>x</color>
msgctxt \"speaker:Z\"
msgid \"a\\\"b\"
msgstr \"c\\\\d\"
";
    let entries = parse_po(source);
    let rendered = render_po(&entries, &[]);
    let again = parse_po(&rendered);
    assert_eq!(entries, again);
}
