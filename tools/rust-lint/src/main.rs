//! rust-lint — CLI независимого аудита POT/PO/DAT.
//!
//! Примеры:
//!   rust-lint --root .
//!   rust-lint --lang ru --json-dir tmp
//!   rust-lint --lang ru --pot tmp/old.pot --po tmp/old-ru.po --no-dat
//!   rust-lint --root . --fail-on-error
//!
//! Код выхода: 0 — прогон состоялся (находки не роняют процесс), 1 — есть
//! `error` при `--fail-on-error`, 2 — не прочитан вход/неверные аргументы.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use rust_lint::audit::{audit_pot, audit_strings_opts};
use rust_lint::classes::{Level, CLASSES};
use rust_lint::report::{audit_json, pot_json, report_markdown};

struct Args {
    root: PathBuf,
    langs: Vec<String>,
    pot: Option<PathBuf>,
    po: Option<PathBuf>,
    dat: Option<PathBuf>,
    json_dir: PathBuf,
    report: Option<PathBuf>,
    no_report: bool,
    no_dat: bool,
    fail_on_error: bool,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            root: PathBuf::from("."),
            langs: Vec::new(),
            pot: None,
            po: None,
            dat: None,
            json_dir: PathBuf::from("tmp"),
            report: None,
            no_report: false,
            no_dat: false,
            fail_on_error: false,
        }
    }
}

fn usage() -> &'static str {
    "rust-lint — независимый аудит целостности POT/PO/DAT (только чтение)\n\
     \n\
     Использование: rust-lint [--root <репо>] [--lang <код>]... [--pot <файл>]\n\
     \x20              [--po <файл>] [--dat <файл>] [--json-dir <каталог>]\n\
     \x20              [--report <файл> | --no-report] [--no-dat] [--fail-on-error]\n\
     \n\
     Без --lang берётся порядок из config/language-priority.json (или все po/*.po).\n\
     --po/--dat допустимы только с одним --lang (калибровка на снимке).\n"
}

fn take(argv: &[String], i: &mut usize, name: &str) -> Result<String, String> {
    if *i + 1 >= argv.len() {
        return Err(format!("{name}: нужно значение"));
    }
    *i += 1;
    Ok(argv[*i].clone())
}

fn parse_args(argv: Vec<String>) -> Result<Args, String> {
    let mut args = Args::default();
    let mut i = 0usize;
    while i < argv.len() {
        match argv[i].as_str() {
            "--root" => args.root = PathBuf::from(take(&argv, &mut i, "--root")?),
            "--lang" => {
                let value = take(&argv, &mut i, "--lang")?;
                for code in value.split(',') {
                    let code = code.trim();
                    if !code.is_empty() {
                        args.langs.push(code.to_string());
                    }
                }
            }
            "--pot" => args.pot = Some(PathBuf::from(take(&argv, &mut i, "--pot")?)),
            "--po" => args.po = Some(PathBuf::from(take(&argv, &mut i, "--po")?)),
            "--dat" => args.dat = Some(PathBuf::from(take(&argv, &mut i, "--dat")?)),
            "--json-dir" => args.json_dir = PathBuf::from(take(&argv, &mut i, "--json-dir")?),
            "--report" => args.report = Some(PathBuf::from(take(&argv, &mut i, "--report")?)),
            "--no-report" => args.no_report = true,
            "--no-dat" => args.no_dat = true,
            "--fail-on-error" => args.fail_on_error = true,
            "--help" | "-h" => return Err(String::new()),
            other => return Err(format!("неизвестный флаг: {other}")),
        }
        i += 1;
    }
    if args.po.is_some() && args.langs.len() != 1 {
        return Err("--po требует ровно одного --lang".to_string());
    }
    if args.dat.is_some() && args.langs.len() != 1 {
        return Err("--dat требует ровно одного --lang".to_string());
    }
    Ok(args)
}

/// Языки в порядке `config/language-priority.json`, иначе все `po/*.po`.
fn discover_langs(root: &Path) -> std::io::Result<Vec<String>> {
    let mut out = Vec::new();
    let config = root.join("config").join("language-priority.json");
    if let Ok(text) = std::fs::read_to_string(&config) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(list) = value.get("languages").and_then(|v| v.as_array()) {
                for item in list {
                    if let Some(code) = item.get("code").and_then(|v| v.as_str()) {
                        if root.join("po").join(format!("{code}.po")).exists() {
                            out.push(code.to_string());
                        }
                    }
                }
            }
        }
    }
    if !out.is_empty() {
        return Ok(out);
    }
    let dir = root.join("po");
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("po") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = PathBuf::from(format!("{}.part", path.display()));
    std::fs::write(&part, text)?;
    std::fs::rename(&part, path)
}

fn run(args: Args) -> Result<ExitCode, String> {
    let langs = if args.langs.is_empty() {
        discover_langs(&args.root).map_err(|e| format!("не прочитан список языков: {e}"))?
    } else {
        args.langs.clone()
    };
    if langs.is_empty() {
        return Err(format!(
            "в {} нет ни одного po/*.po",
            args.root.join("po").display()
        ));
    }

    let pot_path = args
        .pot
        .clone()
        .unwrap_or_else(|| args.root.join("po").join("template.pot"));
    let pot_text = std::fs::read_to_string(&pot_path)
        .map_err(|e| format!("не прочитан POT {}: {e}", pot_path.display()))?;

    let pot_audit = audit_pot(&pot_text);
    write_atomic(&args.json_dir.join("lint-pot.json"), &pot_json(&pot_audit))
        .map_err(|e| format!("не записан JSON для POT: {e}"))?;

    let mut audits = Vec::new();
    for lang in &langs {
        let po_path = args
            .po
            .clone()
            .unwrap_or_else(|| args.root.join("po").join(format!("{lang}.po")));
        let po_text = std::fs::read_to_string(&po_path)
            .map_err(|e| format!("не прочитан PO {}: {e}", po_path.display()))?;
        let dat_text = if args.no_dat {
            None
        } else {
            let dat_path = args
                .dat
                .clone()
                .unwrap_or_else(|| args.root.join("runtime").join(format!("patch_{lang}.dat")));
            match std::fs::read_to_string(&dat_path) {
                Ok(text) => Some(text),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(format!("не прочитан .dat {}: {e}", dat_path.display())),
            }
        };
        let audit =
            audit_strings_opts(lang, &pot_text, &po_text, dat_text.as_deref(), !args.no_dat);
        write_atomic(
            &args.json_dir.join(format!("lint-{lang}.json")),
            &audit_json(&audit),
        )
        .map_err(|e| format!("не записан JSON для {lang}: {e}"))?;
        audits.push(audit);
    }

    // Сводка в консоль.
    println!(
        "rust-lint: POT {} записей, языков {}",
        pot_audit.entries,
        audits.len()
    );
    let mut pot_totals = [0usize; 3];
    for c in pot_audit.classes.values() {
        match c.def.level {
            Level::Error => pot_totals[0] += c.count,
            Level::Warn => pot_totals[1] += c.count,
            Level::Info => pot_totals[2] += c.count,
        }
    }
    println!(
        "{:<4} {:>7} {:>9} {:>7} {:>6} {:>6} {:>6}",
        "lang", "po", "filled", "dat", "err", "warn", "info"
    );
    let mut grand = [0usize; 3];
    for a in &audits {
        let mut totals = [0usize; 3];
        for c in a.classes.values() {
            match c.def.level {
                Level::Error => totals[0] += c.count,
                Level::Warn => totals[1] += c.count,
                Level::Info => totals[2] += c.count,
            }
        }
        for (g, t) in grand.iter_mut().zip(totals) {
            *g += t;
        }
        println!(
            "{:<4} {:>7} {:>9} {:>7} {:>6} {:>6} {:>6}",
            a.lang, a.po_entries, a.po_filled, a.dat_rows, totals[0], totals[1], totals[2]
        );
    }
    println!(
        "{:<4} {:>7} {:>9} {:>7} {:>6} {:>6} {:>6}",
        "POT", pot_audit.entries, "", "", pot_totals[0], pot_totals[1], pot_totals[2]
    );
    println!(
        "{:<4} {:>7} {:>9} {:>7} {:>6} {:>6} {:>6}",
        "Σ",
        "",
        "",
        "",
        grand[0] + pot_totals[0],
        grand[1] + pot_totals[1],
        grand[2] + pot_totals[2]
    );

    println!("\nКлассы (ненулевые, сумма по источникам):");
    for def in CLASSES {
        let pot_count = pot_audit.count(def.id);
        let total: usize = pot_count + audits.iter().map(|a| a.count(def.id)).sum::<usize>();
        if total == 0 {
            continue;
        }
        let mut by_lang: Vec<String> = Vec::new();
        if pot_count > 0 {
            by_lang.push(format!("POT={pot_count}"));
        }
        by_lang.extend(
            audits
                .iter()
                .filter(|a| a.count(def.id) > 0)
                .map(|a| format!("{}={}", a.lang, a.count(def.id))),
        );
        println!(
            "  {:<34} {:<5} {:>6}  {}",
            def.id,
            def.level.as_str(),
            total,
            by_lang.join(" ")
        );
    }

    if !args.no_report {
        let report_path = args
            .report
            .clone()
            .unwrap_or_else(|| args.json_dir.join("lint-report.md"));
        write_atomic(&report_path, &report_markdown(&audits, Some(&pot_audit)))
            .map_err(|e| format!("не записан отчёт {}: {e}", report_path.display()))?;
        println!("\nОтчёт: {}", report_path.display());
    }

    let errors: usize = pot_audit
        .classes
        .values()
        .chain(audits.iter().flat_map(|a| a.classes.values()))
        .filter(|c| c.def.level == Level::Error)
        .map(|c| c.count)
        .sum();
    if args.fail_on_error && errors > 0 {
        return Ok(ExitCode::FAILURE);
    }
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    match parse_args(std::env::args().skip(1).collect()) {
        Ok(args) => match run(args) {
            Ok(code) => code,
            Err(message) => {
                eprintln!("rust-lint: {message}");
                ExitCode::from(2)
            }
        },
        Err(message) => {
            if message.is_empty() {
                print!("{}", usage());
                ExitCode::SUCCESS
            } else {
                eprintln!("rust-lint: {message}\n{}", usage());
                ExitCode::from(2)
            }
        }
    }
}
