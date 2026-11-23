//! po2dat: порт TS-тестов (`po2dat.test.mts`) — rich, дубли, гейт, флаги, запись.

use std::path::{Path, PathBuf};

use rust_l10n::po2dat::{build_dat, load_pot_rich, to_json_line, write_dat, DatRow};

const HEADER: &str = "msgid \"\"\nmsgstr \"\"\n";

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str, pot: &str, po: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("rust-l10n-po2dat-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("po")).expect("каталог po");
        std::fs::write(root.join("po/template.pot"), pot).expect("POT");
        std::fs::write(root.join("po/xx.po"), po).expect("PO");
        Self { root }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn rows_of(fixture: &Fixture) -> Vec<DatRow> {
    build_dat("xx", &fixture.root).expect("сборка").0
}

#[test]
fn rich_text_из_шаблона_подставляется() {
    let fx = Fixture::new(
        "rich",
        &format!(
            "{HEADER}\n#. rich_text: <color=#EB83FF>Yesss...!~</color>\nmsgid \"Yesss...!~\"\nmsgstr \"\"\n"
        ),
        &format!("{HEADER}\nmsgid \"Yesss...!~\"\nmsgstr \"Да-а-а...!~\"\n"),
    );
    let (rows, report) = build_dat("xx", &fx.root).expect("сборка");
    assert_eq!(
        rows,
        vec![DatRow {
            t: "Yesss...!~".to_string(),
            x: "Да-а-а...!~".to_string(),
            r: Some("<color=#EB83FF>Yesss...!~</color>".to_string()),
            ..DatRow::default()
        }]
    );
    assert_eq!(report.filled, 1);
    assert_eq!(report.no_rich, 0);
}

#[test]
fn rich_translation_из_комментария_переводчика_идёт_в_rt() {
    // Основное имя — `rich_translation:`; `rich:` — старый алиас.
    let pot = format!(
        "{HEADER}
#. rich_text: Hehe- That sounds- <color=#EB83FF>fun...</color>
msgid \"Hehe- That sounds- fun...\"
msgstr \"\"
"
    );
    for (comment, expected) in [
        (
            "# rich_translation: Хе-хе- Звучит- <color=#EB83FF>весело...</color>",
            "Хе-хе- Звучит- <color=#EB83FF>весело...</color>",
        ),
        (
            "# rich: Хе-хе- Звучит- <color=#EB83FF>весело...</color>",
            "Хе-хе- Звучит- <color=#EB83FF>весело...</color>",
        ),
        (
            "# rich: старый
# rich_translation: новый",
            "новый",
        ),
    ] {
        let fx = Fixture::new(
            "rt",
            &pot,
            &format!(
                "{HEADER}
{comment}
msgid \"Hehe- That sounds- fun...\"
msgstr \"Хе-хе- Звучит- весело...\"
"
            ),
        );
        let (rows, _) = build_dat("xx", &fx.root).expect("сборка");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].rt.as_deref(),
            Some(expected),
            "комментарий {comment:?}"
        );
        assert_eq!(
            rows[0].r.as_deref(),
            Some("Hehe- That sounds- <color=#EB83FF>fun...</color>")
        );
    }
}

#[test]
fn без_перевода_и_без_rich_строки_нет() {
    let fx = Fixture::new(
        "empty",
        HEADER,
        &format!("{HEADER}\nmsgid \"Nope\"\nmsgstr \"\"\n"),
    );
    assert!(rows_of(&fx).is_empty());
}

#[test]
fn rich_only_попадает_с_пустым_переводом() {
    let fx = Fixture::new(
        "richonly",
        &format!(
            "{HEADER}\n#. rich_text: <color=#fff>Styled</color>\nmsgid \"Styled\"\nmsgstr \"\"\n"
        ),
        &format!("{HEADER}\nmsgid \"Styled\"\nmsgstr \"\"\n"),
    );
    let (rows, report) = build_dat("xx", &fx.root).expect("сборка");
    assert_eq!(
        rows,
        vec![DatRow {
            t: "Styled".to_string(),
            x: String::new(),
            r: Some("<color=#fff>Styled</color>".to_string()),
            ..DatRow::default()
        }]
    );
    assert_eq!(report.rich_only, 1);
}

#[test]
fn дубликаты_разрешает_earliest_ref_file_wins() {
    let fx = Fixture::new(
        "dupes",
        HEADER,
        &format!(
            "{HEADER}\n#: translations/b.yaml\nmsgid \"Hi\"\nmsgstr \"B\"\n\n\
             #: translations/a.yaml\nmsgid \"Hi\"\nmsgstr \"A\"\n"
        ),
    );
    let (rows, report) = build_dat("xx", &fx.root).expect("сборка");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].x, "A");
    assert_eq!(report.dupes.len(), 1);
    assert_eq!(report.dupes[0].0, "Hi");
}

#[test]
fn авто_нормализованное_ждёт_человека() {
    let fx = Fixture::new(
        "gated",
        HEADER,
        &format!("{HEADER}\n#, auto-normalized\nmsgid \"X\"\nmsgstr \"Икс\"\n"),
    );
    let (rows, report) = build_dat("xx", &fx.root).expect("сборка");
    assert!(rows.is_empty());
    assert_eq!(report.gated_auto_normalized, 1);
}

#[test]
fn legacy_даёт_sk_а_rich_комментарий_даёт_rt() {
    let fx = Fixture::new(
        "flags",
        &format!("{HEADER}\n#. rich_text: <color=#fff>Hi</color>\nmsgid \"Hi\"\nmsgstr \"\"\n"),
        &format!(
            "{HEADER}\n# rich: <color=#fff>Привет</color>\n#, legacy\nmsgid \"Hi\"\nmsgstr \"Привет\"\n"
        ),
    );
    assert_eq!(
        rows_of(&fx),
        vec![DatRow {
            t: "Hi".to_string(),
            x: "Привет".to_string(),
            r: Some("<color=#fff>Hi</color>".to_string()),
            rt: Some("<color=#fff>Привет</color>".to_string()),
            sk: true,
        }]
    );
}

#[test]
fn load_pot_rich_первый_побеждает() {
    let fx = Fixture::new(
        "potwins",
        &format!(
            "{HEADER}\n#. rich_text: <color=#111>first</color>\nmsgid \"T\"\nmsgstr \"\"\n\n\
             #. rich_text: <color=#222>second</color>\nmsgid \"T\"\nmsgstr \"\"\n"
        ),
        &format!("{HEADER}\nmsgid \"T\"\nmsgstr \"Т\"\n"),
    );
    let rich = load_pot_rich(&fx.root);
    assert_eq!(
        rich.get("T").map(String::as_str),
        Some("<color=#111>first</color>")
    );
}

#[test]
fn отсутствующий_po_понятная_ошибка() {
    let fx = Fixture::new("missing", HEADER, HEADER);
    let err = build_dat("zz", &fx.root).expect_err("должна быть ошибка");
    assert!(err.starts_with("missing "), "{err}");
    assert!(err.contains("zz.po"), "{err}");
}

#[test]
fn json_строка_совпадает_с_форматом_ts() {
    let row = DatRow {
        t: "a\"b\\c\n\u{1}".to_string(),
        x: "Привет".to_string(),
        r: None,
        rt: None,
        sk: false,
    };
    assert_eq!(
        to_json_line(&row),
        "{\"t\": \"a\\\"b\\\\c\\n\\u0001\", \"x\": \"Привет\"}"
    );
    let full = DatRow {
        t: "Hi".to_string(),
        x: "Привет".to_string(),
        r: Some("<b>Hi</b>".to_string()),
        rt: Some("<b>Привет</b>".to_string()),
        sk: true,
    };
    assert_eq!(
        to_json_line(&full),
        "{\"t\": \"Hi\", \"x\": \"Привет\", \"r\": \"<b>Hi</b>\", \"rt\": \"<b>Привет</b>\", \"sk\": true}"
    );
}

#[test]
fn запись_атомарная_и_пустой_список_даёт_пустой_файл() {
    let fx = Fixture::new(
        "atomic",
        HEADER,
        &format!("{HEADER}\nmsgid \"Hi\"\nmsgstr \"Привет\"\n"),
    );
    let out = fx.root.join("runtime/patch_xx.dat");
    let rows = rows_of(&fx);
    write_dat(&rows, &out).expect("запись");
    assert_eq!(
        std::fs::read_to_string(&out).expect("чтение"),
        to_json_line(&rows[0]) + "\n"
    );
    assert!(!Path::new(&format!("{}.part", out.display())).exists());

    write_dat(&rows, &out).expect("перезапись");
    write_dat(&[], &out).expect("пустой словарь");
    assert_eq!(std::fs::read_to_string(&out).expect("чтение"), "");
    assert!(!Path::new(&format!("{}.part", out.display())).exists());
}

#[test]
fn gated_победитель_скрывает_текст_целиком() {
    // Характеризация поведения Python-версии: гейт смотрит только на filled[0].
    let fx = Fixture::new(
        "gated-mixed",
        HEADER,
        &format!(
            "{HEADER}\n#: translations/a.yaml\n#, auto-normalized\nmsgid \"X\"\nmsgstr \"Икс\"\n\n\
             #: translations/b.yaml\nmsgid \"X\"\nmsgstr \"ИКС\"\n"
        ),
    );
    let (rows, report) = build_dat("xx", &fx.root).expect("сборка");
    assert!(rows.is_empty());
    assert_eq!(report.gated_auto_normalized, 1);
}
