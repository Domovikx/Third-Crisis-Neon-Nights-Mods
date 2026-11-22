//! rust-qa — офлайн-QA перевода (Rust-исполнитель контракта `qa_translate`).
//!
//! CLI:
//!   rust-qa [--root <репо>] [--lang ru] [--json <out.json>]
//!           [--findings <out.jsonl>] [--quiet]
//!
//! Код выхода: 0 — ошибок нет, 1 — есть findings уровня `error` (как у TS),
//! 2 — не удалось прочитать вход.

use std::path::PathBuf;
use std::process::ExitCode;

use rust_qa::report::{findings_jsonl, report_json};
use rust_qa::rules::check;

struct Args {
    root: PathBuf,
    lang: String,
    json: Option<PathBuf>,
    findings: Option<PathBuf>,
    quiet: bool,
}

fn usage() -> &'static str {
    "rust-qa — офлайн-QA перевода (паритет с translate-qa/qa_translate.mts)\n\
     \n\
     Использование: rust-qa [--root <репо>] [--lang ru] [--json <out.json>]\n\
     \x20              [--findings <out.jsonl>] [--quiet]\n"
}

fn parse_args(argv: Vec<String>) -> Result<Args, String> {
    let mut args = Args {
        root: PathBuf::from("."),
        lang: "ru".to_string(),
        json: None,
        findings: None,
        quiet: false,
    };
    let mut i = 0;
    while i < argv.len() {
        let flag = argv[i].clone();
        match flag.as_str() {
            "--root" => args.root = PathBuf::from(take(&argv, &mut i, "--root")?),
            "--lang" => args.lang = take(&argv, &mut i, "--lang")?,
            "--json" => args.json = Some(PathBuf::from(take(&argv, &mut i, "--json")?)),
            "--findings" => args.findings = Some(PathBuf::from(take(&argv, &mut i, "--findings")?)),
            "--quiet" => args.quiet = true,
            "--help" | "-h" => return Err(String::new()),
            other => return Err(format!("неизвестный флаг: {other}")),
        }
        i += 1;
    }
    Ok(args)
}

fn take(argv: &[String], i: &mut usize, name: &str) -> Result<String, String> {
    if *i + 1 >= argv.len() {
        return Err(format!("{name}: нужно значение"));
    }
    *i += 1;
    Ok(argv[*i].clone())
}

fn run(args: Args) -> Result<ExitCode, String> {
    let report = check(&args.lang, &args.root)
        .map_err(|e| format!("не прочитан вход в {}: {e}", args.root.display()))?;
    if let Some(path) = &args.findings {
        std::fs::write(path, findings_jsonl(&report.findings))
            .map_err(|e| format!("не записан {}: {e}", path.display()))?;
    }
    if let Some(path) = &args.json {
        std::fs::write(path, report_json(&args.lang, &report))
            .map_err(|e| format!("не записан {}: {e}", path.display()))?;
    }
    let s = &report.summary;
    if !args.quiet {
        eprintln!(
            "QA[{}]: {}/{} ({:.1}%), errors={}, warnings={}",
            args.lang, s.filled, s.total, s.coverage, s.errors, s.warnings
        );
        for f in report
            .findings
            .iter()
            .filter(|f| f.level.as_str() == "error")
        {
            let text: String = f.text.chars().take(70).collect();
            let detail: String = f.detail.chars().take(70).collect();
            eprintln!(
                "  ERROR [{}] {} :: \"{}\" :: {}",
                f.rule, f.rel, text, detail
            );
        }
    }
    Ok(if s.errors > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(argv) {
        Ok(args) => match run(args) {
            Ok(code) => code,
            Err(message) => {
                eprintln!("rust-qa: {message}");
                ExitCode::from(2)
            }
        },
        Err(message) => {
            if message.is_empty() {
                print!("{}", usage());
                ExitCode::SUCCESS
            } else {
                eprintln!("rust-qa: {message}\n{}", usage());
                ExitCode::from(2)
            }
        }
    }
}
