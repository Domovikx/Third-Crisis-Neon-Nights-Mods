//! rust-l10n — текстовый пайплайн POT/`.dat` (Rust-исполнитель TS-эталонов).
//!
//! Подкоманды:
//!   rust-l10n potgen [--update] [--dump <dir>] [--out <path>] [--created <date>]
//!                    [--root <dir>]
//!   rust-l10n po2dat [lang] [--root <dir>] [--out <path>]
//!
//! TS-реализации (`potgen.mts`, `po2dat.mts`) остаются эталонами-оракулами:
//! паритет проверяется: побайтовым сравнением артефактов (`npm run test` /
//! `scripts/text_parity.test.mts`).
//!
//! Один бинарь с подкомандами, а не два крейта: обе команды делят PO-парсер и
//! запускаются из одного npm-скрипта, а сборка/CI-джоб/путь к exe — одни.

use std::path::PathBuf;
use std::process::ExitCode;

use rust_l10n::find_source::{self, FindSourceOptions};
use rust_l10n::po2dat::{self, DatReport};
use rust_l10n::po_update::{self, DupRule, PoUpdateOptions};
use rust_l10n::potgen::{self, PotgenOptions};
use rust_l10n::prefill::{self, PrefillOptions};
use rust_l10n_core::json::quoted;

const USAGE: &str = "\
rust-l10n — текстовый пайплайн локализации (POT/PO/DAT)

Использование:
  rust-l10n potgen [--update] [--dump <dir>] [--out <path>] [--created <date>]
                   [--root <dir>]
      --update        записать <root>/po/template.pot (без флага — только tmp/potgen/)
      --dump <dir>    каталог JSONL-дампа (по умолчанию <root>/tmp/dump)
      --out <path>    явный путь результата (перебивает --update)
      --created <s>   фиксированная дата заголовка (тесты/паритет)
      --root <dir>    корень репозитория (по умолчанию текущий каталог)

  rust-l10n po2dat [lang] [--root <dir>] [--out <path>]
      lang            код языка (по умолчанию ru)
      --out <path>    куда писать .dat (по умолчанию <root>/runtime/patch_<lang>.dat)

  rust-l10n po_update [lang] [--po-dir <dir>] [--root <dir>]
                      [--dup-rule last|earliest-ref] [--json <path>] [--no-backup]
      lang            язык перевода (по умолчанию ru)
      --po-dir <dir>  каталог с template.pot и <lang>.po (по умолчанию <root>/po)
      --dup-rule <r>  выбор при дубле ключа: last (по умолчанию, как TS-эталон)
                      или earliest-ref (как рантайм po2dat)
      --json <path>   полный отчёт слияния (выпавшие ключи, сироты) в JSON
      --no-backup     не писать <lang>.po.bak

  rust-l10n prefill [lang] [--po-dir <dir>] [--corpus <dir>] [--root <dir>]
                    [--created <date>] [--json <path>]
      lang            язык перевода (по умолчанию ru)
      --po-dir <dir>  каталог с template.pot и <lang>.po (по умолчанию <root>/po)
      --corpus <dir>  корень YAML-корпуса (по умолчанию <po-dir>/../translations)
      --created <s>   фиксированная дата заголовка (тесты/паритет), формат
                      YYYY-MM-DD ЧЧ:ММ
      --json <path>   полный отчёт предзаполнения в JSON

  rust-l10n find_source \"<msgid text>\" [--first] [--dump <dir>] [--root <dir>]
      --first         остановиться на первом вхождении
      --dump <dir>    каталог JSONL-дампа (по умолчанию <root>/tmp/dump)

  rust-l10n --help    эта справка
";

/// Значение флага: `--flag value` и `--flag=value`.
fn flag_value(argv: &[String], i: &mut usize, name: &str) -> Result<String, String> {
    let arg = &argv[*i];
    if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
        if value.is_empty() {
            return Err(format!("{name}: нужно значение"));
        }
        return Ok(value.to_string());
    }
    if *i + 1 >= argv.len() {
        return Err(format!("{name}: нужно значение"));
    }
    *i += 1;
    Ok(argv[*i].clone())
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = argv.first() else {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    };
    match command.as_str() {
        "--help" | "-h" | "help" => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        "potgen" => ExitCode::from(potgen_cli(&argv[1..])),
        "po2dat" => ExitCode::from(po2dat_cli(&argv[1..])),
        "po_update" => ExitCode::from(po_update_cli(&argv[1..])),
        "prefill" => ExitCode::from(prefill_cli(&argv[1..])),
        "find_source" => ExitCode::from(find_source_cli(&argv[1..])),
        other => {
            eprintln!("rust-l10n: неизвестная подкоманда: {other}\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// potgen: 0 — успех, 1 — ошибка обработки, 2 — ошибка аргументов.
fn potgen_cli(argv: &[String]) -> u8 {
    let mut options =
        PotgenOptions::new(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let mut help = false;
    let mut dump: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;

    let mut i = 0usize;
    while i < argv.len() {
        let arg = argv[i].as_str();
        let parsed = match arg {
            "--update" => {
                options.update = true;
                Ok(())
            }
            "--help" | "-h" => {
                help = true;
                Ok(())
            }
            "--dump" | "--out" | "--created" | "--root" => {
                let value = flag_value(argv, &mut i, arg);
                value.map(|value| match arg {
                    "--dump" => dump = Some(PathBuf::from(value)),
                    "--out" => out = Some(PathBuf::from(value)),
                    "--created" => options.created = Some(value),
                    _ => options.root = PathBuf::from(value),
                })
            }
            _ if arg.starts_with("--dump=")
                || arg.starts_with("--out=")
                || arg.starts_with("--created=")
                || arg.starts_with("--root=") =>
            {
                let name = arg.split('=').next().unwrap_or(arg);
                flag_value(argv, &mut i, name).map(|value| match name {
                    "--dump" => dump = Some(PathBuf::from(value)),
                    "--out" => out = Some(PathBuf::from(value)),
                    "--created" => options.created = Some(value),
                    _ => options.root = PathBuf::from(value),
                })
            }
            other => Err(format!("неизвестный аргумент: {other}")),
        };
        if let Err(message) = parsed {
            eprintln!("ERROR: {message}\n\n{USAGE}");
            return 2;
        }
        i += 1;
    }
    if help {
        eprint!("{USAGE}");
        return 0;
    }
    options.dump_dir = dump.unwrap_or_default();
    options.out_path = out;

    match potgen::run(&options) {
        Ok(res) => {
            let mode = if options.update { "update" } else { "dry" };
            eprintln!(
                "POT({mode}): {} entries -> {}",
                res.entries,
                res.out_path.display()
            );
            let s = &res.stats;
            eprintln!(
                "  inventory items: {}, new: {}, vanished: {}, triaged(classifier only): {}, rich: {}, merged twins: {}",
                s.scanned, s.new, s.vanished, s.triaged, s.rich, s.merged_twins
            );
            0
        }
        Err(message) => {
            eprintln!("ERROR: {message}");
            1
        }
    }
}

/// po2dat: 0 — успех, 1 — ошибка, 2 — ошибка аргументов.
fn po2dat_cli(argv: &[String]) -> u8 {
    let mut root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut out: Option<PathBuf> = None;
    let mut lang: Option<String> = None;
    let mut help = false;

    let mut i = 0usize;
    while i < argv.len() {
        let arg = argv[i].as_str();
        let parsed: Result<(), String> = match arg {
            "--help" | "-h" => {
                help = true;
                Ok(())
            }
            "--root" | "--out" => {
                let name = arg.to_string();
                flag_value(argv, &mut i, arg).map(|value| {
                    if name == "--out" {
                        out = Some(PathBuf::from(value));
                    } else {
                        root = PathBuf::from(value);
                    }
                })
            }
            _ if arg.starts_with("--root=") || arg.starts_with("--out=") => {
                let name = arg.split('=').next().unwrap_or(arg).to_string();
                flag_value(argv, &mut i, arg.split('=').next().unwrap_or(arg)).map(|value| {
                    if name == "--out" {
                        out = Some(PathBuf::from(value));
                    } else {
                        root = PathBuf::from(value);
                    }
                })
            }
            other if other.starts_with('-') => Err(format!("неизвестный флаг: {other}")),
            other if lang.is_some() => Err(format!("лишний аргумент: {other}")),
            other => {
                lang = Some(other.to_string());
                Ok(())
            }
        };
        if let Err(message) = parsed {
            eprintln!(
                "rust-l10n po2dat: {message}

{USAGE}"
            );
            return 2;
        }
        i += 1;
    }
    if help {
        eprint!("{USAGE}");
        return 0;
    }

    let lang = lang.unwrap_or_else(|| "ru".to_string());
    match po2dat::build_dat(&lang, &root) {
        Ok((rows, report)) => {
            let out_path =
                out.unwrap_or_else(|| root.join("runtime").join(format!("patch_{lang}.dat")));
            if let Err(message) = po2dat::write_dat(&rows, &out_path) {
                eprintln!("ERROR: {message}");
                return 1;
            }
            print_dat_report(&lang, rows.len(), &out_path, &report);
            0
        }
        Err(message) => {
            eprintln!("ERROR: {message}");
            1
        }
    }
}

fn print_dat_report(lang: &str, rows: usize, out_path: &std::path::Path, report: &DatReport) {
    eprintln!("patch_{lang}.dat: {rows} rows -> {}", out_path.display());
    eprintln!(
        "  po entries: {}, filled: {}, no rich_text: {}",
        report.po_entries, report.filled, report.no_rich
    );
    eprintln!(
        "  gated auto-normalized (awaiting human): {}",
        report.gated_auto_normalized
    );
    for (text, variants) in &report.dupes {
        let pairs: Vec<String> = variants
            .iter()
            .map(|(msgstr, ctxt)| format!("[{}, {}]", quoted(msgstr), quoted(ctxt)))
            .collect();
        let shown = format!("[{}]", pairs.join(", "));
        eprintln!("  DUPE {}: {shown}", quoted(text));
    }
}

/// Срез по code points (Python `s[:n]`), не по UTF-16 units.
fn cp_slice(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Сколько примеров показывать в консольном отчёте (полный список — в `--json`).
const REPORT_EXAMPLES: usize = 10;

/// po_update: 0 — успех, 1 — ошибка, 2 — ошибка аргументов.
fn po_update_cli(argv: &[String]) -> u8 {
    let root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut options = PoUpdateOptions::new(&root);
    let mut po_dir: Option<PathBuf> = None;
    let mut json: Option<PathBuf> = None;
    let mut help = false;

    let mut i = 0usize;
    while i < argv.len() {
        let arg = argv[i].as_str();
        let parsed: Result<(), String> = match arg {
            "--help" | "-h" => {
                help = true;
                Ok(())
            }
            "--no-backup" => {
                options.backup = false;
                Ok(())
            }
            "--po-dir" | "--root" | "--dup-rule" | "--json" => {
                let name = arg.to_string();
                flag_value(argv, &mut i, arg).map(|value| match name.as_str() {
                    "--po-dir" => po_dir = Some(PathBuf::from(value)),
                    "--root" => options.po_dir = PathBuf::from(&value).join("po"),
                    "--json" => json = Some(PathBuf::from(value)),
                    _ => options.dup_rule = DupRule::parse(&value).unwrap_or_default(),
                })
            }
            _ if arg.starts_with("--po-dir=")
                || arg.starts_with("--root=")
                || arg.starts_with("--dup-rule=")
                || arg.starts_with("--json=") =>
            {
                let name = arg.split('=').next().unwrap_or(arg).to_string();
                flag_value(argv, &mut i, &name).map(|value| match name.as_str() {
                    "--po-dir" => po_dir = Some(PathBuf::from(value)),
                    "--root" => options.po_dir = PathBuf::from(&value).join("po"),
                    "--json" => json = Some(PathBuf::from(value)),
                    _ => options.dup_rule = DupRule::parse(&value).unwrap_or_default(),
                })
            }
            other if other.starts_with('-') => Err(format!("неизвестный флаг: {other}")),
            "" => Ok(()),
            other => {
                options.lang = other.to_string();
                Ok(())
            }
        };
        if let Err(message) = parsed {
            eprintln!("rust-l10n po_update: {message}\n\n{USAGE}");
            return 2;
        }
        i += 1;
    }
    if help {
        eprint!("{USAGE}");
        return 0;
    }
    if let Some(dir) = po_dir {
        options.po_dir = dir;
    }

    match po_update::run_po_update(&options) {
        Ok(res) => {
            print_merge_report(&options.lang, &res, options.dup_rule);
            if let Some(path) = json {
                if let Err(message) =
                    po_update::write_atomic(&path, &po_update::report_to_json(&res.stats))
                {
                    eprintln!("ERROR: {message}");
                    return 1;
                }
                eprintln!("  отчёт: {} (полные списки выпавших/сирот)", path.display());
            }
            0
        }
        Err(message) => {
            eprintln!("ERROR: {message}");
            1
        }
    }
}

/// Отчёт слияния: счётчики, предупреждение о потерях, сироты поимённо.
fn print_merge_report(lang: &str, res: &po_update::PoUpdateResult, dup_rule: DupRule) {
    let s = &res.stats;
    let backup = if res.backup_path.is_some() {
        "backup .bak"
    } else {
        "без бэкапа"
    };
    eprintln!(
        "{lang}.po updated: carried={}, new={}, obsolete={}, retargeted={}, legacy_kept={}, \
orphans={}, dropped={}, dup_keys={} ({backup}) [{}]",
        s.carried,
        s.new,
        s.obsolete,
        s.retargeted,
        s.legacy_kept,
        s.orphans,
        s.dropped,
        s.dup_keys,
        res.po_path.display()
    );

    if s.dropped > 0 {
        eprintln!(
            "  WARNING: dropped={} — переводам некуда деться: ключ выпал из POT, а текст жив \
под уже переведённым контекстом (вариант отброшен)",
            s.dropped
        );
        for d in s.dropped_items.iter().take(REPORT_EXAMPLES) {
            eprintln!(
                "    DROPPED [{}] {} {} — {}\n      text alive under: {}",
                d.reason.as_str(),
                quoted(&d.key.1),
                quoted(&cp_slice(&d.key.0, 60)),
                quoted(&cp_slice(&d.msgstr, 60)),
                d.alive
                    .iter()
                    .map(|c| quoted(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        if s.dropped_items.len() > REPORT_EXAMPLES {
            eprintln!(
                "    … ещё {} (полный список: --json <path>)",
                s.dropped_items.len() - REPORT_EXAMPLES
            );
        }
    }
    if s.orphans > 0 {
        eprintln!(
            "  orphans={}: ключи в PO, которых больше нет в POT (помечены legacy, рантайм их \
пропускает) — переводить/удалять вручную",
            s.orphans
        );
        for o in s.orphan_items.iter().take(REPORT_EXAMPLES) {
            eprintln!(
                "    ORPHAN {} {}",
                quoted(&o.key.1),
                quoted(&cp_slice(&o.key.0, 60))
            );
        }
        if s.orphan_items.len() > REPORT_EXAMPLES {
            eprintln!(
                "    … ещё {} (полный список: --json <path>)",
                s.orphan_items.len() - REPORT_EXAMPLES
            );
        }
    }
    for r in &s.retarget_items {
        eprintln!(
            "  RETARGET {} {} -> {}",
            quoted(&cp_slice(&r.from.0, 50)),
            quoted(&r.from.1),
            quoted(&r.to.1)
        );
    }
    if s.dup_keys > 0 {
        eprintln!(
            "  dup_keys={}: ключ записан в PO несколько раз, выбран вариант по правилу \
'{}'",
            s.dup_keys,
            dup_rule.as_str()
        );
        for d in s.dup_items.iter().take(REPORT_EXAMPLES) {
            eprintln!(
                "    DUP [{}] {} variants: {} -> chosen {}",
                d.key.1,
                quoted(&cp_slice(&d.key.0, 50)),
                d.variants
                    .iter()
                    .map(|v| quoted(&cp_slice(v, 40)))
                    .collect::<Vec<_>>()
                    .join(", "),
                quoted(&cp_slice(&d.chosen, 40))
            );
        }
    }
}

/// prefill: 0 — успех, 1 — ошибка, 2 — ошибка аргументов.
fn prefill_cli(argv: &[String]) -> u8 {
    let root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut options = PrefillOptions::new(&root);
    let mut po_dir: Option<PathBuf> = None;
    let mut json: Option<PathBuf> = None;
    let mut help = false;

    let mut i = 0usize;
    while i < argv.len() {
        let arg = argv[i].as_str();
        let parsed: Result<(), String> = match arg {
            "--help" | "-h" => {
                help = true;
                Ok(())
            }
            "--po-dir" | "--corpus" | "--root" | "--created" | "--json" => {
                let name = arg.to_string();
                flag_value(argv, &mut i, arg).map(|value| match name.as_str() {
                    "--po-dir" => po_dir = Some(PathBuf::from(value)),
                    "--corpus" => options.corpus_dir = Some(PathBuf::from(value)),
                    "--root" => options.po_dir = PathBuf::from(&value).join("po"),
                    "--created" => options.created = Some(value),
                    _ => json = Some(PathBuf::from(value)),
                })
            }
            _ if arg.starts_with("--po-dir=")
                || arg.starts_with("--corpus=")
                || arg.starts_with("--root=")
                || arg.starts_with("--created=")
                || arg.starts_with("--json=") =>
            {
                let name = arg.split('=').next().unwrap_or(arg).to_string();
                flag_value(argv, &mut i, &name).map(|value| match name.as_str() {
                    "--po-dir" => po_dir = Some(PathBuf::from(value)),
                    "--corpus" => options.corpus_dir = Some(PathBuf::from(value)),
                    "--root" => options.po_dir = PathBuf::from(&value).join("po"),
                    "--created" => options.created = Some(value),
                    _ => json = Some(PathBuf::from(value)),
                })
            }
            other if other.starts_with('-') => Err(format!("неизвестный флаг: {other}")),
            "" => Ok(()),
            other => {
                options.lang = other.to_string();
                Ok(())
            }
        };
        if let Err(message) = parsed {
            eprintln!("rust-l10n prefill: {message}\n\n{USAGE}");
            return 2;
        }
        i += 1;
    }
    if help {
        eprint!("{USAGE}");
        return 0;
    }
    if let Some(dir) = po_dir {
        options.po_dir = dir;
    }

    match prefill::run_prefill(&options) {
        Ok(res) => {
            eprint!(
                "{}",
                prefill::format_report(&options.lang, &res.po_path, &res.report)
            );
            if let Some(path) = json {
                if let Err(message) =
                    po_update::write_atomic(&path, &prefill::report_to_json(&res.report))
                {
                    eprintln!("ERROR: {message}");
                    return 1;
                }
                eprintln!("  отчёт: {} (полные списки)", path.display());
            }
            0
        }
        Err(message) => {
            eprintln!("ERROR: {message}");
            1
        }
    }
}

/// find_source: 0 — найдено, 1 — нет/дамп пуст, 2 — ошибка аргументов.
fn find_source_cli(argv: &[String]) -> u8 {
    let root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut options = FindSourceOptions::new(&root);
    let mut has_text = false;
    let mut help = false;

    let mut i = 0usize;
    while i < argv.len() {
        let arg = argv[i].as_str();
        let parsed: Result<(), String> = match arg {
            "--first" => {
                options.first = true;
                Ok(())
            }
            "--help" | "-h" => {
                help = true;
                Ok(())
            }
            "--dump" | "--root" => {
                let name = arg.to_string();
                flag_value(argv, &mut i, arg).map(|value| {
                    if name == "--dump" {
                        options.dump_dir = PathBuf::from(value);
                    } else {
                        options.dump_dir = PathBuf::from(&value).join("tmp").join("dump");
                    }
                })
            }
            _ if arg.starts_with("--dump=") || arg.starts_with("--root=") => {
                let name = arg.split('=').next().unwrap_or(arg).to_string();
                flag_value(argv, &mut i, &name).map(|value| {
                    if name == "--dump" {
                        options.dump_dir = PathBuf::from(value);
                    } else {
                        options.dump_dir = PathBuf::from(&value).join("tmp").join("dump");
                    }
                })
            }
            // Как Python/TS: любой неизвестный флаг игнорируется.
            other if other.starts_with("--") => Ok(()),
            "" => Ok(()),
            // Как Python/TS: второй не-флаговый аргумент игнорируется.
            _ if has_text => Ok(()),
            other => {
                options.text = other.to_string();
                has_text = true;
                Ok(())
            }
        };
        if let Err(message) = parsed {
            eprintln!("rust-l10n find_source: {message}\n\n{USAGE}");
            return 2;
        }
        i += 1;
    }
    if help {
        eprint!("{USAGE}");
        return 0;
    }
    if !has_text {
        eprint!("{USAGE}");
        return 2;
    }

    if !find_source::has_dump(&options.dump_dir) {
        eprintln!(
            "ERROR: {} is empty or missing; run dump-assets first (npm run dump)",
            options.dump_dir.display()
        );
        return 1;
    }
    match find_source::find(&options.text, &options.dump_dir, options.first) {
        Ok(hits) => {
            if hits.is_empty() {
                eprintln!("no occurrences in {}", options.dump_dir.display());
                return 1;
            }
            for hit in &hits {
                println!("{}", find_source::fmt(hit));
            }
            0
        }
        Err(message) => {
            eprintln!("ERROR: {message}");
            1
        }
    }
}
