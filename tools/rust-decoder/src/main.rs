//! main.rs — CLI декодера: `list` (список файлов игры) и `dump` (rd1-JSONL).
//!
//! Контракт с TS-адаптером: `--asset имя=путь` (повторяемый) задаёт набор и
//! имена ассетов ровно в порядке обхода; `--out` — файл rd1. Остальные режимы
//! (`--game`, `--files`, `--all`) нужны для самостоятельного запуска.
//!
//! Отчёт бенчмарка (`--report`) — JSON с фазовыми таймингами и пиковой RSS.

use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use rust_decoder::discover::{discover_game_files, Target};
use rust_decoder::json::Out;
use rust_decoder::memstats;
use rust_decoder::rd1::{emit_file, Clock, Timings};

struct Args {
    command: String,
    game: Option<PathBuf>,
    out: Option<PathBuf>,
    files: Option<String>,
    list: Option<PathBuf>,
    assets: Vec<(String, PathBuf)>,
    report: Option<PathBuf>,
}

fn usage() {
    eprintln!(
        "usage:\n  \n  rust-decoder list --game <папка игры>\n  \
         rust-decoder dump --out <файл> (--list <файл> | --asset имя=путь ... | --game <dir> [--all] | --files a,b)\n\
         \n  --list <файл>     список «имя<TAB>путь» (так адаптер из TS обходит лимит командной строки)\n  \
         --asset имя=путь  ассет (имя как в дампе)\n  \
         --game <dir>      папка установки игры (автоопределение списка файлов)\n  \
         --files a,b       конкретные файлы (путь или имя из установки)\n  \
         --out <файл>      куда писать rd1-JSONL (по умолчанию stdout)\n  \
         --report <файл>   JSON с таймингами фаз и пиковой RSS"
    );
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let Some(command) = argv.first() else {
        return Err("не задана команда".into());
    };
    if command == "--help" || command == "-h" {
        return Err(String::new());
    }
    let mut args = Args {
        command: command.clone(),
        game: None,
        out: None,
        files: None,
        list: None,
        assets: Vec::new(),
        report: None,
    };
    let mut i = 1;
    while i < argv.len() {
        let arg = &argv[i];
        let value = |i: usize| -> Result<&String, String> {
            argv.get(i + 1)
                .ok_or_else(|| format!("{} требует значение", argv[i]))
        };
        match arg.as_str() {
            "--game" => {
                args.game = Some(PathBuf::from(value(i)?));
                i += 2;
            }
            "--out" => {
                args.out = Some(PathBuf::from(value(i)?));
                i += 2;
            }
            "--files" => {
                args.files = Some(value(i)?.clone());
                i += 2;
            }
            "--list" => {
                args.list = Some(PathBuf::from(value(i)?));
                i += 2;
            }
            "--report" => {
                args.report = Some(PathBuf::from(value(i)?));
                i += 2;
            }
            "--asset" => {
                let raw = value(i)?;
                let (name, path) = raw
                    .split_once('=')
                    .ok_or_else(|| format!("--asset требует имя=путь, получено: {}", raw))?;
                args.assets.push((name.to_string(), PathBuf::from(path)));
                i += 2;
            }
            "--all" => i += 1,
            other => return Err(format!("неизвестный флаг: {}", other)),
        }
    }
    Ok(args)
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn read_target_list(path: &Path) -> Result<Vec<Target>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let Some((name, file)) = line.split_once('\t') else {
            return Err(format!("битая строка списка: {}", line));
        };
        out.push(Target {
            name: name.to_string(),
            path: PathBuf::from(file),
        });
    }
    Ok(out)
}

fn resolve_targets(args: &Args) -> Result<Vec<Target>, String> {
    if let Some(list) = &args.list {
        return read_target_list(list);
    }
    if !args.assets.is_empty() {
        return Ok(args
            .assets
            .iter()
            .map(|(name, path)| Target {
                name: name.clone(),
                path: path.clone(),
            })
            .collect());
    }
    let discovered = args
        .game
        .as_deref()
        .map(discover_game_files)
        .unwrap_or_default();
    if let Some(files) = &args.files {
        let mut out = Vec::new();
        for item in files.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let base = item.rsplit(['/', '\\']).next().unwrap_or(item).to_string();
            let found = discovered
                .iter()
                .find(|t| t.name == item)
                .or_else(|| discovered.iter().find(|t| base_name(&t.path) == base));
            match found {
                Some(target) => out.push(target.clone()),
                None => out.push(Target {
                    name: base,
                    path: PathBuf::from(item),
                }),
            }
        }
        return Ok(out);
    }
    if discovered.is_empty() {
        return Err("игра не найдена: укажите --game, --files или --asset".into());
    }
    Ok(discovered)
}

fn cmd_list(args: &Args) -> Result<(), String> {
    let game = args
        .game
        .as_deref()
        .ok_or_else(|| "list требует --game".to_string())?;
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for target in discover_game_files(game) {
        writeln!(out, "{}\t{}", target.name, target.path.display()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

struct Totals {
    files: usize,
    failed: usize,
    objects: usize,
    typed_objects: usize,
    bytes_in: u64,
}

fn cmd_dump(args: &Args) -> Result<(), String> {
    let targets = resolve_targets(args)?;
    if targets.is_empty() {
        return Err("нет файлов для разбора".into());
    }
    let clock = Clock::start();
    let mut totals = Totals {
        files: 0,
        failed: 0,
        objects: 0,
        typed_objects: 0,
        bytes_in: 0,
    };
    let mut timings = Timings::default();

    let write_result = match &args.out {
        Some(path) => {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let file = File::create(path).map_err(|e| format!("{}: {}", path.display(), e))?;
            let writer = BufWriter::with_capacity(1 << 20, file);
            let outcome = write_all(writer, &targets, &mut totals, &mut timings, clock.ms());
            outcome.map(|_| ())
        }
        None => {
            let writer = BufWriter::with_capacity(1 << 20, io::stdout());
            write_all(writer, &targets, &mut totals, &mut timings, clock.ms()).map(|_| ())
        }
    };
    let total_ms = clock.ms();
    write_result.map_err(|e| e.to_string())?;

    let out_bytes = args
        .out
        .as_deref()
        .and_then(|path| fs::metadata(path).ok())
        .map(|meta| meta.len())
        .unwrap_or(0);

    eprintln!(
        "rust-decoder: {} файлов, {} объектов, {} типизированных, {} из {} байт (битых: {})",
        totals.files,
        totals.objects,
        totals.typed_objects,
        totals.bytes_in,
        out_bytes,
        totals.failed
    );

    if let Some(report) = &args.report {
        let write_ms =
            total_ms - (timings.read_ms + timings.decode_ms + timings.scan_ms + timings.runs_ms);
        let report_json = format!(
            "{{\"files\":{},\"failed\":{},\"objects\":{},\"typed_objects\":{},\"bytes_in\":{},\
             \"out_bytes\":{},\"total_ms\":{:.1},\"read_ms\":{:.1},\"decode_ms\":{:.1},\
             \"scan_ms\":{:.1},\"runs_ms\":{:.1},\"write_ms\":{:.1},\"peak_rss\":{}}}",
            totals.files,
            totals.failed,
            totals.objects,
            totals.typed_objects,
            totals.bytes_in,
            out_bytes,
            total_ms,
            timings.read_ms,
            timings.decode_ms,
            timings.scan_ms,
            timings.runs_ms,
            write_ms,
            memstats::peak_rss_bytes()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".to_string()),
        );
        fs::write(report, report_json).map_err(|e| format!("{}: {}", report.display(), e))?;
    }
    Ok(())
}

fn write_all<W: Write>(
    writer: W,
    targets: &[Target],
    totals: &mut Totals,
    timings: &mut Timings,
    _start_ms: f64,
) -> io::Result<()> {
    let mut out = Out::new(writer);
    for target in targets {
        let read_started = Clock::start();
        let bytes = match fs::read(&target.path) {
            Ok(bytes) => bytes,
            Err(err) => {
                eprintln!("  ERROR: {}: {}", target.name, err);
                totals.failed += 1;
                continue;
            }
        };
        timings.read_ms += read_started.ms();
        totals.bytes_in += bytes.len() as u64;
        let stats = emit_file(
            &mut out,
            &target.name,
            &target.path.to_string_lossy(),
            &bytes,
            timings,
        )?;
        totals.files += 1;
        totals.objects += stats.objects;
        totals.typed_objects += stats.typed_objects;
    }
    out.finish()?;
    Ok(())
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(args) => args,
        Err(message) => {
            if !message.is_empty() {
                eprintln!("{}", message);
            }
            usage();
            return ExitCode::from(2);
        }
    };
    let result = match args.command.as_str() {
        "list" => cmd_list(&args),
        "dump" => cmd_dump(&args),
        other => Err(format!("неизвестная команда: {}", other)),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{}", message);
            ExitCode::from(2)
        }
    }
}
