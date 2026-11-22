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

use rust_l10n::po2dat::{self, DatReport};
use rust_l10n::potgen::{self, PotgenOptions};
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
        other => {
            eprintln!("rust-l10n: неизвестная подкоманда: {other}\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// potgen: 0 — успех, 1 — ошибка обработки, 2 — ошибка аргументов.
fn potgen_cli(argv: &[String]) -> u8 {
    let mut options = PotgenOptions::new(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
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
            eprintln!("POT({mode}): {} entries -> {}", res.entries, res.out_path.display());
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
            eprintln!("rust-l10n po2dat: {message}

{USAGE}");
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
