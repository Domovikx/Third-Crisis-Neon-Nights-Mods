//! Парсер PO/POT: поведение 1:1 с `parsePo` из TS-эталона.

use rust_qa::po::{parse_po, unescape};

#[test]
fn простые_записи_и_порядок() {
    let text = "\
msgctxt \"speaker:Z\"
msgid \"Hi\"
msgstr \"Привет\"

msgctxt \"ui\"
msgid \"Ok\"
msgstr \"\"
";
    let entries = parse_po(text);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].msgctxt, "speaker:Z");
    assert_eq!(entries[0].msgid, "Hi");
    assert_eq!(entries[0].msgstr, "Привет");
    assert_eq!(entries[1].msgid, "Ok");
    assert!(entries[1].msgstr.is_empty());
}

#[test]
fn заголовок_каталога_разбирается_как_запись_с_пустым_msgid() {
    let text = "\
msgid \"\"
msgstr \"\"
\"Project-Id-Version: x\\n\"
";
    let entries = parse_po(text);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].msgid, "");
    assert_eq!(entries[0].msgstr, "Project-Id-Version: x\n");
}

#[test]
fn многострочные_поля_склеиваются() {
    let text = "\
msgid \"\"
\"first \"
\"second\"
msgstr \"\"
\"one\"
\"two\"
";
    let entries = parse_po(text);
    assert_eq!(entries[0].msgid, "first second");
    assert_eq!(entries[0].msgstr, "onetwo");
}

#[test]
fn эскейпы_и_неизвестные_последовательности() {
    assert_eq!(unescape(r#"a\nb\tc\"d\\e"#), "a\nb\tc\"d\\e");
    // Неизвестный эскейп теряет обратный слэш (`\a` -> `a`), конец строки — как есть.
    assert_eq!(unescape(r"\a\"), "a\\");
    assert_eq!(unescape(r"\\n"), "\\n");
}

#[test]
fn ссылки_флаги_комментарии_переводчик() {
    let text = "\
#: translations/dialogues/1.yaml [dlg:1#0]
#. triage: manual
# translator note
#, fuzzy, legacy
msgctxt \"speaker:Z\"
msgid \"Hi\"
msgstr \"\"
";
    let entries = parse_po(text);
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.refs, vec!["translations/dialogues/1.yaml [dlg:1#0]"]);
    assert_eq!(e.comments, vec!["triage: manual"]);
    assert_eq!(e.translator, vec!["translator note"]);
    assert_eq!(e.flags, vec!["fuzzy", "legacy"]);
}

#[test]
fn crlf_не_плодит_пустых_записей() {
    let text = "msgid \"a\"\r\nmsgstr \"b\"\r\n\r\nmsgid \"c\"\r\nmsgstr \"d\"\r\n";
    let entries = parse_po(text);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].msgid, "c");
}

#[test]
fn неизвестная_строка_закрывает_продолжение() {
    let text = "\
msgid \"a\"
garbage
\"b\"
msgstr \"x\"
";
    let entries = parse_po(text);
    assert_eq!(entries[0].msgid, "a");
    assert_eq!(entries[0].msgstr, "x");
}

#[test]
fn пустой_файл_и_мусор() {
    assert!(parse_po("").is_empty());
    assert!(parse_po("\n\n\r\n").is_empty());
    assert!(parse_po("garbage\n").is_empty());
}

#[test]
fn запись_без_полей_но_со_ссылкой_сохраняется() {
    let entries = parse_po("#: [dlg:1#0]\n\n");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].refs.len(), 1);
}

#[test]
fn внутренние_кавычки_берутся_до_последней() {
    // `.*` в TS жадный: содержимое — между первой и последней кавычкой.
    let entries = parse_po("msgid \"a\\\"b\"\n");
    assert_eq!(entries[0].msgid, "a\"b");
}
