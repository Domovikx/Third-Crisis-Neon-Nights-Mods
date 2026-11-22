//! potgen: золотой POT мини-дампа (сгенерён TS-эталоном) и границы CLI-контракта.

use std::path::{Path, PathBuf};

use rust_l10n::potgen::{run, PotgenOptions};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn tiny_dump() -> PathBuf {
    repo().join(".opencode/skills/extract-text/test_data/tiny-dump")
}

fn golden() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/template.tiny.pot")
}

fn out_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rust-l10n-potgen-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("каталог");
    dir
}

#[test]
fn мини_дамп_совпадает_с_ts_эталоном_побайтово() {
    let dir = out_dir("golden");
    let out = dir.join("template.pot");
    let mut options = PotgenOptions::new(&dir);
    options.dump_dir = tiny_dump();
    options.out_path = Some(out.clone());
    options.created = Some("2026-01-02 03:04+0000".to_string());

    let res = run(&options).expect("potgen прошёл");
    assert_eq!(res.entries, 10);
    assert_eq!(
        res.stats.merged_twins, 2,
        "ui-двойники бандл-строки и спикера удалены"
    );
    assert_eq!(res.stats.rich, 1);

    let actual = std::fs::read_to_string(&out).expect("POT записан");
    let expected = std::fs::read_to_string(golden()).expect("золотой POT есть");
    assert_eq!(actual, expected, "POT должен совпасть с TS-эталоном");

    assert!(!Path::new(&format!("{}.part", out.display())).exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn отсутствие_дампа_ошибка_без_файла() {
    let dir = out_dir("missing");
    let out = dir.join("out/template.pot");
    let mut options = PotgenOptions::new(&dir);
    options.dump_dir = dir.join("no-dump");
    options.out_path = Some(out.clone());
    let err = run(&options).expect_err("должна быть ошибка");
    assert!(err.contains("dump not found"), "{err}");
    assert!(!out.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn пустой_дамп_ошибка() {
    let dir = out_dir("empty");
    let dump = dir.join("dump");
    std::fs::create_dir_all(&dump).expect("каталог дампа");
    let out = dir.join("out/template.pot");
    let mut options = PotgenOptions::new(&dir);
    options.dump_dir = dump;
    options.out_path = Some(out.clone());
    let err = run(&options).expect_err("должна быть ошибка");
    assert!(err.contains("empty dump"), "{err}");
    assert!(!out.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn дата_в_формате_python_strftime() {
    use std::time::{Duration, UNIX_EPOCH};
    assert_eq!(
        rust_l10n::potgen::format_pot_date(UNIX_EPOCH + Duration::from_secs(1_767_323_040)),
        "2026-01-02 03:04+0000"
    );
    assert_eq!(
        rust_l10n::potgen::format_pot_date(UNIX_EPOCH),
        "1970-01-01 00:00+0000"
    );
}

#[test]
fn font_и_material_вырезаются_цвет_остаётся() {
    use rust_l10n::potgen::strip_font_tags;
    assert_eq!(
        strip_font_tags("<color=#EB83FF><font=\"F\" material=\"M\">Hey</font></color>"),
        "<color=#EB83FF>Hey</color>"
    );
    assert_eq!(strip_font_tags("<FONT size=3>x</FONT>"), "x");
    assert_eq!(strip_font_tags("plain"), "plain");
}
