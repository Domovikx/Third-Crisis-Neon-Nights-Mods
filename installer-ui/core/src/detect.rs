//! Поиск игры: Steam-библиотеки (`libraryfolders.vdf`) + маркеры установки.
//!
//! Порядок как в `scripts/game_dir.mts`: env `TCNN_GAME_DIR` → реестр Steam →
//! `steamapps/libraryfolders.vdf` → `<библиотека>/steamapps/common/<игра>`.
//! `appmanifest_<APP_ID>.acf` даёт buildid (версию игры), но игру находим по
//! маркерам, а не по одному файлу манифеста: без `Assembly-CSharp.dll` пайплайн
//! всё равно не работает.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::manifest;
use crate::{fsutil, GAME_FOLDER, MODS_FOLDER, MOD_FOLDER};

/// Результат проверки каталога: маркеры на месте.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameCheck {
    pub dir: Option<String>,
    pub ok: bool,
    pub missing: Vec<String>,
}

/// Найденная установка игры.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub path: String,
    /// Библиотека Steam, в которой нашлась игра (для диагностики).
    pub library: String,
    /// `buildid` из `appmanifest` (версия игры в Steam).
    pub build_id: Option<String>,
    /// Мод уже стоит: есть манифест установки.
    pub mod_installed: bool,
    /// Язык из манифеста, если он читается.
    pub installed_lang: Option<String>,
}

/// Пути из `libraryfolders.vdf`: и v2 (`"path" "D:\\Games"`), и старый
/// нумерованный формат (`"1" "D:\\Games"`). Возвращает строки как в файле.
pub fn parse_library_folders(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let value = if let Some(rest) = line.strip_prefix("\"path\"") {
            rest.trim().trim_matches('"')
        } else if line.starts_with('"') && line.matches('"').count() == 4 {
            let parts: Vec<&str> = line.split('"').collect();
            if parts.len() >= 4 && parts[1].chars().all(|c| c.is_ascii_digit()) {
                parts[3]
            } else {
                continue;
            }
        } else {
            continue;
        };
        if !value.is_empty() && !out.iter().any(|v| v == value) {
            out.push(value.to_string());
        }
    }
    out
}

/// Нормализовать путь Steam: кавычки, `/` → `\`.
pub fn normalize_steam_path(raw: &str) -> PathBuf {
    PathBuf::from(raw.trim().trim_matches('"').replace('/', "\\"))
}

/// Библиотеки из `<steam>/steamapps/libraryfolders.vdf` (+ сам корень).
pub fn read_library_folders(steam_root: &Path) -> Vec<PathBuf> {
    let mut out = vec![steam_root.to_path_buf()];
    let vdf = steam_root.join("steamapps").join("libraryfolders.vdf");
    let Ok(text) = fsutil::read_text(&vdf) else {
        return out;
    };
    for raw in parse_library_folders(&text) {
        let path = normalize_steam_path(&raw);
        if path.is_dir() && !out.iter().any(|p| p == &path) {
            out.push(path);
        }
    }
    out
}

/// Корни Steam: реестр (HKCU, затем HKLM) + известные каталоги по умолчанию.
pub fn steam_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf| {
        if path.is_dir() && !roots.iter().any(|p| p == &path) {
            roots.push(path);
        }
    };

    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        use winreg::RegKey;

        if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
            if let Ok(value) = key.get_value::<String, _>("SteamPath") {
                push(normalize_steam_path(&value));
            }
        }
        if let Ok(key) =
            RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SOFTWARE\\WOW6432Node\\Valve\\Steam")
        {
            if let Ok(value) = key.get_value::<String, _>("InstallPath") {
                push(normalize_steam_path(&value));
            }
        }
    }

    for raw in [
        r"C:\Program Files (x86)\Steam",
        r"C:\Program Files\Steam",
        r"D:\Steam",
        r"D:\SteamLibrary",
        r"E:\SteamLibrary",
    ] {
        push(PathBuf::from(raw));
    }
    roots
}

/// Все известные библиотеки Steam, без дублей.
pub fn steam_libraries() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for root in steam_roots() {
        for lib in read_library_folders(&root) {
            if !out.iter().any(|p| p == &lib) {
                out.push(lib);
            }
        }
    }
    out
}

/// Кандидаты пути к игре в порядке приоритета.
pub fn game_candidates(libraries: &[PathBuf]) -> Vec<PathBuf> {
    libraries
        .iter()
        .map(|lib| lib.join("steamapps").join("common").join(GAME_FOLDER))
        .collect()
}

/// Проверить, что каталог — установка игры (есть exe и сборка Unity).
pub fn check_game_dir(dir: Option<&Path>) -> GameCheck {
    let missing_all = crate::required_markers().to_vec();
    let Some(dir) = dir else {
        return GameCheck {
            dir: None,
            ok: false,
            missing: missing_all,
        };
    };
    let missing: Vec<String> = crate::required_markers()
        .into_iter()
        .filter(|marker| !dir.join(marker).is_file())
        .collect();
    GameCheck {
        dir: Some(dir.display().to_string()),
        ok: missing.is_empty(),
        missing,
    }
}

/// `buildid` игры из `appmanifest_<APP_ID>.acf` библиотеки.
pub fn build_id(library: &Path) -> Option<String> {
    for app_id in crate::STEAM_APP_IDS {
        let acf = library
            .join("steamapps")
            .join(format!("appmanifest_{app_id}.acf"));
        let Ok(text) = fsutil::read_text(&acf) else {
            continue;
        };
        for line in text.lines() {
            if let Some(rest) = line.trim().strip_prefix("\"buildid\"") {
                return Some(rest.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

/// Найти игру среди библиотек. Возвращает первую с целыми маркерами.
pub fn find_game_in(libraries: &[PathBuf]) -> Option<GameInfo> {
    for library in libraries {
        for candidate in game_candidates(std::slice::from_ref(library)) {
            if let Some(info) = game_info_at(&candidate, library) {
                return Some(info);
            }
        }
    }
    None
}

/// Описание установки в конкретном каталоге (`None` — маркеров нет).
pub fn game_info_at(dir: &Path, library: &Path) -> Option<GameInfo> {
    let check = check_game_dir(Some(dir));
    if !check.ok {
        return None;
    }
    let manifest = manifest::read(dir).ok().flatten();
    Some(GameInfo {
        path: dir.display().to_string(),
        library: library.display().to_string(),
        build_id: build_id(library),
        mod_installed: dir
            .join(MODS_FOLDER)
            .join(MOD_FOLDER)
            .join(crate::MANIFEST_NAME)
            .is_file(),
        installed_lang: manifest.map(|m| m.lang).filter(|l| !l.is_empty()),
    })
}

/// Найти игру: env `TCNN_GAME_DIR` → Steam-библиотеки.
pub fn detect_game() -> Option<GameInfo> {
    if let Ok(raw) = std::env::var("TCNN_GAME_DIR") {
        let dir = PathBuf::from(raw);
        if let Some(info) = game_info_at(&dir, &library_of(&dir)) {
            return Some(info);
        }
    }
    find_game_in(&steam_libraries())
}

/// Библиотека Steam для уже известного пути `<lib>/steamapps/common/<игра>`.
fn library_of(game: &Path) -> PathBuf {
    game.ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(""))
}

/// Проверить конкретную папку, выбранную вручную, и вернуть info.
pub fn probe_game(dir: &Path) -> GameCheck {
    check_game_dir(Some(dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{fake_game, TempDir};
    use crate::GAME_DATA_FOLDER;
    use crate::STEAM_APP_ID;
    use std::fs;

    #[test]
    fn parses_v2_libraryfolders_with_escaped_backslashes() {
        let text = r#"
"libraryfolders"
{
    "0"
    {
        "path"		"C:\\Program Files (x86)\\Steam"
        "label"		""
    }
    "1"
    {
        "path"		"D:\\SteamLibrary"
        "label"		"games"
    }
}
"#;
        assert_eq!(
            parse_library_folders(text),
            vec![r"C:\\Program Files (x86)\\Steam", r"D:\\SteamLibrary"]
        );
    }

    #[test]
    fn parses_legacy_numbered_libraryfolders() {
        let text =
            "\"LibraryFolders\"\n{\n\t\"1\"\t\t\"D:\\\\Games\"\n\t\"2\"\t\t\"E:\\\\Steam\"\n}\n";
        assert_eq!(
            parse_library_folders(text),
            vec![r"D:\\Games", r"E:\\Steam"]
        );
    }

    #[test]
    fn read_library_folders_dedupes_and_keeps_steam_root() {
        let tmp = TempDir::new("vdf");
        let steam = tmp.path().join("Steam");
        let lib = tmp.path().join("Library");
        fs::create_dir_all(steam.join("steamapps")).unwrap();
        fs::create_dir_all(&lib).unwrap();
        let vdf = format!(
            "\"libraryfolders\"\n{{\n  \"path\" \"{}\"\n}}\n",
            lib.display().to_string().replace('\\', "\\\\")
        );
        fs::write(steam.join("steamapps/libraryfolders.vdf"), vdf).unwrap();
        let libs = read_library_folders(&steam);
        assert_eq!(libs, vec![steam.clone(), lib]);
    }

    #[test]
    fn check_game_dir_reports_every_missing_marker() {
        let tmp = TempDir::new("check");
        let game = tmp.path().join("game");
        fs::create_dir_all(&game).unwrap();
        let check = check_game_dir(Some(&game));
        assert!(!check.ok);
        assert_eq!(check.missing.len(), 2);
        fake_game(&tmp);
        let check = check_game_dir(Some(&tmp.path().join("game")));
        assert!(check.ok, "{:?}", check.missing);
    }

    #[test]
    fn find_game_in_scans_libraries_in_order() {
        let tmp = TempDir::new("find");
        let empty_lib = tmp.path().join("Empty");
        let good_lib = tmp.path().join("GoodLib");
        fs::create_dir_all(empty_lib.join("steamapps/common")).unwrap();
        let game = good_lib.join("steamapps").join("common").join(GAME_FOLDER);
        // fake_game создаёт игру в переданной папке, здесь нужен путь библиотеки.
        fs::create_dir_all(game.join(GAME_DATA_FOLDER).join("Managed")).unwrap();
        fs::write(game.join(format!("{GAME_FOLDER}.exe")), b"exe").unwrap();
        fs::write(
            game.join(GAME_DATA_FOLDER)
                .join("Managed")
                .join("Assembly-CSharp.dll"),
            b"asm",
        )
        .unwrap();
        fs::write(
            good_lib
                .join("steamapps")
                .join(format!("appmanifest_{STEAM_APP_ID}.acf")),
            "\"AppState\"\n{\n\t\"buildid\"\t\t\"123456\"\n}\n",
        )
        .unwrap();

        let found = find_game_in(&[empty_lib, good_lib.clone()]).expect("game");
        assert_eq!(found.path, game.display().to_string());
        assert_eq!(found.library, good_lib.display().to_string());
        assert_eq!(found.build_id.as_deref(), Some("123456"));
        assert!(!found.mod_installed);
    }

    #[test]
    fn probe_reports_dir_and_missing() {
        let tmp = TempDir::new("probe");
        let game = fake_game(&tmp);
        let check = probe_game(&game);
        assert!(check.ok);
        assert_eq!(check.dir.unwrap(), game.display().to_string());
    }
}
