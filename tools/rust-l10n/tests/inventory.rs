//! Инвентарь: порядок пунктов и классификация на мини-дампе из TS-тестов.

use std::path::PathBuf;

use rust_l10n::inventory::{scan_dump, ItemKind};

fn tiny_dump() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.opencode/skills/extract-text/test_data/tiny-dump")
}

#[test]
fn мини_дамп_порядок_виды_и_цвета() {
    let inventory = scan_dump(&tiny_dump()).expect("дамп читается");
    let got: Vec<(&str, ItemKind)> = inventory
        .items
        .iter()
        .map(|i| (i.text.as_str(), i.kind))
        .collect();
    assert_eq!(
        got,
        vec![
            ("Welcome back, Sarah.", ItemKind::Dlg),
            ("Where are you going now, my dear friend?", ItemKind::Bundle),
            ("Zoey", ItemKind::Spk),
            ("New Game", ItemKind::Set),
            ("Options", ItemKind::Set),
            // Строка бандла тоже чанк: её raw_strings идут в UI-инвентарь
            // (потом ui-двойники удалит каталог POT).
            ("Tiny", ItemKind::Raw),
            ("Where are you going now, my dear friend?", ItemKind::Raw),
            ("Zoey", ItemKind::Raw),
            ("Dialogue Log", ItemKind::Raw),
            ("BACK", ItemKind::Raw),
            ("ColorParserList", ItemKind::Raw),
            ("Ask about her Arm", ItemKind::Fsm),
        ],
        "порядок finish(): dlg → bundle → spk → set → raw → fsm"
    );
    assert_eq!(
        inventory.items[0].rich_text, "<color=#EB83FF>Welcome back, Sarah.</color>",
        "именованный цвет разрешён из color_parser_list"
    );
    assert_eq!(inventory.items[1].speaker, "Zoey");
    assert_eq!(inventory.items[1].rich_text, "");
}

#[test]
fn провенанс_мини_дампа_по_источникам() {
    let inventory = scan_dump(&tiny_dump()).expect("дамп читается");
    let got: Vec<(&str, &str)> = inventory
        .items
        .iter()
        .map(|i| (i.text.as_str(), i.src.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("Welcome back, Sarah.", "dialog"),
            ("Where are you going now, my dear friend?", "bundle"),
            ("Zoey", "dialog"),
            ("New Game", "settings"),
            ("Options", "settings"),
            // Типизированное поле бандла точнее raw-скана.
            ("Tiny", "field:m_Name"),
            (
                "Where are you going now, my dear friend?",
                "raw:MonoBehaviour"
            ),
            ("Zoey", "raw:MonoBehaviour"),
            ("Dialogue Log", "raw:MonoBehaviour"),
            ("BACK", "raw:MonoBehaviour"),
            ("ColorParserList", "raw:MonoBehaviour"),
            ("Ask about her Arm", "field:fsm"),
        ]
    );
    assert!(got
        .iter()
        .all(|(_, src)| rust_l10n::inventory::is_valid_src(src)));
}

#[test]
fn провенанс_различает_settings_us_и_поле_по_type_tree() {
    let dir = std::env::temp_dir().join(format!("rust-l10n-src-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("каталог");
    std::fs::write(
        dir.join("summaries.jsonl"),
        concat!(
            r#"{"asset":"Assembly-CSharp.dll","format":"dotnet_us_heap","settings_keys":["#,
            r#"{"key":"Settings.EnableVSync","display":"Enable VSync"},"#,
            r#"{"key":"Load Game","display":"Load Game"}]}"#,
            "\n",
            r#"{"asset":"level0","settings_keys":[{"key":"Settings.Volume","display":"Volume"}]}"#,
            "\n",
        ),
    )
    .expect("summaries");
    std::fs::write(
        dir.join("level0.jsonl"),
        concat!(
            r#"{"asset":"level0","type":"MonoBehaviour","strings":{"m_Name":"Panel"},"#,
            r#""fields":{"m_Labels":["Start Game","Continue"]},"#,
            r#""raw_strings":["Panel","Start Game","Continue","Raw Only Label"]}"#,
            "\n",
        ),
    )
    .expect("level0");

    let inventory = scan_dump(&dir).expect("дамп читается");
    let got: Vec<(&str, &str)> = inventory
        .items
        .iter()
        .map(|i| (i.text.as_str(), i.src.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("Enable VSync", "settings"),
            ("Load Game", "us"),
            ("Volume", "settings"),
            ("Panel", "field:m_Name"),
            ("Start Game", "field:m_Labels"),
            ("Continue", "field:m_Labels"),
            ("Raw Only Label", "raw:MonoBehaviour"),
        ],
        "DLL #US-строки без Settings.* — us; значения type tree — field:<Имя>"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn отсутствующий_дамп_даёт_понятную_ошибку() {
    let err = scan_dump(&tiny_dump().join("nope")).expect_err("должна быть ошибка");
    assert!(err.contains("dump not found"), "{err}");
}

#[test]
fn пустой_каталог_дампа_даёт_пустой_инвентарь() {
    let dir = std::env::temp_dir().join(format!("rust-l10n-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("каталог");
    let inventory = scan_dump(&dir).expect("пустой дамп читается");
    assert!(inventory.items.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
