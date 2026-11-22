//! Синтетические фикстуры: по одному случаю на каждый класс реестра.
//!
//! Файлы игры в git не кладём — все входы собраны строками здесь. Тест
//! `every_registered_class_has_a_fixture` падает, если появился класс без
//! фикстуры, поэтому «проверено тестом» нельзя забыть.

use std::collections::HashSet;

use rust_lint::audit::{audit_pot, audit_strings, Calibration, LangAudit};
use rust_lint::classes::CLASSES;

fn pot(body: &str) -> String {
    format!("# header\nmsgid \"\"\nmsgstr \"Project-Id-Version: test\\n\"\n\n{body}")
}

fn entry(ctxt: &str, id: &str, tr: &str) -> String {
    format!("msgctxt \"{ctxt}\"\nmsgid \"{id}\"\nmsgstr \"{tr}\"\n\n")
}

fn dat(lines: &[&str]) -> String {
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

struct Case {
    class: &'static str,
    lang: &'static str,
    pot: String,
    po: String,
    dat: Option<String>,
}

fn case(
    class: &'static str,
    lang: &'static str,
    pot_text: String,
    po_text: String,
    dat_text: Option<String>,
) -> Case {
    Case {
        class,
        lang,
        pot: pot_text,
        po: po_text,
        dat: dat_text,
    }
}

#[allow(clippy::too_many_lines)]
fn cases() -> Vec<Case> {
    let a = entry("ui", "Hello", "");
    let a_ru = entry("ui", "Hello", "Привет");
    let a_with_rich = format!("#. rich_text: <i>Hello</i>\n{a}");
    vec![
        case(
            "pot.duplicate-key",
            "ru",
            pot(&format!("{a}{a}")),
            a_ru.clone(),
            None,
        ),
        case(
            "po.duplicate-key-diff",
            "ru",
            pot(&a),
            format!(
                "{}{}",
                entry("ui", "Hello", "Один"),
                entry("ui", "Hello", "Два")
            ),
            None,
        ),
        case(
            "po.duplicate-key-same",
            "ru",
            pot(&a),
            format!(
                "{}{}",
                entry("ui", "Hello", "Один"),
                entry("ui", "Hello", "Один")
            ),
            None,
        ),
        case(
            "po.empty-msgid",
            "ru",
            pot(&a),
            format!(
                "msgid \"\"\nmsgstr \"Project-Id-Version: test\\n\"\n\n{}",
                "msgctxt \"ui\"\nmsgid \"\"\nmsgstr \"x\"\n"
            ),
            None,
        ),
        case(
            "po.malformed-field",
            "ru",
            pot(&a),
            "msgid \"unterminated\n".to_string(),
            None,
        ),
        case(
            "po.orphan-text",
            "ru",
            pot(&a),
            entry("ui", "Missing", "Есть"),
            None,
        ),
        case(
            "po.orphan-context",
            "ru",
            pot(&a),
            entry("speaker:X", "Hello", "Привет"),
            None,
        ),
        case(
            "po.missing-key",
            "ru",
            pot(&format!("{a}{}", entry("ui", "Second", ""))),
            a_ru.clone(),
            None,
        ),
        case(
            "po.copy-through",
            "ru",
            pot(&entry("ui", "New Game", "")),
            entry("ui", "New Game", "New Game"),
            None,
        ),
        case(
            "po.copy-through-noise",
            "ru",
            pot(&entry("ui", "NNHsvRenderer", "")),
            entry("ui", "NNHsvRenderer", "NNHsvRenderer"),
            None,
        ),
        case(
            "po.key-drift",
            "ru",
            pot(&a),
            entry("ui", "Hello ", "Привет"),
            None,
        ),
        case(
            "po.escape.double",
            "ru",
            pot(&a),
            r#"msgctxt "ui"
msgid "Hello"
msgstr "Hello\\nworld"
"#
            .to_string(),
            None,
        ),
        case(
            "po.escape.backslash",
            "ru",
            pot(&a),
            r#"msgctxt "ui"
msgid "Hello"
msgstr "C:\\zig"
"#
            .to_string(),
            None,
        ),
        case(
            "po.escape.unknown",
            "ru",
            pot(&a),
            "msgctxt \"ui\"\nmsgid \"Hello\"\nmsgstr \"bad \\q\"\n".to_string(),
            None,
        ),
        case(
            "po.encoding.zero-width",
            "ru",
            pot(&a),
            entry("ui", "Hello", "При\u{200b}вет"),
            None,
        ),
        case(
            "po.encoding.nbsp",
            "ru",
            pot(&a),
            entry("ui", "Hello", "При\u{00a0}вет"),
            None,
        ),
        case(
            "po.encoding.mixed-alpha",
            "ru",
            pot(&a),
            entry("ui", "Hello", "cлово"),
            None,
        ),
        case(
            "po.encoding.mojibake",
            "ru",
            pot(&a),
            entry("ui", "Hello", "ÐŸÑ€Ð¸Ð²ÐµÑ‚"),
            None,
        ),
        case(
            "po.encoding.typographic",
            "de",
            pot(&a),
            entry("ui", "Hello", "don’t"),
            None,
        ),
        case(
            "po.tag.balance",
            "ru",
            pot(&a),
            entry("ui", "Hello", "</b>"),
            None,
        ),
        case(
            "po.tag.nesting",
            "ru",
            pot(&a),
            entry("ui", "Hello", "<b><i>x</b></i>"),
            None,
        ),
        case(
            "po.tag.missing",
            "ru",
            pot(&entry("ui", "<b>Hello</b>", "")),
            entry("ui", "<b>Hello</b>", "Привет"),
            None,
        ),
        case(
            "po.tag.extra",
            "ru",
            pot(&a),
            entry("ui", "Hello", "<b>Привет</b>"),
            None,
        ),
        case(
            "po.tag.unclosed",
            "ru",
            pot(&a),
            entry("ui", "Hello", "<i>Привет"),
            None,
        ),
        case(
            "po.anchor.numbers",
            "ru",
            pot(&entry("ui", "You have 3 apples", "")),
            entry("ui", "You have 3 apples", "У тебя 4 яблока"),
            None,
        ),
        case(
            "po.anchor.line-ids",
            "ru",
            pot(&entry("ui", "66-Your loss 1", "")),
            entry("ui", "66-Your loss 1", "67-Твоя потеря 1"),
            None,
        ),
        case(
            "po.anchor.placeholders",
            "ru",
            pot(&entry("ui", "Hello {0}", "")),
            entry("ui", "Hello {0}", "Привет"),
            None,
        ),
        case(
            "po.anchor.empty",
            "ru",
            pot(&a),
            entry("ui", "Hello", ""),
            None,
        ),
        case(
            "po.anchor.single-char",
            "ru",
            pot(&a),
            entry("ui", "Hello", "X"),
            None,
        ),
        case(
            "po.anchor.truncated",
            "ru",
            pot(&entry("ui", "This is a long sentence.", "")),
            entry("ui", "This is a long sentence.", "Это длинное предложение"),
            None,
        ),
        case("dat.missing-file", "ru", pot(&a), a_ru.clone(), None),
        case(
            "dat.parse-error",
            "ru",
            pot(&a),
            entry("ui", "Hello", ""),
            Some("{bad\n".to_string()),
        ),
        case(
            "dat.duplicate-key",
            "ru",
            pot(&a),
            a_ru.clone(),
            Some(dat(&[
                r#"{"t":"Hello","x":"Привет"}"#,
                r#"{"t":"Hello","x":"Привет"}"#,
            ])),
        ),
        case(
            "dat.unknown-field",
            "ru",
            pot(&a),
            a_ru.clone(),
            Some(dat(&[r#"{"t":"Hello","x":"Привет","zz":1}"#])),
        ),
        case(
            "dat.not-in-pot",
            "ru",
            pot(&a),
            entry("ui", "Hello", ""),
            Some(dat(&[r#"{"t":"Ghost","x":"Призрак"}"#])),
        ),
        case(
            "dat.not-in-po",
            "ru",
            pot(&format!("{a}{}", entry("ui", "Second", ""))),
            entry("ui", "Hello", ""),
            Some(dat(&[
                r#"{"t":"Hello","x":""}"#,
                r#"{"t":"Second","x":"Второй"}"#,
            ])),
        ),
        case(
            "dat.lost-translation",
            "ru",
            pot(&a),
            a_ru.clone(),
            Some(dat(&[r#"{"t":"Hello","x":""}"#])),
        ),
        case(
            "dat.invented",
            "ru",
            pot(&a),
            entry("ui", "Hello", ""),
            Some(dat(&[r#"{"t":"Hello","x":"Привет"}"#])),
        ),
        case(
            "dat.mismatch",
            "ru",
            pot(&a),
            a_ru.clone(),
            Some(dat(&[r#"{"t":"Hello","x":"Другой"}"#])),
        ),
        case(
            "dat.copy-through",
            "ru",
            pot(&entry("ui", "New Game", "")),
            entry("ui", "New Game", "New Game"),
            Some(dat(&[r#"{"t":"New Game","x":"New Game"}"#])),
        ),
        case(
            "dat.copy-through-noise",
            "ru",
            pot(&entry("ui", "NNHsvRenderer", "")),
            entry("ui", "NNHsvRenderer", "NNHsvRenderer"),
            Some(dat(&[r#"{"t":"NNHsvRenderer","x":"NNHsvRenderer"}"#])),
        ),
        case(
            "dat.collapse",
            "ru",
            pot(&format!(
                "{}{}",
                entry("speaker:A", "Hello", ""),
                entry("speaker:B", "Hello", "")
            )),
            format!(
                "{}{}",
                entry("speaker:A", "Hello", "Один"),
                entry("speaker:B", "Hello", "Два")
            ),
            Some(dat(&[r#"{"t":"Hello","x":"Один"}"#])),
        ),
        case(
            "dat.rich-lost",
            "ru",
            pot(&a_with_rich),
            a_ru.clone(),
            Some(dat(&[r#"{"t":"Hello","x":"Привет"}"#])),
        ),
        case(
            "dat.rich-mismatch",
            "ru",
            pot(&a_with_rich),
            a_ru.clone(),
            Some(dat(&[r#"{"t":"Hello","x":"Привет","r":"<b>Hello</b>"}"#])),
        ),
        case(
            "dat.rich-extra",
            "ru",
            pot(&a),
            a_ru.clone(),
            Some(dat(&[r#"{"t":"Hello","x":"Привет","r":"<i>Hello</i>"}"#])),
        ),
        case(
            "dat.rt-mismatch",
            "ru",
            pot(&a_with_rich),
            format!("# rich: <i>Привет</i>\n{}", entry("ui", "Hello", "Привет")),
            Some(dat(&[
                r#"{"t":"Hello","x":"Привет","r":"<i>Hello</i>","rt":"<b>Привет</b>"}"#,
            ])),
        ),
        case(
            "dat.rt-tags",
            "ru",
            pot(&a_with_rich),
            a_ru.clone(),
            Some(dat(&[
                r#"{"t":"Hello","x":"Привет","r":"<i>Hello</i>","rt":"<b>Привет</b>"}"#,
            ])),
        ),
        case(
            "dat.rt-balance",
            "ru",
            pot(&a_with_rich),
            a_ru.clone(),
            Some(dat(&[
                r#"{"t":"Hello","x":"Привет","r":"<i>Hello</i>","rt":"<i>Привет</i></b>"}"#,
            ])),
        ),
        case(
            "dat.rt-unclosed",
            "ru",
            pot(&a_with_rich),
            a_ru.clone(),
            Some(dat(&[
                r#"{"t":"Hello","x":"Привет","r":"<i>Hello</i>","rt":"<i>Привет"}"#,
            ])),
        ),
        case(
            "pot.noise",
            "ru",
            pot(&format!(
                "{}{}",
                entry("ui", "NNHsvRenderer", ""),
                entry("ui", "Bff?D", "")
            )),
            String::new(),
            None,
        ),
    ]
}

fn run(case: &Case) -> LangAudit {
    if case.class.starts_with("pot.") {
        let pot_audit = audit_pot(&case.pot);
        return LangAudit {
            lang: case.lang.to_string(),
            pot_entries: pot_audit.entries,
            po_entries: 0,
            po_filled: 0,
            dat_rows: 0,
            classes: pot_audit.classes,
            calibration: pot_audit.calibration,
        };
    }
    audit_strings(case.lang, &case.pot, &case.po, case.dat.as_deref())
}

#[test]
fn every_case_finds_its_class() {
    let mut failures = Vec::new();
    for case in cases() {
        let audit = run(&case);
        if audit.count(case.class) == 0 {
            failures.push(format!(
                "{}: класс не найден (lang={}, po={:?})",
                case.class,
                case.lang,
                case.po.chars().take(80).collect::<String>()
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_registered_class_has_a_fixture() {
    let covered: HashSet<&str> = cases().iter().map(|c| c.class).collect();
    let missing: Vec<&str> = CLASSES
        .iter()
        .map(|c| c.id)
        .filter(|id| !covered.contains(id))
        .collect();
    assert!(missing.is_empty(), "нет фикстур для классов: {missing:?}");
}

#[test]
fn noise_strings_do_not_trigger_semantic_classes() {
    let pot_text = pot(&format!(
        "{}{}",
        entry("ui", "!!Y-, E", ""),
        entry("ui", "\" & 9 D t", "")
    ));
    let po_text = format!(
        "{}{}",
        entry("ui", "!!Y-, E", "!!Y-, E"),
        entry("ui", "\" & 9 D t", "\\\\")
    );
    let audit = audit_strings("ru", &pot_text, &po_text, None);
    for id in [
        "po.escape.backslash",
        "po.anchor.numbers",
        "po.anchor.single-char",
        "po.anchor.line-ids",
        "po.anchor.placeholders",
    ] {
        assert_eq!(audit.count(id), 0, "{id} не должен срабатывать на шуме");
    }
    assert!(audit.count("po.copy-through-noise") > 0);
}

#[test]
fn calibration_font_tags_are_not_imbalance() {
    // r и rt отличаются только <font> — это известные 48 ложных срабатываний.
    let pot_text = pot(&a_entry_with_rich());
    let po_text = entry("ui", "Hello", "Привет");
    let dat_text = dat(&[
        r#"{"t":"Hello","x":"Привет","r":"<i>Hello</i>","rt":"<i><font=\"X\">Привет</font></i>"}"#,
    ]);
    let audit = audit_strings("ru", &pot_text, &po_text, Some(&dat_text));
    let cal: &Calibration = &audit.calibration;
    assert_eq!(cal.dat_font_only_rows, 1);
    assert_eq!(cal.dat_filtered_tag_rows, 0);
    assert_eq!(audit.count("dat.rt-tags"), 0);
}

fn a_entry_with_rich() -> String {
    format!("#. rich_text: <i>Hello</i>\n{}", entry("ui", "Hello", ""))
}
