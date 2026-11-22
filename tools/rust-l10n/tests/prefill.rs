//! prefill: порт TS-тестов (`.opencode/skills/extract-text/tests/prefill_po.test.mts`).
//!
//! Покрыто: мини-читатель YAML-корпуса, порядок источников, нормализация
//! текста, exact/fuzzy/auto-normalized/conflict/missing/orphans, приоритет
//! человеческих переводов, blocklist, атомарная запись, отчётные примитивы.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rust_l10n::prefill::{
    build_ru_corpus, build_ru_po, cp_slice, entry_context, iter_source_entries, load_blocklist,
    normalize_text, py_fixed1, py_repr, read_yaml_entries, repr_variants, ru_header_lines,
    run_prefill, stamp_from_unix, yaml_scalar, yaml_unescape_double, BuildRuPoInput, CorpusEntry,
    PrefillKey, PrefillOptions, RuVariant, YamlScalar,
};
use rust_l10n_core::po::{parse_po, render_po, PoEntry};

/// Временный каталог (удаляется в Drop).
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("rust-l10n-prefill-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("каталог");
        Self { root }
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn write(&self, rel: &str, body: &str) -> PathBuf {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("каталог файла");
        }
        std::fs::write(&path, body).expect("запись файла");
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn entry(msgid: &str, ctxt: &str, msgstr: &str) -> PoEntry {
    PoEntry {
        msgid: msgid.to_string(),
        msgctxt: ctxt.to_string(),
        msgstr: msgstr.to_string(),
        ..PoEntry::default()
    }
}

fn pot_text(entries: &[PoEntry]) -> String {
    render_po(entries, &["# pot".to_string()])
}

/// Запись корпуса (по умолчанию — диалог со спикером).
fn ce(text: &str, translation: &str, speaker: &str, rel: &str, skip: bool) -> CorpusEntry {
    CorpusEntry {
        text: text.to_string(),
        translation: translation.to_string(),
        skip_translation: skip,
        speaker: speaker.to_string(),
        rel: rel.to_string(),
    }
}

fn dialogue(text: &str, translation: &str, speaker: &str) -> CorpusEntry {
    ce(
        text,
        translation,
        speaker,
        "translations/dialogues/1.yaml",
        false,
    )
}

fn fill(
    pot: &[PoEntry],
    corpus: &[CorpusEntry],
    old: Option<&str>,
    blocked: &[&str],
) -> (Vec<PoEntry>, rust_l10n::prefill::PrefillReport) {
    let pot = pot_text(pot);
    let blocked: HashSet<String> = blocked.iter().map(|s| (*s).to_string()).collect();
    build_ru_po(&BuildRuPoInput {
        pot_text: &pot,
        old_po_text: old,
        corpus,
        blocked: &blocked,
    })
}

#[test]
fn yaml_scalar_двойные_одинарные_экраны_булевы_plain() {
    assert_eq!(
        yaml_scalar("\"a\\nb\""),
        YamlScalar::Str("a\nb".to_string())
    );
    assert_eq!(
        yaml_scalar("\"say \\\"hi\\\"\""),
        YamlScalar::Str("say \"hi\"".to_string())
    );
    assert_eq!(
        yaml_scalar("\"C:\\\\path\""),
        YamlScalar::Str("C:\\path".to_string())
    );
    assert_eq!(yaml_scalar("'it''s'"), YamlScalar::Str("it's".to_string()));
    assert_eq!(yaml_scalar("true"), YamlScalar::Bool(true));
    assert_eq!(yaml_scalar("false"), YamlScalar::Bool(false));
    assert_eq!(yaml_scalar("~"), YamlScalar::Null);
    assert_eq!(
        yaml_scalar("plain words"),
        YamlScalar::Str("plain words".to_string())
    );
    assert_eq!(yaml_unescape_double("\\u0416"), "Ж");
    assert_eq!(yaml_unescape_double("\\x41"), "A");
    assert_eq!(
        yaml_unescape_double("\\q"),
        "q",
        "неизвестный эскейп = сам символ"
    );
}

#[test]
fn read_yaml_entries_список_пустой_файл_crlf_комментарии() {
    let fx = Fixture::new("yaml");
    let list = fx.write(
        "list.yaml",
        "# Dialogues\r\n\r\n- text: \"Hi\"\r\n  translation: \"Привет\"\r\n  skip_translation: true\r\n\r\n- text: \"Bye\"\r\n  translation: 'Пока'\r\n",
    );
    let entries = read_yaml_entries(&list);
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0].get("text"),
        Some(&YamlScalar::Str("Hi".to_string()))
    );
    assert_eq!(
        entries[0].get("translation"),
        Some(&YamlScalar::Str("Привет".to_string()))
    );
    assert_eq!(
        entries[0].get("skip_translation"),
        Some(&YamlScalar::Bool(true))
    );
    assert_eq!(
        entries[1].get("translation"),
        Some(&YamlScalar::Str("Пока".to_string()))
    );

    let empty = fx.write("empty.yaml", "");
    assert!(read_yaml_entries(&empty).is_empty());
    assert!(
        read_yaml_entries(&fx.path().join("nope.yaml")).is_empty(),
        "нет файла — пусто, без падения"
    );
}

#[test]
fn iter_source_entries_порядок_dialogues_settings_raw_speakers() {
    let fx = Fixture::new("corpus-order");
    let corpus = fx.path().join("translations");
    fx.write(
        "translations/dialogues/b.yaml",
        "- text: \"B\"\n  translation: \"Б\"\n",
    );
    fx.write(
        "translations/dialogues/a.yaml",
        "- text: \"A\"\n  translation: \"А\"\n",
    );
    fx.write(
        "translations/settings/s.yaml",
        "- text: \"S\"\n  translation: \"С\"\n",
    );
    fx.write(
        "translations/raw/r.yaml",
        "- text: \"R\"\n  translation: \"Р\"\n",
    );
    fx.write(
        "translations/speakers.yaml",
        "- text: \"Zoey\"\n  translation: \"Зои\"\n",
    );

    let got: Vec<(String, String)> = iter_source_entries(&corpus)
        .into_iter()
        .map(|e| (e.text, e.rel))
        .collect();
    assert_eq!(
        got,
        vec![
            ("A".to_string(), "translations/dialogues/a.yaml".to_string()),
            ("B".to_string(), "translations/dialogues/b.yaml".to_string()),
            ("S".to_string(), "translations/settings/s.yaml".to_string()),
            ("R".to_string(), "translations/raw/r.yaml".to_string()),
            ("Zoey".to_string(), "translations/speakers.yaml".to_string()),
        ]
    );
    let entries = iter_source_entries(&corpus);
    assert_eq!(
        entry_context(entries.last().expect("последняя")),
        "speaker-name"
    );
}

#[test]
fn entry_context_спикер_имя_персонажа_ui() {
    assert_eq!(entry_context(&dialogue("Hi", "П", "Zoey")), "speaker:Zoey");
    assert_eq!(
        entry_context(&ce("Zoey", "Зои", "", "translations/speakers.yaml", false)),
        "speaker-name"
    );
    assert_eq!(entry_context(&dialogue("Hi", "П", "  ")), "ui");
}

#[test]
fn normalize_text_маркеры_пунктуация_апострофы_растяжения() {
    assert_eq!(
        normalize_text("004 Yeees yeees Ill be thereee 1"),
        "yes yes ill be there"
    );
    assert_eq!(
        normalize_text("Yeees yeees, I'll be thereee!"),
        "yes yes ill be there"
    );
    assert_eq!(normalize_text("Aw, ...!"), normalize_text("000 Aw ... 2"));
    assert_eq!(normalize_text(""), "");
    assert_eq!(
        normalize_text("a\nb\tc"),
        "a b c",
        "переводы строк — пробелы"
    );
}

#[test]
fn build_ru_corpus_skip_вне_карты_skip_с_переводом_только_при_tr_ne_text() {
    let corpus = vec![
        dialogue("Hi", "Привет", "Zoey"),
        ce(
            "Skip",
            "Скип",
            "Zoey",
            "translations/dialogues/1.yaml",
            true,
        ),
        ce(
            "Copy",
            "Copy",
            "Zoey",
            "translations/dialogues/1.yaml",
            true,
        ),
        dialogue("Hi", "Привет!", "Amy"),
    ];
    let out = build_ru_corpus(&corpus);
    assert_eq!(out.skipped_with_translation.len(), 1);
    assert_eq!(
        out.skipped_with_translation[0],
        rust_l10n::prefill::SkippedWithTranslation {
            text: "Skip".to_string(),
            ctxt: "speaker:Zoey".to_string(),
            translation: "Скип".to_string(),
            file: "translations/dialogues/1.yaml".to_string(),
        }
    );
    assert_eq!(out.map.len(), 2);
    let hi = out
        .map
        .get(&("Hi".to_string(), "speaker:Zoey".to_string()))
        .expect("Hi");
    assert_eq!(
        hi.iter()
            .map(|v| v.translation.as_str())
            .collect::<Vec<_>>(),
        vec!["Привет"]
    );
}

#[test]
fn exact_перевод_точного_ключа_без_флагов() {
    let (entries, report) = fill(
        &[entry("Hi", "speaker:Zoey", "")],
        &[dialogue("Hi", "Привет", "Zoey")],
        None,
        &[],
    );
    assert_eq!(report.total, 1);
    assert_eq!(report.exact, 1);
    assert_eq!(entries[0].msgstr, "Привет");
    assert!(entries[0].flags.is_empty());
}

#[test]
fn fuzzy_один_вариант_на_голый_текст_при_дрейфе_контекста() {
    let (entries, report) = fill(
        &[entry("Hi", "ui", "")],
        &[dialogue("Hi", "Привет", "Zoey")],
        None,
        &[],
    );
    assert_eq!(report.fuzzy.len(), 1);
    assert_eq!(entries[0].msgstr, "Привет");
    assert_eq!(entries[0].flags, vec!["fuzzy".to_string()]);
    assert_eq!(report.fuzzy[0].1, "Привет");
}

#[test]
fn conflict_разные_переводы_одного_ключа_запись_пустая() {
    let (entries, report) = fill(
        &[entry("Hi", "speaker:Zoey", "")],
        &[
            dialogue("Hi", "Привет", "Zoey"),
            ce("Hi", "Здорово", "Zoey", "translations/raw/9.yaml", false),
        ],
        None,
        &[],
    );
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(entries[0].msgstr, "");
    assert!(entries[0].flags.is_empty());
    assert_eq!(report.conflicts[0].1.len(), 2);
}

#[test]
fn auto_normalized_урезанный_вариант_наследует_близнеца() {
    let (entries, report) = fill(
        &[entry("000 Aw ... 2", "ui", "")],
        &[dialogue("Aw, ...!", "Оу...", "")],
        None,
        &[],
    );
    assert_eq!(report.auto_normalized.len(), 1);
    assert_eq!(entries[0].msgstr, "Оу...");
    assert_eq!(
        entries[0].flags,
        vec!["fuzzy".to_string(), "auto-normalized".to_string()]
    );
}

#[test]
fn blocklist_отменяет_auto_normalized() {
    let (entries, report) = fill(
        &[entry("000 Aw ... 2", "ui", "")],
        &[dialogue("Aw, ...!", "Оу...", "")],
        None,
        &["aw"],
    );
    assert_eq!(report.auto_normalized.len(), 0);
    assert_eq!(report.missing.len(), 1);
    assert_eq!(entries[0].msgstr, "");
}

#[test]
fn missing_и_orphans_по_ключам_pot() {
    let (_, report) = fill(
        &[entry("New", "ui", "")],
        &[dialogue("Gone", "Ушло", "Zoey")],
        None,
        &[],
    );
    assert_eq!(
        report.missing,
        vec![("New".to_string(), "ui".to_string()) as PrefillKey]
    );
    assert_eq!(report.orphans.len(), 1);
    assert_eq!(
        report.orphans[0].0,
        ("Gone".to_string(), "speaker:Zoey".to_string())
    );
}

#[test]
fn человеческий_перевод_и_комментарии_не_пересчитываются() {
    let old = render_po(
        &[PoEntry {
            translator: vec!["note for humans".to_string()],
            flags: vec!["fuzzy".to_string()],
            ..entry("Hi", "speaker:Zoey", "Здравствуй")
        }],
        &["# ru".to_string()],
    );
    let (entries, report) = fill(
        &[entry("Hi", "speaker:Zoey", "")],
        &[dialogue("Hi", "Привет", "Zoey")],
        Some(&old),
        &[],
    );
    assert_eq!(report.exact, 1);
    assert_eq!(entries[0].msgstr, "Здравствуй");
    assert_eq!(entries[0].translator, vec!["note for humans".to_string()]);
    assert_eq!(entries[0].flags, vec!["fuzzy".to_string()]);
}

#[test]
fn auto_normalized_в_старом_po_пересчитывается_заново() {
    let old = render_po(
        &[PoEntry {
            flags: vec!["fuzzy".to_string(), "auto-normalized".to_string()],
            ..entry("000 Aw ... 2", "ui", "старое")
        }],
        &["# ru".to_string()],
    );
    let (entries, report) = fill(
        &[entry("000 Aw ... 2", "ui", "")],
        &[dialogue("Aw, ...!", "Оу...", "")],
        Some(&old),
        &[],
    );
    assert_eq!(report.auto_normalized.len(), 1);
    assert_eq!(entries[0].msgstr, "Оу...");
    assert_eq!(
        entries[0].flags,
        vec!["fuzzy".to_string(), "auto-normalized".to_string()]
    );
}

#[test]
fn пустой_pot_и_po_без_заголовка_без_падений() {
    let (entries, report) = fill(&[], &[], None, &[]);
    assert_eq!(report.total, 0);
    assert!(entries.is_empty());

    let (entries, _) = fill(
        &[entry("A", "", "")],
        &[],
        Some("msgid \"A\"\nmsgstr \"Б\"\n"),
        &[],
    );
    assert_eq!(entries[0].msgstr, "Б");
}

#[test]
fn кавычки_и_переводы_строк_переживают_render_parse() {
    let id = "He said \"hi\"\nbye";
    let (entries, _) = fill(
        &[entry(id, "ui", "")],
        &[dialogue(id, "Он сказал \"привет\"\nпока", "")],
        None,
        &[],
    );
    let back: Vec<PoEntry> = parse_po(&render_po(
        &entries,
        &ru_header_lines("2026-01-02 03:04+0000"),
    ))
    .into_iter()
    .filter(|e| !e.msgid.is_empty())
    .collect();
    assert_eq!(back[0].msgid, id);
    assert_eq!(back[0].msgstr, "Он сказал \"привет\"\nпока");
}

#[test]
fn load_blocklist_комментарии_и_crlf() {
    let fx = Fixture::new("blocklist");
    let dir = fx.path().join("blocklist");
    std::fs::create_dir_all(&dir).expect("каталог");
    std::fs::write(
        dir.join("autofill_blocklist.txt"),
        "# header\r\ndildo # foreign-marker\r\n\r\n  impact  \r\n",
    )
    .expect("файл");

    let blocked = load_blocklist(&dir);
    let mut names: Vec<&str> = blocked.iter().map(String::as_str).collect();
    names.sort();
    assert_eq!(names, vec!["dildo", "impact"]);
    assert!(load_blocklist(&fx.path().join("none")).is_empty());
}

#[test]
fn run_prefill_пишет_с_шапкой_атомарно_идемпотентно() {
    let fx = Fixture::new("run");
    fx.write(
        "po/template.pot",
        &pot_text(&[entry("Hi", "speaker:Zoey", "")]),
    );
    fx.write(
        "translations/dialogues/1.yaml",
        "- text: \"Hi\"\n  translation: \"Привет\"\n  speaker: \"Zoey\"\n",
    );
    let options = PrefillOptions {
        lang: "ru".to_string(),
        po_dir: fx.path().join("po"),
        corpus_dir: Some(fx.path().join("translations")),
        created: Some("2026-01-02 03:04+0000".to_string()),
    };
    let res = run_prefill(&options).expect("прогон");
    assert_eq!(res.report.exact, 1);
    let first = std::fs::read_to_string(fx.path().join("po/ru.po")).expect("PO");
    assert!(first.starts_with("# Russian translation for NeonTranslator"));
    assert!(first.contains("\"PO-Revision-Date: 2026-01-02 03:04+0000\\n\""));
    assert!(first.contains("msgstr \"Привет\""));

    run_prefill(&options).expect("второй прогон");
    assert_eq!(
        std::fs::read_to_string(fx.path().join("po/ru.po")).expect("PO"),
        first,
        "второй прогон байт-в-байт"
    );
    assert!(!fx.path().join("po/ru.po.part").exists());
}

#[test]
fn run_prefill_без_pot_ошибка_потген() {
    let fx = Fixture::new("no-pot");
    std::fs::create_dir_all(fx.path().join("po")).expect("каталог");
    let options = PrefillOptions {
        lang: "ru".to_string(),
        po_dir: fx.path().join("po"),
        corpus_dir: None,
        created: None,
    };
    let err = run_prefill(&options).expect_err("должна быть ошибка");
    assert!(err.contains("potgen"), "сообщение: {err}");
    assert!(!fx.path().join("po/ru.po").exists());
}

#[test]
fn отчётные_примитивы_как_в_python() {
    assert_eq!(py_repr("plain"), "'plain'");
    assert_eq!(py_repr("say \"hi\""), "'say \"hi\"'");
    assert_eq!(py_repr("it's \"x\""), "'it\\'s \"x\"'");
    assert_eq!(py_repr("a\nb\tc\\d"), "'a\\nb\\tc\\\\d'");
    assert_eq!(py_repr("Ж"), "'Ж'", "кириллица печатается как есть");
    assert_eq!(py_repr("\u{a0}"), "'\\xa0'");
    assert_eq!(cp_slice("a😀b", 1), "a");
    assert_eq!(cp_slice("a😀b", 2), "a😀", "срез по code points");
    assert_eq!(py_fixed1(55.93), "55.9");
    assert_eq!(py_fixed1(0.25), "0.2", "полук — к чётному");
    assert_eq!(py_fixed1(100.0), "100.0");
    assert_eq!(
        repr_variants(&[
            RuVariant {
                translation: "Привет".to_string(),
                file: "translations/dialogues/1.yaml".to_string(),
            },
            RuVariant {
                translation: "Здорово".to_string(),
                file: "translations/raw/9.yaml".to_string(),
            },
        ]),
        "[('Привет', 'translations/dialogues/1.yaml'), ('Здорово', 'translations/raw/9.yaml')]"
    );
}

#[test]
fn дата_заголовка_считается_без_зависимостей() {
    // 2026-01-02 03:04 UTC = 1767323040 секунд.
    assert_eq!(stamp_from_unix(1_767_323_040), "2026-01-02 03:04+0000");
    assert_eq!(stamp_from_unix(0), "1970-01-01 00:00+0000");
    // Високосный день и конец года.
    assert_eq!(stamp_from_unix(1_709_164_800), "2024-02-29 00:00+0000");
    assert_eq!(stamp_from_unix(1_735_689_599), "2024-12-31 23:59+0000");
}

#[test]
fn отчёт_печатает_все_секции() {
    let (_, report) = fill(
        &[entry("Hi", "ui", ""), entry("Nope", "ui", "")],
        &[dialogue("Gone", "Ушло", "Zoey")],
        None,
        &[],
    );
    let text = rust_l10n::prefill::format_report("ru", Path::new("po/ru.po"), &report);
    for section in [
        "exact",
        "fuzzy (context drift)",
        "auto-normalized",
        "conflicts",
        "missing",
        "orphans",
        "skipped with real translation",
    ] {
        assert!(text.contains(section), "нет секции {section}: {text}");
    }
    assert!(text.contains("MISSING ui 'Hi'"), "{text}");
    assert!(text.contains("ORPHAN speaker:Zoey 'Gone'"), "{text}");
}

#[test]
fn json_отчёт_валиден() {
    let (_, report) = fill(
        &[entry("Hi", "speaker:Zoey", ""), entry("Nope", "ui", "")],
        &[
            dialogue("Hi", "Привет", "Zoey"),
            dialogue("Gone", "Ушло", "Amy"),
        ],
        None,
        &[],
    );
    let json = rust_l10n::prefill::report_to_json(&report);
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("валидный JSON");
    assert_eq!(parsed["total"], 2);
    assert_eq!(parsed["exact"], 1);
    assert_eq!(parsed["missing"].as_array().map(Vec::len), Some(1));
    assert_eq!(parsed["orphans"].as_array().map(Vec::len), Some(1));
}
