//! game.rs — интеграционный прогон на УСТАНОВЛЕННОЙ игре.
//!
//! Файлов игры в git нет, поэтому тест гейтится наличием установки: если
//! `TCNN_GAME_DIR` не задан и Steam-путь не найден — тест пропускается
//! (печатает причину и возвращается, а не падает).
//!
//! Что проверяется: декодер проходит все файлы без падений, число ассетов
//! совпадает с найденным, объекты реально есть, а rd1 разбирается построчно
//! как JSON-записи ожидаемого вида (без внешнего JSON-парсера — только форма).

use std::path::{Path, PathBuf};

use rust_decoder::discover::{discover_game_files, GAME_FOLDER};
use rust_decoder::json::Out;
use rust_decoder::rd1::{emit_file, Timings};

const DEFAULT_STEAM: &str = "C:\\Program Files (x86)\\Steam\\steamapps\\common";

fn game_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("TCNN_GAME_DIR") {
        let path = PathBuf::from(dir);
        if path.join(GAME_FOLDER).is_dir() || path.ends_with(GAME_FOLDER) {
            return Some(path);
        }
    }
    let candidate = Path::new(DEFAULT_STEAM).join(GAME_FOLDER);
    if candidate.is_dir() {
        Some(candidate)
    } else {
        None
    }
}

#[test]
fn полный_дамп_игры_без_падений() {
    // Полный прогон — 2.18 ГБ: в debug это ~5 минут. Гоняем в release
    // (`cargo test --release --test game`), иначе `cargo test` становится
    // невыносимо долгим ради одного теста.
    if cfg!(debug_assertions) {
        eprintln!("пропуск: полный прогон только в release (cargo test --release --test game)");
        return;
    }
    let Some(game) = game_dir() else {
        eprintln!(
            "пропуск: игра не найдена (TCNN_GAME_DIR или {}\\{})",
            DEFAULT_STEAM, GAME_FOLDER
        );
        return;
    };
    let targets = discover_game_files(&game);
    assert!(targets.len() > 100, "файлов игры: {}", targets.len());

    // Пишем во временный файл рядом с бинарём: миллионы строк в памяти не держим.
    let out_path = std::env::temp_dir().join("rust-decoder-game-test.rd1.jsonl");
    let file = std::fs::File::create(&out_path).expect("временный файл создаётся");
    let mut out = Out::new(std::io::BufWriter::new(file));
    let mut timings = Timings::default();
    let mut objects = 0usize;
    let mut typed = 0usize;
    let mut bytes_in = 0u64;
    for target in &targets {
        let bytes = std::fs::read(&target.path).expect("файл игры читается");
        bytes_in += bytes.len() as u64;
        let stats = emit_file(
            &mut out,
            &target.name,
            &target.path.to_string_lossy(),
            &bytes,
            &mut timings,
        )
        .expect("rd1 пишется");
        objects += stats.objects;
        typed += stats.typed_objects;
    }
    out.finish().expect("поток закрывается");

    // Приёмка по фактам: ассетов и объектов в игре заведомо больше порога.
    assert!(objects > 100_000, "объектов: {}", objects);
    assert!(
        typed > 1_000,
        "типизированных объектов (type tree): {}",
        typed
    );
    assert!(bytes_in > 100_000_000, "вход: {} байт", bytes_in);

    let text = std::fs::read_to_string(&out_path).expect("rd1 читается");
    let mut assets = 0usize;
    let mut obj_lines = 0usize;
    let mut with_raw = 0usize;
    for line in text.lines() {
        if line.starts_with("{\"t\":\"asset\",") {
            assets += 1;
        } else if line.starts_with("{\"t\":\"obj\",") {
            obj_lines += 1;
            if line.contains(",\"raw\":\"") {
                with_raw += 1;
            }
        }
    }
    assert_eq!(assets, targets.len());
    assert_eq!(obj_lines, objects);
    assert_eq!(with_raw, typed);
    let _ = std::fs::remove_file(&out_path);
}
