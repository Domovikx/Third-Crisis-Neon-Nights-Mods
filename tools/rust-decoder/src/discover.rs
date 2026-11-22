//! discover.rs — список файлов установленной игры (порт `discoverGameFiles`).
//!
//! Это ЛОГИКА РАСКЛАДКИ УСТАНОВКИ, а не извлечение текста: имена ассетов
//! (`level0`, `sharedassets1`, `bundle_…`, `resource_…`, `dll_…`) — часть
//! контракта дампа, поэтому Rust умеет их повторить. Источник истины для
//! адаптера — TS (`discoverGameFiles`); тест `list` сверяет оба списка, чтобы
//! они не разъехались.

use std::fs;
use std::path::{Path, PathBuf};

/// Папка игры (имя папки данных = `<GAME_FOLDER>_Data`).
pub const GAME_FOLDER: &str = "Third Crisis Neon Nights";

#[derive(Debug, Clone)]
pub struct Target {
    pub name: String,
    pub path: PathBuf,
}

fn exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Рекурсивно найти `*.bundle` (StreamingAssets может быть глубоким).
fn find_bundles(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = read
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        let full = dir.join(&name);
        let Ok(meta) = fs::metadata(&full) else {
            continue;
        };
        if meta.is_dir() {
            find_bundles(&full, out);
        } else if name.ends_with(".bundle") {
            out.push(full);
        }
    }
}

/// Список файлов игры — ровно как в TS-эталоне (display-имена совпадают).
pub fn discover_game_files(game_dir: &Path) -> Vec<Target> {
    let data_dir = game_dir.join(format!("{}_Data", GAME_FOLDER));
    let mut out: Vec<Target> = Vec::new();

    for index in 0..16 {
        let path = data_dir.join(format!("level{}", index));
        if exists(&path) {
            out.push(Target {
                name: format!("level{}", index),
                path,
            });
        }
    }
    for index in 0..16 {
        let path = data_dir.join(format!("sharedassets{}.assets", index));
        if exists(&path) {
            out.push(Target {
                name: format!("sharedassets{}", index),
                path,
            });
        }
    }

    // У globalgamemanagers* одно display-имя (второй файл пропускается).
    let mut seen_display: Vec<String> = Vec::new();
    for name in [
        "resources.assets",
        "globalgamemanagers.assets",
        "globalgamemanagers",
    ] {
        let path = data_dir.join(name);
        if !exists(&path) {
            continue;
        }
        let display = name.trim_end_matches(".assets").to_string();
        if seen_display.contains(&display) {
            continue;
        }
        seen_display.push(display.clone());
        out.push(Target {
            name: display,
            path,
        });
    }

    let mut bundles: Vec<PathBuf> = Vec::new();
    find_bundles(&data_dir.join("StreamingAssets"), &mut bundles);
    for path in bundles {
        let base = file_name(&path);
        let display: String = base.trim_end_matches(".bundle").chars().take(60).collect();
        out.push(Target {
            name: format!("bundle_{}", display),
            path,
        });
    }

    let mut resources: Vec<PathBuf> = match fs::read_dir(&data_dir) {
        Ok(read) => read
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| file_name(path).ends_with(".resource"))
            .collect(),
        Err(_) => Vec::new(),
    };
    resources.sort();
    for path in resources {
        let base = file_name(&path);
        out.push(Target {
            name: format!("resource_{}", base.trim_end_matches(".resource")),
            path,
        });
    }

    let managed = data_dir.join("Managed");
    for dll in ["Assembly-CSharp.dll", "Assembly-CSharp-firstpass.dll"] {
        let path = managed.join(dll);
        if exists(&path) {
            out.push(Target {
                name: format!("dll_{}", dll.trim_end_matches(".dll")),
                path,
            });
        }
    }

    out
}
