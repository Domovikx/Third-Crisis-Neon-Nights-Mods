//! potgen: золотой POT мини-дампа (сгенерён TS-эталоном) и границы CLI-контракта.

use std::path::{Path, PathBuf};

use rust_l10n::potgen::{
    apply_src_policy, discover_policy_path, parse_src_policy, policy_decision,
    render_excluded_jsonl, run, src_matches_pattern, validate_policy_pattern, PolicySource,
    PotgenOptions, SrcPolicy, KNOWN_RAW_CLASSES,
};

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
    // Золотой POT — состояние ДО политики: discovery выключен явно.
    options.policy = PolicySource::Disabled;

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

// ---------------------------------------------------------------------------
// Политика отбора по провенансу.
// ---------------------------------------------------------------------------

fn tiny_catalog() -> rust_l10n::potgen::Catalog {
    use rust_l10n::inventory::{scan_dump, InventoryItem};
    let inventory = scan_dump(&tiny_dump()).expect("мини-дамп читается");
    let items: Vec<InventoryItem> = inventory.items;
    let (catalog, _stats) = rust_l10n::potgen::build_catalog(&items, &Default::default());
    catalog
}

#[test]
fn префиксы_и_точные_метки_совпадают_как_в_ts() {
    assert!(src_matches_pattern("*", "raw:Font"));
    assert!(src_matches_pattern("raw:Font", "raw:Font"));
    assert!(!src_matches_pattern("raw:Font", "raw:FontX"));
    assert!(src_matches_pattern("raw:Tex*", "raw:Texture2D"));
    assert!(src_matches_pattern("raw:*", "raw:Anything"));
    assert!(!src_matches_pattern("raw:*", "dialog"));

    let policy = parse_src_policy(r#"{"exclude":["raw:Font","raw:Tex*"]}"#, "p").expect("политика");
    assert_eq!(
        policy_decision(&policy, "raw:Font").as_deref(),
        Some("exclude:raw:Font")
    );
    assert_eq!(
        policy_decision(&policy, "raw:Texture2D").as_deref(),
        Some("exclude:raw:Tex*")
    );
    assert_eq!(policy_decision(&policy, "raw:MonoBehaviour"), None);

    let whitelist = parse_src_policy(r#"{"include":["dialog","raw:*"]}"#, "p").expect("политика");
    assert_eq!(
        policy_decision(&whitelist, "settings").as_deref(),
        Some("not-included")
    );
    assert_eq!(policy_decision(&whitelist, "raw:Font"), None);
}

#[test]
fn шаблоны_валидируются_и_опечатка_это_ошибка() {
    for ok in [
        "*",
        "dialog",
        "raw:Font",
        "raw:Tex*",
        "raw:*",
        "field:m_Name",
        "field:*",
        "dialog*",
        "raw:ClassID0*",
    ] {
        assert!(
            validate_policy_pattern(ok).is_ok(),
            "должно быть валидно: {ok}"
        );
    }
    for bad in ["", "raw:", "dilog", "raw:Fontt", "raw:Zzz*", "field:1bad"] {
        assert!(
            validate_policy_pattern(bad).is_err(),
            "должно быть ошибкой: {bad}"
        );
    }
}

#[test]
fn политика_пустая_или_невалидная_ошибки_понятные() {
    let empty = parse_src_policy("{}", "empty.json").expect("пустая политика");
    assert!(empty.exclude.is_empty());
    assert_eq!(empty.include, vec!["*".to_string()]);

    let bad_json = parse_src_policy("{\"exclude\": [", "bad.json").expect_err("битый JSON");
    assert!(
        bad_json.contains("невалидный JSON политики bad.json"),
        "{bad_json}"
    );

    let bad_key = parse_src_policy(r#"{"exlude":["raw:Font"]}"#, "p").expect_err("опечатка");
    assert!(bad_key.contains("неизвестное поле \"exlude\""), "{bad_key}");

    let bad_label = parse_src_policy(r#"{"exclude":["raw:Fontt"]}"#, "p").expect_err("метка");
    assert!(
        bad_label.contains("неизвестная метка \"raw:Fontt\""),
        "{bad_label}"
    );

    let empty_include = parse_src_policy(r#"{"include":[]}"#, "p").expect_err("include");
    assert!(empty_include.contains("include"), "{empty_include}");
}

#[test]
fn применение_политики_уносит_записи_в_журнал() {
    let catalog = tiny_catalog();
    assert_eq!(rust_l10n::potgen::catalog_size(&catalog), 10);
    let policy = SrcPolicy {
        path: "p".to_string(),
        exclude: vec!["raw:MonoBehaviour".to_string()],
        include: vec!["*".to_string()],
    };
    let (kept, excluded, by_src) = apply_src_policy(catalog, &policy);

    assert_eq!(rust_l10n::potgen::catalog_size(&kept), 7);
    assert_eq!(excluded.len(), 3);
    assert!(excluded.iter().all(|e| e.src == "raw:MonoBehaviour"));
    assert!(excluded
        .iter()
        .all(|e| e.reason == "exclude:raw:MonoBehaviour"));
    assert!(excluded.iter().any(|e| e.msgid == "BACK"));
    assert_eq!(by_src, vec![("raw:MonoBehaviour".to_string(), 3)]);

    let jsonl = render_excluded_jsonl(&excluded).expect("журнал");
    let lines: Vec<&str> = jsonl.lines().collect();
    assert_eq!(lines.len(), 3);
    assert!(
        lines[0].starts_with("{\"src\":\"raw:MonoBehaviour\",\"msgid\":"),
        "{}",
        lines[0]
    );
    assert!(jsonl.ends_with('\n'));
}

#[test]
fn прогон_с_политикой_пишет_журнал_и_не_пишет_исключённое() {
    let dir = out_dir("policy");
    let policy_path = dir.join("policy.json");
    std::fs::write(&policy_path, r#"{"exclude":["raw:MonoBehaviour"]}"#).expect("политика");
    let out = dir.join("template.pot");
    let excluded_path = dir.join("excluded.jsonl");

    let mut options = PotgenOptions::new(&dir);
    options.dump_dir = tiny_dump();
    options.out_path = Some(out.clone());
    options.created = Some("2026-01-02 03:04+0000".to_string());
    options.policy = PolicySource::Path(policy_path.clone());
    options.excluded_path = Some(excluded_path.clone());

    let res = run(&options).expect("potgen с политикой");
    assert_eq!(res.entries, 7);
    assert_eq!(res.policy.as_ref().map(|p| p.excluded), Some(3));
    assert_eq!(
        res.policy.as_ref().map(|p| p.by_src.clone()),
        Some(vec![("raw:MonoBehaviour".to_string(), 3)])
    );
    let pot = std::fs::read_to_string(&out).expect("POT");
    assert!(!pot.contains("msgid \"BACK\""), "исключённой записи нет");
    assert!(pot.contains("msgid \"New Game\""), "остальные на месте");
    let log = std::fs::read_to_string(&excluded_path).expect("журнал");
    assert_eq!(log.lines().count(), 3);
    assert!(log.lines().all(|l| l.contains("exclude:raw:MonoBehaviour")));
    assert!(!Path::new(&format!("{}.part", excluded_path.display())).exists());

    // Выключенная политика: POT как до неё, журнал не пишется.
    let out_off = dir.join("off.pot");
    let mut off = PotgenOptions::new(&dir);
    off.dump_dir = tiny_dump();
    off.out_path = Some(out_off.clone());
    off.created = Some("2026-01-02 03:04+0000".to_string());
    off.policy = PolicySource::Disabled;
    let off_res = run(&off).expect("potgen без политики");
    assert_eq!(off_res.entries, 10);
    assert!(off_res.policy.is_none());
    assert!(off_res.excluded_path.is_none());
    assert_eq!(
        std::fs::read_to_string(&out_off).expect("POT"),
        std::fs::read_to_string(golden()).expect("golden")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn политика_находится_от_корня_репозитория() {
    let found = discover_policy_path(&repo()).expect("config/pot-src-policy.json");
    assert!(
        found.ends_with("config/pot-src-policy.json"),
        "{}",
        found.display()
    );
    let policy = rust_l10n::potgen::load_src_policy(&found, true)
        .expect("читается")
        .expect("есть");
    assert_eq!(
        policy.exclude,
        vec![
            "raw:Font".to_string(),
            "raw:Mesh".to_string(),
            "raw:MonoScript".to_string(),
            "raw:Texture2D".to_string(),
            "raw:Sprite".to_string(),
            "raw:TextAsset".to_string()
        ]
    );
}

#[test]
fn known_raw_classes_совпадают_с_дампером_и_ts() {
    let unity = std::fs::read_to_string(
        repo().join(".opencode/skills/dump-assets/scripts/unity_classes.mts"),
    )
    .expect("unity_classes.mts");
    let mut dumped: Vec<String> = Vec::new();
    for line in unity.lines() {
        let Some(pos) = line.find(": \"") else {
            continue;
        };
        let rest = &line[pos + 3..];
        let Some(end) = rest.find('"') else { continue };
        dumped.push(rest[..end].to_string());
    }
    let ours: Vec<&str> = KNOWN_RAW_CLASSES
        .iter()
        .copied()
        .filter(|n| *n != "unknown")
        .collect();
    let mut a = ours.clone();
    let mut b: Vec<&str> = dumped.iter().map(String::as_str).collect();
    a.sort_unstable();
    b.sort_unstable();
    assert_eq!(a, b, "Rust-список классов разошёлся с unity_classes.mts");

    let ts =
        std::fs::read_to_string(repo().join(".opencode/skills/extract-text/scripts/potgen.mts"))
            .expect("potgen.mts");
    let start = ts
        .find("export const KNOWN_RAW_CLASSES")
        .expect("TS-список");
    let block = &ts[start..start + ts[start..].find("];").expect("конец списка")];
    let mut from_ts: Vec<&str> = Vec::new();
    let mut rest = block;
    while let Some(open) = rest.find('"') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('"') else { break };
        let name = &after[..close];
        if KNOWN_RAW_CLASSES.contains(&name) {
            from_ts.push(name);
        }
        rest = &after[close + 1..];
    }
    let mut c: Vec<&str> = KNOWN_RAW_CLASSES.to_vec();
    let mut d = from_ts;
    c.sort_unstable();
    d.sort_unstable();
    assert_eq!(c, d, "TS- и Rust-списки классов разошлись");
}

// ---------------------------------------------------------------------------
// Skip-политика («перевод не нужен»): метки в POT, журнал, ошибки данных.
// ---------------------------------------------------------------------------

#[test]
fn skip_политика_разбирается_и_ошибки_не_молчат() {
    use rust_l10n::potgen::{parse_skip_policy, SkipPolicy};
    let policy: SkipPolicy = parse_skip_policy(
        r#"{"rules":[{"id":"no-letters","src":"raw:*","when":"noLetters"}]}"#,
        "p.json",
    )
    .expect("валидная политика");
    assert_eq!(policy.rules.len(), 1);
    assert_eq!(policy.rules[0].id, "no-letters");
    assert!(policy.rules[0].enabled);

    let bad_when = parse_skip_policy(
        r#"{"rules":[{"id":"x","src":"raw:*","when":"nope"}]}"#,
        "p.json",
    )
    .expect_err("неизвестное условие");
    assert!(
        bad_when.contains("неизвестное условие \"nope\""),
        "{bad_when}"
    );

    let bad_src = parse_skip_policy(
        r#"{"rules":[{"id":"x","src":"raw:Fontt","when":"noLetters"}]}"#,
        "p.json",
    )
    .expect_err("опечатка метки");
    assert!(
        bad_src.contains("неизвестная метка \"raw:Fontt\""),
        "{bad_src}"
    );

    let dup = parse_skip_policy(
        r#"{"rules":[{"id":"x","src":"*","when":"noLetters"},{"id":"x","src":"*","when":"fragment"}]}"#,
        "p.json",
    )
    .expect_err("дубль id");
    assert!(dup.contains("повторяется"), "{dup}");

    let bad_key = parse_skip_policy(r#"{"rules":[],"rulez":[]}"#, "p.json").expect_err("поле");
    assert!(bad_key.contains("неизвестное поле \"rulez\""), "{bad_key}");

    let disabled = parse_skip_policy(
        r#"{"rules":[{"id":"x","src":"*","when":"fragment","enabled":false}]}"#,
        "p",
    )
    .expect("enabled=false");
    assert!(!disabled.rules[0].enabled);
}

fn tiny_skip_policy(text: &str) -> rust_l10n::potgen::SkipPolicy {
    rust_l10n::potgen::parse_skip_policy(text, "p.json").expect("политика")
}

#[test]
fn skip_политика_помечает_записи_и_пишет_журнал_в_порядке_pot() {
    use rust_l10n::potgen::{
        apply_skip_policy, catalog_size, render_pot, render_skip_journal_jsonl,
    };

    let mut catalog = tiny_catalog();
    // Политика только по коротким токенам raw — как боевые настройки.
    let policy =
        tiny_skip_policy(r#"{"rules":[{"id":"short-token","src":"raw:*","when":"shortToken"}]}"#);
    let (marked, journal, by_rule) = apply_skip_policy(&mut catalog, &policy);
    assert_eq!(catalog_size(&catalog), 10, "записи не удаляются");
    assert!(marked > 0, "мини-дамп содержит короткие raw-токены");
    assert_eq!(by_rule, vec![("short-token".to_string(), marked)]);
    assert_eq!(journal.len(), marked);
    // Журнал — по порядку POT (msgid, msgctxt).
    let mut sorted = journal.clone();
    sorted.sort_by(|a, b| {
        a.msgid
            .cmp(&b.msgid)
            .then_with(|| a.msgctxt.cmp(&b.msgctxt))
    });
    assert_eq!(journal, sorted);

    let pot = render_pot(&catalog, "2026-01-02 03:04+0000");
    assert!(pot.contains("#, skip\n"), "{pot}");
    assert!(pot.contains("#. skip: short-token\n"), "{pot}");
    // Помеченная запись осталась в POT.
    for entry in &journal {
        assert!(
            pot.contains(&format!("msgid \"{}\"", entry.msgid)),
            "{}",
            entry.msgid
        );
    }

    let jsonl = render_skip_journal_jsonl(&journal).expect("журнал");
    assert!(jsonl.ends_with('\n'));
    assert_eq!(jsonl.lines().count(), marked);
}

#[test]
fn skip_выключенная_политика_не_меняет_pot() {
    let dir = out_dir("skip-off");
    let mut options = PotgenOptions::new(&dir);
    options.dump_dir = tiny_dump();
    options.out_path = Some(dir.join("template.pot"));
    options.created = Some("2026-01-02 03:04+0000".to_string());
    options.policy = PolicySource::Disabled;
    options.skip_policy = PolicySource::Disabled;
    let res = run(&options).expect("potgen");
    assert!(res.skip.is_none());
    assert!(res.skip_journal_path.is_none());
    let pot = std::fs::read_to_string(&res.out_path).expect("POT");
    assert!(!pot.contains("#, skip"), "{pot}");
    assert_eq!(
        pot,
        std::fs::read_to_string(golden()).expect("golden"),
        "без skip-политики POT = золотой"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
