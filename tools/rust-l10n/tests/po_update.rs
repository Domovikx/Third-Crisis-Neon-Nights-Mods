//! po_update: порт TS-тестов (`.opencode/skills/extract-text/tests/po_update.test.mts`)
//! + тесты нового учёта выпавших ключей (`dropped`/`orphans`/`dup_keys`).

use std::path::{Path, PathBuf};

use rust_l10n::po_update::{
    extract_header, merge_pot, render_merged, report_to_json, run_po_update, DupRule,
    PoUpdateOptions,
};
use rust_l10n_core::po::{parse_po, render_po, PoEntry};

fn e(msgid: &str, ctxt: &str, msgstr: &str, refs: &[&str]) -> PoEntry {
    PoEntry {
        msgid: msgid.to_string(),
        msgctxt: ctxt.to_string(),
        msgstr: msgstr.to_string(),
        refs: refs.iter().map(|r| (*r).to_string()).collect(),
        ..PoEntry::default()
    }
}

fn pot_text(entries: &[PoEntry], header: &[&str]) -> String {
    render_po(
        entries,
        &header.iter().map(|h| (*h).to_string()).collect::<Vec<_>>(),
    )
}

/// Временный каталог с `po/template.pot` и `po/<lang>.po`.
struct Fixture {
    root: PathBuf,
    lang: String,
}

impl Fixture {
    fn new(name: &str, pot: &str, po: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("rust-l10n-po-update-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("po");
        std::fs::create_dir_all(&dir).expect("каталог po");
        std::fs::write(dir.join("template.pot"), pot).expect("POT");
        std::fs::write(dir.join("xx.po"), po).expect("PO");
        Self {
            root,
            lang: "xx".to_string(),
        }
    }

    fn po_path(&self) -> PathBuf {
        self.root.join("po").join(format!("{}.po", self.lang))
    }

    fn options(&self) -> PoUpdateOptions {
        PoUpdateOptions {
            lang: self.lang.clone(),
            po_dir: self.root.join("po"),
            dup_rule: DupRule::Last,
            backup: true,
        }
    }

    fn read(&self) -> String {
        std::fs::read_to_string(self.po_path()).expect("PO")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

const HEADER: &str = "msgid \"\"\nmsgstr \"\"\n";

#[test]
fn перенос_и_новая_запись_refs_berutsya_из_pot() {
    let pot = [e("A", "ui", "", &[]), e("B", "ui", "", &[])];
    let po = [e("A", "ui", "А", &["f1"])];
    let out = merge_pot(&po, &pot, DupRule::Last);

    assert_eq!(out.stats.carried, 1);
    assert_eq!(out.stats.new, 1);
    assert_eq!(out.stats.obsolete, 0);
    let a = out.merged.iter().find(|m| m.po.msgid == "A").expect("A");
    assert_eq!(a.po.msgstr, "А");
    assert_eq!(a.po.refs, Vec::<String>::new(), "refs берутся из POT");
    assert_eq!(out.merged[1].po.msgstr, "");
}

#[test]
fn исчезнувший_текст_живёт_с_флагом_legacy() {
    let pot = [e("A", "ui", "", &[])];
    let gone = e("Gone", "ui", "Ушло", &[]);
    let out = merge_pot(&[e("A", "ui", "А", &[]), gone], &pot, DupRule::Last);

    assert_eq!(out.stats.legacy_kept, 1);
    assert_eq!(out.stats.obsolete, 0);
    assert_eq!(out.stats.dropped, 0);
    let kept = out
        .merged
        .iter()
        .find(|m| m.po.msgid == "Gone")
        .expect("сирота в хвосте");
    assert_eq!(kept.po.msgstr, "Ушло");
    assert!(!kept.obsolete, "никогда #~");
    assert_eq!(kept.po.flags, vec!["legacy".to_string()]);
    assert!(kept
        .po
        .translator
        .last()
        .expect("комментарий")
        .starts_with("legacy: text vanished from POT"));
}

#[test]
fn ретаргет_при_смене_контекста() {
    let pot = [e("Go", "speaker:Zed", "", &[])];
    let mut old = e("Go", "ui", "Иди", &["translations/old.yaml"]);
    old.translator = vec!["rich: <b>Иди</b>".to_string()];
    let out = merge_pot(&[old], &pot, DupRule::Last);

    assert_eq!(out.stats.retargeted, 1);
    assert_eq!(out.stats.dropped, 0);
    assert_eq!(out.merged.len(), 1);
    assert_eq!(out.merged[0].po.msgctxt, "speaker:Zed");
    assert_eq!(out.merged[0].po.msgstr, "Иди");
    assert_eq!(out.merged[0].po.translator, vec!["rich: <b>Иди</b>"]);
    assert!(out.merged[0].po.refs.is_empty(), "refs — из POT");
    assert_eq!(
        out.stats.retarget_items,
        vec![rust_l10n::po_update::Retarget {
            from: ("Go".to_string(), "ui".to_string()),
            to: ("Go".to_string(), "speaker:Zed".to_string()),
        }]
    );
}

#[test]
fn ретаргет_не_срабатывает_если_одноимённый_ключ_уже_переведён_но_вариант_виден() {
    // Это ровно та группа, из-за которой 48 переводов «потеряли контекст»:
    // раньше она исчезала молча, теперь считается в `dropped` и печатается.
    let pot = [
        e("Go", "speaker:Zed", "", &[]),
        e("Go", "speaker:Amy", "", &[]),
    ];
    let po = [
        e("Go", "speaker:Amy", "Иди", &[]),
        e("Go", "ui", "Ступай", &[]),
    ];
    let out = merge_pot(&po, &pot, DupRule::Last);

    assert_eq!(out.stats.retargeted, 0);
    assert_eq!(out.stats.dropped, 1, "вариант не потерялся молча");
    assert_eq!(out.stats.dropped_items[0].msgstr, "Ступай");
    assert_eq!(
        out.stats.dropped_items[0].reason,
        rust_l10n::po_update::DropReason::AlreadyTranslated
    );
    assert_eq!(
        out.stats.dropped_items[0].alive,
        vec!["speaker:Amy".to_string(), "speaker:Zed".to_string()],
        "видно, где текст жив"
    );
    let zed = out
        .merged
        .iter()
        .find(|m| m.po.msgctxt == "speaker:Zed")
        .expect("Zed");
    assert_eq!(zed.po.msgstr, "", "второй одноимённый ключ остаётся пустым");
    assert!(out.merged.iter().all(|m| m.po.msgctxt != "ui"));
}

#[test]
fn два_исчезнувших_ключа_на_один_целевой_переживает_последний_но_потеря_видна() {
    let pot = [e("Go", "speaker:Zed", "", &[])];
    // Порядок в файле: «первый», «второй»; сортировка по msgctxt решает, кто
    // вошёл в fill последним (второй по сортировке перезаписывает первый).
    let po = [e("Go", "aaa", "Первый", &[]), e("Go", "zzz", "Второй", &[])];
    let out = merge_pot(&po, &pot, DupRule::Last);

    assert_eq!(
        out.merged[0].po.msgstr, "Второй",
        "правило ретаргета (TS 1:1)"
    );
    assert_eq!(out.stats.dropped, 1);
    assert_eq!(
        out.stats.dropped_items[0].reason,
        rust_l10n::po_update::DropReason::RetargetOverwritten
    );
    assert_eq!(out.stats.dropped_items[0].msgstr, "Первый");
}

#[test]
fn пустые_переводы_выпадают_obsolete_всегда_ноль() {
    let pot = [e("A", "ui", "", &[])];
    let po = [e("A", "ui", "", &[]), e("Gone", "ui", "", &[])];
    let out = merge_pot(&po, &pot, DupRule::Last);
    assert_eq!(out.stats.obsolete, 0);
    assert_eq!(out.stats.dropped, 0);
    assert_eq!(out.merged.len(), 1);
}

#[test]
fn запись_с_флагом_legacy_остаётся_в_хвосте_без_изменений() {
    let pot = [e("A", "ui", "", &[])];
    let mut legacy = e("Triaged", "ui", "Мусор", &[]);
    legacy.flags = vec!["legacy".to_string()];
    let out = merge_pot(&[e("A", "ui", "А", &[]), legacy], &pot, DupRule::Last);

    assert_eq!(
        out.stats.legacy_kept, 0,
        "legacy не считается заново спасённым"
    );
    assert_eq!(out.stats.orphans, 1, "сирота видна в каждом прогоне");
    assert_eq!(out.merged.len(), 2);
    assert_eq!(out.merged[1].po.flags, vec!["legacy".to_string()]);
}

#[test]
fn auto_normalized_не_переезжает_в_новый_pot() {
    let pot = [e("A", "ui", "", &[])];
    let mut po = e("A", "ui", "А", &[]);
    po.flags = vec!["fuzzy".to_string(), "auto-normalized".to_string()];
    let out = merge_pot(&[po], &pot, DupRule::Last);
    assert_eq!(out.merged[0].po.flags, vec!["fuzzy".to_string()]);
}

#[test]
fn дубликаты_ключа_в_po_побеждает_последний_и_это_видно() {
    let pot = [e("A", "ui", "", &[])];
    let po = [e("A", "ui", "первый", &[]), e("A", "ui", "второй", &[])];
    let out = merge_pot(&po, &pot, DupRule::Last);
    assert_eq!(out.merged[0].po.msgstr, "второй");
    assert_eq!(out.stats.dup_keys, 1);
    assert_eq!(out.stats.dup_items[0].variants, vec!["первый", "второй"]);
    assert_eq!(out.stats.dup_items[0].chosen, "второй");
}

#[test]
fn dup_rule_earliest_ref_выбирает_то_что_увидит_рантайм() {
    let pot = [e("A", "ui", "", &[])];
    let early = e("A", "ui", "ранний", &["translations/1.yaml"]);
    let late = e("A", "ui", "поздний", &["translations/z.yaml"]);
    // В файле ранний блок идёт первым: правила расходятся.
    let po = [early, late];

    let last = merge_pot(&po, &pot, DupRule::Last);
    assert_eq!(
        last.merged[0].po.msgstr, "поздний",
        "последний блок в файле"
    );
    assert_eq!(last.stats.dup_items[0].chosen, "поздний");

    let by_ref = merge_pot(&po, &pot, DupRule::EarliestRef);
    assert_eq!(
        by_ref.merged[0].po.msgstr, "ранний",
        "earliest-ref = translations/1.yaml, как решает po2dat"
    );
    assert_eq!(by_ref.stats.dup_keys, 1);
    assert_eq!(by_ref.stats.dup_items[0].chosen, "ранний");
    assert_eq!(
        by_ref.stats.dup_items[0].variants,
        vec!["ранний".to_string(), "поздний".to_string()],
        "оба варианта видны в отчёте"
    );
}

#[test]
fn кавычки_и_переводы_строк_переживают_merge_render_parse() {
    let id = "He said \"hi\"\nbye";
    let pot = [e(id, "ui", "", &[])];
    let po = [e(id, "ui", "Он сказал \"привет\"\nпока", &[])];
    let out = merge_pot(&po, &pot, DupRule::Last);
    let text = render_merged(&out.merged, &["# header".to_string()]);
    let back = parse_po(&text);

    assert_eq!(back.len(), 1);
    assert_eq!(back[0].msgid, id);
    assert_eq!(back[0].msgstr, "Он сказал \"привет\"\nпока");
    assert!(text.contains("msgid \"He said \\\"hi\\\"\\nbye\""));
}

#[test]
fn комментарии_переводчика_сохраняются_пустой_как_голая_решётка() {
    let pot = [e("A", "ui", "", &[])];
    let mut old = e("A", "ui", "А", &[]);
    old.translator = vec![
        "rich: <b>А</b>".to_string(),
        "note for humans".to_string(),
        String::new(),
    ];
    let out = merge_pot(&[old], &pot, DupRule::Last);
    let text = render_merged(&out.merged, &[]);
    assert!(text.contains("# rich: <b>А</b>"));
    assert!(text.contains("# note for humans"));
    assert!(text.contains("\n#\n"), "пустой комментарий — голая решётка");
    let back = parse_po(&text);
    assert_eq!(
        back[0].translator,
        vec!["rich: <b>А</b>".to_string(), "note for humans".to_string()]
    );
    assert_eq!(back[0].msgstr, "А");
}

#[test]
fn obsolete_запись_рендерится_блоками() {
    let entry = e("Old", "ui", "Старое", &[]);
    let text = render_merged(
        &[rust_l10n::po_update::MergedEntry {
            po: entry,
            obsolete: true,
        }],
        &[],
    );
    assert!(text.contains("#~ msgid \"Old\""));
    assert!(text.contains("#~ msgstr \"Старое\""));
}

#[test]
fn заголовок_первый_блок_crlf_нормализуется() {
    let raw = "# RU\r\nmsgid \"\"\r\nmsgstr \"X\\n\"\r\n\r\nmsgid \"A\"\r\nmsgstr \"Б\"\r\n";
    assert_eq!(
        extract_header(raw),
        vec![
            "# RU".to_string(),
            "msgid \"\"".to_string(),
            "msgstr \"X\\n\"".to_string()
        ]
    );
}

#[test]
fn без_пустой_строки_в_шапку_уходит_весь_файл() {
    let raw = "msgid \"A\"\nmsgstr \"Б\"\n";
    assert_eq!(
        extract_header(raw),
        vec!["msgid \"A\"".to_string(), "msgstr \"Б\"".to_string()]
    );
}

#[test]
fn run_cli_цикл_с_бэкапом_и_шапкой() {
    let fx = Fixture::new(
        "cli",
        &pot_text(&[e("A", "ui", "", &[]), e("B", "ui", "", &[])], &[]),
        &pot_text(&[e("A", "ui", "Ä", &["old"])], &["# de"]),
    );
    let res = run_po_update(&fx.options()).expect("прогон");

    assert_eq!(res.stats.carried, 1);
    assert_eq!(res.stats.new, 1);
    assert!(fx.root.join("po/xx.po.bak").exists());

    let out = fx.read();
    assert!(out.starts_with("# de\n\n"), "шапка переносится дословно");
    let back = parse_po(&out);
    let pairs: Vec<(String, String)> = back
        .iter()
        .map(|x| (x.msgid.clone(), x.msgstr.clone()))
        .collect();
    assert_eq!(
        pairs,
        vec![
            ("A".to_string(), "Ä".to_string()),
            ("B".to_string(), String::new())
        ]
    );
}

#[test]
fn пустой_po_только_новые_записи_с_ведущей_пустой_строкой() {
    let fx = Fixture::new("empty", &pot_text(&[e("A", "ui", "", &[])], &["# pot"]), "");
    let res = run_po_update(&fx.options()).expect("прогон");
    assert_eq!(res.stats.new, 1);
    let raw = fx.read();
    assert!(
        raw.starts_with('\n'),
        "заголовка нет — вывод начинается с пустой строки"
    );
    assert_eq!(parse_po(&raw).len(), 1);
}

#[test]
fn повторный_прогон_файл_не_меняет_и_part_не_остаётся() {
    let fx = Fixture::new(
        "twice",
        &pot_text(&[e("A", "ui", "", &[])], &["# pot"]),
        &pot_text(&[e("A", "ui", "А", &[])], &["# ru"]),
    );
    run_po_update(&fx.options()).expect("первый");
    let first = fx.read();
    run_po_update(&fx.options()).expect("второй");
    assert_eq!(fx.read(), first);
    assert!(!fx.root.join("po/xx.po.part").exists());
}

#[test]
fn отсутствующий_po_ошибка_и_файл_не_создаётся() {
    let root = std::env::temp_dir().join(format!(
        "rust-l10n-po-update-missing-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("po")).expect("каталог");
    std::fs::write(
        root.join("po/template.pot"),
        pot_text(&[e("A", "ui", "", &[])], &[]),
    )
    .expect("POT");
    let options = PoUpdateOptions {
        lang: "ru".to_string(),
        po_dir: root.join("po"),
        dup_rule: DupRule::Last,
        backup: true,
    };
    let err = run_po_update(&options).expect_err("должна быть ошибка");
    assert!(err.contains("missing"), "сообщение: {err}");
    assert!(!root.join("po/ru.po").exists());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn атомарная_запись_обрыв_не_обнуляет_файл() {
    let root =
        std::env::temp_dir().join(format!("rust-l10n-po-update-atomic-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("каталог");
    let target = root.join("ru.po");
    std::fs::write(&target, "СТАРОЕ\n").expect("старое");

    // Эмулируем обрыв: `.part` занят каталогом — запись падает.
    let part = PathBuf::from(format!("{}.part", target.display()));
    std::fs::create_dir_all(&part).expect("каталог .part");
    std::fs::write(part.join("junk"), "x").expect("мусор");

    assert!(rust_l10n::po_update::write_atomic(&target, "НОВОЕ\n").is_err());
    assert_eq!(std::fs::read_to_string(&target).expect("цель"), "СТАРОЕ\n");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn json_отчёт_содержит_выпавшие_и_сирот() {
    let pot = [e("A", "ui", "", &[]), e("Go", "speaker:Amy", "", &[])];
    let mut legacy = e("Triaged", "ui", "Мусор", &[]);
    legacy.flags = vec!["legacy".to_string()];
    let po = [
        e("A", "ui", "А", &[]),
        e("Go", "speaker:Amy", "Иди", &[]),
        e("Go", "ui", "Ступай", &[]),
        legacy,
    ];
    let out = merge_pot(&po, &pot, DupRule::Last);
    let json = report_to_json(&out.stats);

    assert!(json.contains("\"dropped\": 1"), "{json}");
    assert!(json.contains("\"orphans\": 1"), "{json}");
    assert!(json.contains("\"already-translated\""), "{json}");
    assert!(
        json.contains("\"Ступай\""),
        "значащий перевод виден в отчёте"
    );
    assert!(json.contains("\"Triaged\""), "сирота поимённо");
    // JSON валиден и парсится стандартным парсером ядра.
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("валидный JSON");
    assert_eq!(parsed["dropped"], 1);
}

#[test]
fn опустевший_pot_делает_все_переводы_сиротами_но_не_теряет_их() {
    let out = merge_pot(
        &[e("Gone1", "ui", "Раз", &[]), e("Gone2", "ui", "Два", &[])],
        &[],
        DupRule::Last,
    );
    assert_eq!(out.stats.legacy_kept, 2);
    assert_eq!(out.stats.orphans, 2);
    assert_eq!(out.stats.dropped, 0);
    assert_eq!(out.merged.len(), 2);
    assert!(out
        .merged
        .iter()
        .all(|m| m.po.flags == vec!["legacy".to_string()]));
}

#[test]
fn заголовок_сохраняется_даже_когда_pot_пуст() {
    let raw = "# de\nmsgid \"\"\nmsgstr \"X\\n\"\n";
    assert_eq!(
        extract_header(raw),
        vec![
            "# de".to_string(),
            "msgid \"\"".to_string(),
            "msgstr \"X\\n\"".to_string()
        ]
    );
}

#[test]
fn render_пустого_слияния_даёт_один_перевод_строки() {
    assert_eq!(render_merged(&[], &[]), "\n");
    assert_eq!(render_merged(&[], &["# h".to_string()]), "# h\n");
}

#[test]
fn шаблон_отчёта_печатает_все_ключи_счётчиков() {
    // Контракт отчёта: имена полей совпадают с требованием задачи.
    let stats = merge_pot(
        &[e("A", "ui", "А", &[])],
        &[e("A", "ui", "", &[]), e("B", "ui", "", &[])],
        DupRule::Last,
    )
    .stats;
    let text = report_to_json(&stats);
    for field in [
        "carried",
        "new",
        "obsolete",
        "retargeted",
        "legacyKept",
        "dropped",
        "orphans",
        "dupKeys",
    ] {
        assert!(
            text.contains(&format!("\"{field}\":")),
            "нет поля {field}: {text}"
        );
    }
}

#[test]
fn пути_не_зависят_от_текущего_каталога() {
    let fx = Fixture::new(
        "paths",
        &pot_text(&[e("A", "ui", "", &[])], &[]),
        &pot_text(&[e("A", "ui", "А", &[])], &[]),
    );
    let options = fx.options();
    let res = run_po_update(&options).expect("прогон");
    assert_eq!(res.po_path, Path::new(&fx.po_path()));
    assert!(res.backup_path.is_some());
}

#[test]
fn без_бэкапа_флаг_не_пишет_bak() {
    let fx = Fixture::new(
        "nobak",
        &pot_text(&[e("A", "ui", "", &[])], &[]),
        &pot_text(&[e("A", "ui", "А", &[])], &[]),
    );
    let mut options = fx.options();
    options.backup = false;
    let res = run_po_update(&options).expect("прогон");
    assert!(res.backup_path.is_none());
    assert!(!fx.root.join("po/xx.po.bak").exists());
}

#[test]
fn пустая_шапка_не_ломает_разбор() {
    // Пустая шапка (`msgid ""` + `msgstr ""`) парсером отбрасывается — как в TS.
    let raw = format!("{HEADER}\nmsgid \"A\"\nmsgstr \"\"\n");
    assert_eq!(
        parse_po(&raw).len(),
        1,
        "остаётся только содержательная запись"
    );
}
