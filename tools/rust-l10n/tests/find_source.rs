//! find_source: порт TS-тестов (`.opencode/skills/extract-text/tests/find_source.test.mts`).
//!
//! Дамп — фикстура `tests/data/tiny-dump` (копия TS-фикстуры, без игры).
//! Покрыто: точный матч, порядок вхождений, `--first`, формат строки, срез
//! 120 code points, провенанс инвентаря, коды выхода CLI 0/1/2.

use std::path::{Path, PathBuf};
use std::process::Command;

use rust_l10n::find_source::{find, fmt, has_dump};
use rust_l10n::inventory::{scan_dump, InventoryItem, ItemKind};

fn dump() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/tiny-dump")
}

fn item(
    kind: ItemKind,
    source: &str,
    idx: Option<usize>,
    speaker: &str,
    text: &str,
) -> InventoryItem {
    InventoryItem {
        text: text.to_string(),
        speaker: speaker.to_string(),
        rich_text: String::new(),
        kind,
        source: source.to_string(),
        idx,
    }
}

#[test]
fn точный_матч_находит_все_вхождения_в_порядке_инвентаря() {
    let hits = find("Where are you going now, my dear friend?", &dump(), false).expect("скан");
    let got: Vec<(String, String, Option<usize>, String)> = hits
        .iter()
        .map(|h| {
            (
                h.kind.as_str().to_string(),
                h.source.clone(),
                h.idx,
                h.speaker.clone(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (
                "bundle".to_string(),
                "bundle_tiny".to_string(),
                Some(0),
                "Zoey".to_string()
            ),
            (
                "raw".to_string(),
                "bundle_tiny_assets_all_abc123".to_string(),
                Some(1),
                String::new()
            ),
        ]
    );
}

#[test]
fn first_останавливается_на_первом_вхождении() {
    let hits = find("Where are you going now, my dear friend?", &dump(), true).expect("скан");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].kind, ItemKind::Bundle);
}

#[test]
fn совпадение_только_точное() {
    assert!(
        find("where are you going now, my dear friend?", &dump(), false)
            .expect("скан")
            .is_empty()
    );
    assert!(find("Welcome", &dump(), false).expect("скан").is_empty());
    let exact = find("Welcome back, Sarah.", &dump(), false).expect("скан");
    assert_eq!(exact.len(), 1, "дубликат внутри объекта дедуплицирован");
    assert_eq!(exact[0].kind, ItemKind::Dlg);
    assert_eq!(exact[0].idx, Some(0));
    assert_eq!(exact[0].source, "900", "провенанс диалога — path_id");
}

#[test]
fn fmt_kind_source_idx_speaker_и_текст() {
    assert_eq!(
        fmt(&item(ItemKind::Dlg, "73203", Some(0), "Zoey", "Hi")),
        "[dlg:73203#0] speaker=Zoey :: Hi"
    );
    assert_eq!(
        fmt(&item(ItemKind::Spk, "Zoey", None, "", "Zoey")),
        "[spk:Zoey] :: Zoey",
        "idx = None → без #idx"
    );
    assert_eq!(
        fmt(&item(
            ItemKind::Set,
            "globalgamemanagers",
            Some(423),
            "",
            "New Game"
        )),
        "[set:globalgamemanagers#423] :: New Game"
    );
}

#[test]
fn fmt_режет_текст_до_120_code_points() {
    let long = format!("{}😀tail", "a".repeat(119));
    let line = fmt(&item(ItemKind::Raw, "x", None, "", &long));
    let payload = &line[line.find(" :: ").expect("разделитель") + 4..];
    assert_eq!(payload.chars().count(), 120);
    assert_eq!(payload, format!("{}😀", "a".repeat(119)));
}

#[test]
fn провенанс_покрывает_все_виды_источников() {
    let inventory = scan_dump(&dump()).expect("скан");
    let kinds: Vec<ItemKind> = inventory.items.iter().map(|i| i.kind).collect();
    for kind in [
        ItemKind::Dlg,
        ItemKind::Bundle,
        ItemKind::Spk,
        ItemKind::Set,
        ItemKind::Raw,
        ItemKind::Fsm,
    ] {
        assert!(kinds.contains(&kind), "нет вида {kind:?} в инвентаре");
    }
    // Имена спикеров несут source = сам текст и не имеют индекса.
    let spk = inventory
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Spk)
        .expect("спикер");
    assert_eq!(spk.source, spk.text);
    assert_eq!(spk.idx, None);
    // Короткое имя бандла — без хэша.
    let bundle = inventory
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Bundle)
        .expect("бандл");
    assert_eq!(bundle.source, "bundle_tiny");
}

#[test]
fn has_dump_видит_пустой_и_отсутствующий_каталог() {
    assert!(has_dump(&dump()));
    assert!(!has_dump(&dump().join("no-such-dir")));
    let empty = std::env::temp_dir().join(format!("rust-l10n-empty-dump-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&empty);
    std::fs::create_dir_all(&empty).expect("каталог");
    assert!(!has_dump(&empty), "пустой каталог = дампа нет");
    let _ = std::fs::remove_dir_all(&empty);
}

// --- CLI: коды выхода и вывод (через собранный бинарь) ---

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_rust-l10n")
}

fn run(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(bin()).args(args).output().expect("запуск");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn cli_найденные_строки_код_0_и_вывод_в_stdout() {
    let (code, out, err) = run(&[
        "find_source",
        "New Game",
        "--dump",
        dump().to_str().expect("путь"),
    ]);
    assert_eq!(code, 0, "stderr: {err}");
    assert_eq!(out, "[set:globalgamemanagers#0] :: New Game\n");
    assert!(err.is_empty(), "stderr: {err}");
}

#[test]
fn cli_first_даёт_одну_строку() {
    let (code, out, _) = run(&[
        "find_source",
        "Zoey",
        "--first",
        "--dump",
        dump().to_str().expect("путь"),
    ]);
    assert_eq!(code, 0);
    assert_eq!(out, "[spk:Zoey] :: Zoey\n");
}

#[test]
fn cli_ничего_не_найдено_код_1() {
    let (code, out, err) = run(&[
        "find_source",
        "no such line",
        "--dump",
        dump().to_str().expect("путь"),
    ]);
    assert_eq!(code, 1);
    assert!(out.is_empty());
    assert!(err.contains("no occurrences"), "stderr: {err}");
}

#[test]
fn cli_пустой_дамп_код_1() {
    let (code, _, err) = run(&[
        "find_source",
        "anything",
        "--dump",
        dump().join("no-such-dir").to_str().expect("путь"),
    ]);
    assert_eq!(code, 1);
    assert!(err.contains("empty or missing"), "stderr: {err}");
}

#[test]
fn cli_без_аргумента_код_2_help_код_0() {
    assert_eq!(run(&["find_source"]).0, 2);
    assert_eq!(run(&["find_source", "--help"]).0, 0);
    assert_eq!(run(&["find_source", "--dump"]).0, 2, "флаг без значения");
}
