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

/// Все числовые индексы файлов `<prefix><N><suffix>` в каталоге, по возрастанию.
///
/// Почему не диапазон `0..16`: Python-эталон ограничивал обход шестнадцатью
/// сценами, а в установке их девятнадцать — `level16..18` молча не попадали в
/// дамп (найдено 2026-11-22). Обход по наличию файлов лечит это и не теряет
/// новые сцены после апдейта игры.
fn scene_indexes(data_dir: &Path, prefix: &str, suffix: &str) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    let Ok(entries) = fs::read_dir(data_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix(prefix) else {
            continue;
        };
        let Some(num) = rest.strip_suffix(suffix) else {
            continue;
        };
        if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if let Ok(value) = num.parse::<u32>() {
            out.push(value);
        }
    }
    out.sort_unstable();
    out
}

/// Список файлов игры — ровно как в TS-эталоне (display-имена совпадают).
pub fn discover_game_files(game_dir: &Path) -> Vec<Target> {
    let data_dir = game_dir.join(format!("{}_Data", GAME_FOLDER));
    let mut out: Vec<Target> = Vec::new();

    for index in scene_indexes(&data_dir, "level", "") {
        let path = data_dir.join(format!("level{}", index));
        out.push(Target {
            name: format!("level{}", index),
            path,
        });
    }
    for index in scene_indexes(&data_dir, "sharedassets", ".assets") {
        let path = data_dir.join(format!("sharedassets{}.assets", index));
        out.push(Target {
            name: format!("sharedassets{}", index),
            path,
        });
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    /// Уникальный временный каталог теста (без внешних зависимостей).
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rust-decoder-discover-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn touch(dir: &Path, name: &str) {
        File::create(dir.join(name)).expect("create file");
    }

    #[test]
    fn scene_indexes_sorts_numerically_and_ignores_junk() {
        let dir = temp_dir("idx");
        for name in [
            "level0",
            "level2",
            "level16",
            "levelX",
            "level.bak",
            "level9.bak",
        ] {
            touch(&dir, name);
        }
        assert_eq!(scene_indexes(&dir, "level", ""), vec![0, 2, 16]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scene_indexes_honours_suffix() {
        let dir = temp_dir("sfx");
        for name in [
            "sharedassets0.assets",
            "sharedassets17.assets",
            "sharedassets0.resource",
        ] {
            touch(&dir, name);
        }
        assert_eq!(scene_indexes(&dir, "sharedassets", ".assets"), vec![0, 17]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Регрессия 2026-11-22: сцен девятнадцать, а обход был 0..15 — три пропадали.
    #[test]
    fn discovers_all_levels_not_only_sixteen() {
        let root = temp_dir("game");
        let data = root.join(format!("{GAME_FOLDER}_Data"));
        fs::create_dir_all(&data).expect("create data dir");
        for index in 0..19 {
            touch(&data, &format!("level{index}"));
            touch(&data, &format!("sharedassets{index}.assets"));
        }
        let files = discover_game_files(&root);
        let levels: Vec<&str> = files
            .iter()
            .map(|t| t.name.as_str())
            .filter(|n| n.starts_with("level") && n[5..].bytes().all(|b| b.is_ascii_digit()))
            .collect();
        assert_eq!(levels.len(), 19, "должны найтись все 19 сцен");
        assert!(levels.contains(&"level16"));
        assert!(levels.contains(&"level18"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn picks_up_a_new_scene_after_a_game_update() {
        let root = temp_dir("future");
        let data = root.join(format!("{GAME_FOLDER}_Data"));
        fs::create_dir_all(&data).expect("create data dir");
        for name in ["level0", "level19", "level20"] {
            touch(&data, name);
        }
        let names: Vec<String> = discover_game_files(&root)
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert!(names.contains(&"level19".to_string()));
        assert!(names.contains(&"level20".to_string()));
        let _ = fs::remove_dir_all(&root);
    }
}
