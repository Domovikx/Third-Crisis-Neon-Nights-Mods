//! Правила QA на маленьких фикстурах: каждое правило, границы, дубликаты,
//! не-ASCII и фильтр `<font>`/`<material>`.

mod common;

use std::fs;

use common::Fixture;
use rust_qa::dat::load_dat;
use rust_qa::rules::{check, cyr_ratio, sourcedir_of, speaker_of, Finding, Level, Report};

fn rules(report: &Report) -> Vec<&str> {
    report.findings.iter().map(|f| f.rule).collect()
}

fn texts<'a>(report: &'a Report, rule: &str) -> Vec<&'a str> {
    report
        .findings
        .iter()
        .filter(|f| f.rule == rule)
        .map(|f| f.text.as_str())
        .collect()
}

fn errors(findings: &[Finding]) -> usize {
    findings.iter().filter(|f| f.level == Level::Error).count()
}

/// POT из трёх диалоговых строк и одной ui.
const POT_THREE: &str = "\
#: translations/dialogues/1.yaml [dlg:1#0]
msgctxt \"speaker:Z\"
msgid \"Hi\"
msgstr \"\"

#: translations/dialogues/1.yaml [dlg:1#1]
msgctxt \"speaker:Z\"
msgid \"Bye\"
msgstr \"\"

#: translations/raw/a.yaml [raw:a#0]
msgctxt \"ui\"
msgid \"Ok\"
msgstr \"\"
";

#[test]
fn copy_through_в_диалоге_и_исключение_legacy() {
    let fx = Fixture::new("copy").pot(POT_THREE).dat(
        "ru",
        &[
            r#"{"t":"Hi","x":"Привет","r":"<b>Hi</b>","rt":"<b>Привет</b>"}"#,
            r#"{"t":"Bye","x":"Bye"}"#,
            r#"{"t":"Ok","x":"Ok","sk":true}"#,
        ]
        .join("\n"),
    );
    let report = check("ru", &fx.root).expect("QA");
    assert_eq!(report.summary.total, 3);
    assert_eq!(
        report.summary.filled, 3,
        "legacy тоже считается заполненным"
    );
    assert_eq!(texts(&report, "copy-through"), vec!["Bye"]);
    assert!(texts(&report, "empty-dialogue").is_empty());
    assert_eq!(report.summary.by_dir.len(), 2);
    assert_eq!(
        report
            .summary
            .by_dir
            .iter()
            .find(|(k, _)| k == "dialogues")
            .map(|(_, s)| s.total),
        Some(2)
    );
    assert_eq!(
        report
            .summary
            .by_speaker
            .iter()
            .find(|(k, _)| k == "Z")
            .map(|(_, s)| s.total),
        Some(2)
    );
}

#[test]
fn пустой_перевод_в_диалоге_но_не_в_ui() {
    let fx = Fixture::new("empty")
        .pot(
            "\
#: [dlg:1#0]
msgctxt \"speaker:Z\"
msgid \"Hi\"
msgstr \"\"

#: [raw:a#0]
msgctxt \"ui\"
msgid \"Ok\"
msgstr \"\"
",
        )
        .dat("ru", "");
    let report = check("ru", &fx.root).expect("QA");
    assert_eq!(report.summary.filled, 0);
    assert_eq!(texts(&report, "empty-dialogue"), vec!["Hi"]);
    assert_eq!(report.summary.errors, 1);
    assert_eq!(report.summary.coverage, 0.0);
}

#[test]
fn no_translate_исключает_строку() {
    let fx = Fixture::new("notranslate")
        .pot(
            "\
#: [dlg:1#0]
#. triage: manual
#, no-translate
msgctxt \"speaker:Z\"
msgid \"...!\"
msgstr \"\"
",
        )
        .dat("ru", "");
    let report = check("ru", &fx.root).expect("QA");
    assert_eq!(report.summary.errors, 0);
    assert!(report.findings.is_empty());
}

#[test]
fn дисбаланс_тегов_сравнивает_имена_и_фильтрует_font_material() {
    let fx = Fixture::new("tags")
        .pot(
            "\
#: [dlg:1#0]
msgctxt \"speaker:Z\"
msgid \"Ok\"
msgstr \"\"

#: [dlg:1#1]
msgctxt \"speaker:Z\"
msgid \"Fine\"
msgstr \"\"
",
        )
        .dat(
            "ru",
            &[
                r##"{"t":"Ok","x":"Ладно","r":"<color=#fff>Ok</color>","rt":"<color=#fff>Ладно</color>"}"##,
                r#"{"t":"Fine","x":"Хорошо","r":"<b>Fine</b>","rt":"<b>Хорошо"}"#,
            ]
            .join("\n"),
        );
    let report = check("ru", &fx.root).expect("QA");
    assert_eq!(texts(&report, "tag-imbalance"), vec!["Fine"]);
    assert_eq!(
        report.findings[0].detail, "<b>,</b> vs <b>",
        "детали как Array.join(',')"
    );
}

#[test]
fn font_и_material_не_считаются_дисбалансом() {
    let fx = Fixture::new("tags-font")
        .pot("msgctxt \"speaker:Z\"\nmsgid \"Hi\"\nmsgstr \"\"\n")
        .dat(
            "ru",
            r#"{"t":"Hi","x":"Привет","r":"<i><color=#B867FF>Hi</color></i>","rt":"<i><color=#B867FF><font=\"Roboto-Condensed\" material=\"Perversion\">Привет</font></color></i>"}"#,
        );
    let report = check("ru", &fx.root).expect("QA");
    assert!(texts(&report, "tag-imbalance").is_empty());
}

#[test]
fn латиница_в_ru_порог_длины_и_доля_кириллицы() {
    let fx = Fixture::new("latin")
        .pot(
            "\
#: [dlg:1#0]
msgctxt \"speaker:Z\"
msgid \"Long\"
msgstr \"\"

#: [dlg:1#1]
msgctxt \"speaker:Z\"
msgid \"Short\"
msgstr \"\"

#: [dlg:1#2]
msgctxt \"speaker:Z\"
msgid \"Mixed\"
msgstr \"\"

#: [dlg:1#3]
msgctxt \"speaker:Z\"
msgid \"Ratio\"
msgstr \"\"
",
        )
        .dat(
            "ru",
            &[
                r#"{"t":"Long","x":"Hello darkness my old friend"}"#,
                r#"{"t":"Short","x":"Hello"}"#,
                r#"{"t":"Mixed","x":"Привет мир"}"#,
                // 2 кириллические буквы из 14 = 0.14 < 0.3 -> флаг
                r#"{"t":"Ratio","x":"Пр abcdefghijkl"}"#,
            ]
            .join("\n"),
        );
    let report = check("ru", &fx.root).expect("QA");
    assert_eq!(texts(&report, "latin-leftover"), vec!["Long", "Ratio"]);
    assert_eq!(report.summary.warnings, 2);
    // de не проверяет латиницу (проверка привязана к письменности).
    let de = check("de", &fx.root).expect("QA");
    assert_eq!(de.summary.warnings, 0);
}

#[test]
fn латиница_ровно_порог_длины_и_доли() {
    let fx = Fixture::new("latin-boundary")
        .pot(
            "\
#: [dlg:1#0]
msgctxt \"speaker:Z\"
msgid \"Ten\"
msgstr \"\"

#: [dlg:1#1]
msgctxt \"speaker:Z\"
msgid \"Eleven\"
msgstr \"\"

#: [dlg:1#2]
msgctxt \"speaker:Z\"
msgid \"Thirty\"
msgstr \"\"
",
        )
        .dat(
            "ru",
            &[
                // ровно 10 символов: `[...tr].length > 10` — не флаг
                r#"{"t":"Ten","x":"Abcdefghij"}"#,
                // 11 символов, латиница — флаг
                r#"{"t":"Eleven","x":"Abcdefghijk"}"#,
                // доля ровно 0.3 (3 из 10 букв) -> `< 0.3` ложно — не флаг
                r#"{"t":"Thirty","x":"аааbcdefgh "}"#,
            ]
            .join("\n"),
        );
    let report = check("ru", &fx.root).expect("QA");
    assert_eq!(texts(&report, "latin-leftover"), vec!["Eleven"]);
}

#[test]
fn дубли_в_po_сортируются_и_детали_в_json() {
    let fx = Fixture::new("dupes")
        .pot("msgctxt \"speaker:Z\"\nmsgid \"Hi\"\nmsgstr \"\"\n")
        .dat("ru", r#"{"t":"Hi","x":"Привет"}"#)
        .po(
            "ru",
            "\
msgctxt \"speaker:Z\"
msgid \"Hi\"
msgstr \"Привет\"

msgctxt \"speaker:Z\"
msgid \"Hi\"
msgstr \"Здравствуй\"
",
        );
    let report = check("ru", &fx.root).expect("QA");
    let dupes: Vec<&Finding> = report
        .findings
        .iter()
        .filter(|f| f.rule == "duplicate-po")
        .collect();
    assert_eq!(dupes.len(), 1);
    assert_eq!(dupes[0].rel, "po/ru.po");
    assert_eq!(
        dupes[0].detail, "speaker:Z: [\"Здравствуй\",\"Привет\"]",
        "UTF-16 порядок как Array.sort()"
    );
}

#[test]
fn дубли_с_одинаковым_переводом_не_флагаются() {
    let fx = Fixture::new("dupes-same")
        .pot("msgctxt \"ui\"\nmsgid \"Hi\"\nmsgstr \"\"\n")
        .dat("ru", "")
        .po(
            "ru",
            "\
msgid \"Hi\"
msgstr \"Привет\"

msgid \"Hi\"
msgstr \"Привет\"
",
        );
    let report = check("ru", &fx.root).expect("QA");
    assert!(!rules(&report).contains(&"duplicate-po"));
}

#[test]
fn dat_первая_строка_побеждает_битые_пропускаются() {
    let fx = Fixture::new("dat")
        .pot("msgctxt \"ui\"\nmsgid \"Hi\"\nmsgstr \"\"\n")
        .dat(
            "ru",
            "{not json}\n{\"t\":\"Hi\",\"x\":\"Первый\"}\n{\"t\":\"Hi\",\"x\":\"Второй\"}\n{\"x\":\"без ключа\"}\n",
        );
    let dat = load_dat(&fx.root.join("runtime/patch_ru.dat"));
    assert_eq!(dat.len(), 1);
    assert_eq!(dat["Hi"].x, "Первый");
    assert!(load_dat(&fx.root.join("runtime/patch_de.dat")).is_empty());
}

#[test]
fn dat_sk_строкой_истинно_а_нулём_ложно() {
    let fx = Fixture::new("dat-sk")
        .pot("msgctxt \"ui\"\nmsgid \"Hi\"\nmsgstr \"\"\n")
        .dat(
            "ru",
            "{\"t\":\"a\",\"sk\":\"false\"}\n{\"t\":\"b\",\"sk\":0}\n{\"t\":\"c\",\"sk\":null}\n",
        );
    let dat = load_dat(&fx.root.join("runtime/patch_ru.dat"));
    assert!(dat["a"].sk, "JS Boolean(\"false\") === true");
    assert!(!dat["b"].sk);
    assert!(!dat["c"].sk);
}

#[test]
fn сводка_покрытие_спикеры_и_пустой_пот() {
    let fx = Fixture::new("summary")
        .pot(
            "\
#: [dlg:1#0]
msgctxt \"speaker:A\"
msgid \"one\"
msgstr \"\"

#: [dlg:1#1]
msgctxt \"speaker:B\"
msgid \"two\"
msgstr \"\"

#: [dlg:1#2]
msgctxt \"speaker:B\"
msgid \"three\"
msgstr \"\"
",
        )
        .dat("ru", "{\"t\":\"one\",\"x\":\"один\"}\n");
    let report = check("ru", &fx.root).expect("QA");
    assert_eq!(report.summary.total, 3);
    assert_eq!(report.summary.filled, 1);
    assert!((report.summary.coverage - 100.0 / 3.0).abs() < 1e-12);
    assert_eq!(report.summary.by_speaker[0].0, "B", "по убыванию total");
    assert_eq!(report.summary.by_speaker[0].1.total, 2);

    let empty = Fixture::new("empty-pot").pot("").dat("ru", "");
    let report = check("ru", &empty.root).expect("QA");
    assert_eq!(report.summary.total, 0);
    assert_eq!(report.summary.coverage, 0.0, "делим на max(total,1)");
    assert!(report.findings.is_empty());
}

#[test]
fn хелперы_доля_кириллицы_спикер_папка() {
    assert_eq!(cyr_ratio("Привет мир"), 1.0);
    assert_eq!(cyr_ratio("Hello world"), 0.0);
    assert!((cyr_ratio("АБВab") - 0.6).abs() < 1e-9);
    assert_eq!(cyr_ratio("123"), 1.0, "букв нет");
    // Комбинирующий знак не буква (как \p{L}) — доля не портится.
    assert_eq!(cyr_ratio("А\u{0301}Б"), 1.0);

    assert_eq!(speaker_of("speaker:Zoey"), "Zoey");
    assert_eq!(speaker_of("ui"), "");
    assert_eq!(sourcedir_of(&[]), "ui");
    assert_eq!(
        sourcedir_of(&["translations/dialogues/1.yaml".to_string()]),
        "dialogues"
    );
    assert_eq!(sourcedir_of(&["[dlg:1#0]".to_string()]), "dlg");
    assert_eq!(sourcedir_of(&["[weird:1]".to_string()]), "?");
}

#[test]
fn не_ascii_в_регистре_и_деталях_latin_leftover() {
    // 80+ символов в переводе: detail обрезается по UTF-16 code units.
    // 20 кириллических букв из 120 (доля 0.17 < 0.3) — правило срабатывает,
    // а в detail попадают первые 80 символов (20 не-ASCII + 60 латинских).
    let text = format!("{}{}", "ы".repeat(20), "a".repeat(100));
    let fx = Fixture::new("utf16")
        .pot("msgctxt \"speaker:Z\"\nmsgid \"x\"\nmsgstr \"\"\n")
        .dat("ru", &format!("{{\"t\":\"x\",\"x\":\"{text}\"}}"));
    let report = check("ru", &fx.root).expect("QA");
    let f = &report.findings[0];
    assert_eq!(f.rule, "latin-leftover");
    assert_eq!(f.detail.chars().count(), 80);
    assert_eq!(f.detail, format!("{}{}", "ы".repeat(20), "a".repeat(60)));
}

#[test]
fn теги_imbalance_считается_только_если_есть_оба_текста() {
    let fx = Fixture::new("tags-missing")
        .pot(
            "\
msgctxt \"speaker:Z\"
msgid \"a\"
msgstr \"\"
",
        )
        .dat("ru", r#"{"t":"a","x":"а","r":"<b>a</b>"}"#);
    let report = check("ru", &fx.root).expect("QA");
    assert!(texts(&report, "tag-imbalance").is_empty());
    assert_eq!(errors(&report.findings), 0);
}

#[test]
fn отсутствующий_po_не_ломает_прогон() {
    let fx = Fixture::new("no-po")
        .pot("msgctxt \"ui\"\nmsgid \"Hi\"\nmsgstr \"\"\n")
        .dat("ru", "");
    assert!(!fx.root.join("po/ru.po").exists());
    let report = check("ru", &fx.root).expect("QA");
    assert!(!rules(&report).contains(&"duplicate-po"));
}

#[test]
fn отчет_в_json_и_jsonl_пишется_и_читается() {
    let fx = Fixture::new("report")
        .pot(POT_THREE)
        .dat("ru", "{\"t\":\"Hi\",\"x\":\"Привет\"}");
    let report = check("ru", &fx.root).expect("QA");
    let jsonl = rust_qa::report::findings_jsonl(&report.findings);
    let lines: Vec<&str> = jsonl.lines().collect();
    assert_eq!(lines.len(), report.findings.len());
    assert!(lines[0].starts_with("{\"level\":"));
    let json = rust_qa::report::report_json("ru", &report);
    assert!(json.starts_with("{\"lang\":\"ru\",\"summary\":{"));
    assert!(json.ends_with("]}"));

    // Запись через CLI-путь: файлы создаются и читаемы.
    let out = fx.root.join("out.json");
    fs::write(&out, &json).expect("запись");
    assert_eq!(fs::read_to_string(&out).expect("чтение"), json);
}
