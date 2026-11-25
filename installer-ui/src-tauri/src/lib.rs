//! Tauri-слой: только команды и прогресс. Вся логика — в `neon-installer-core`
//! (её юнит-тесты гоняются без окна и без Tauri).
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use neon_installer_core::detect::{self, GameCheck, GameInfo};
use neon_installer_core::install::{self, InstallProgress, InstallResult};
use neon_installer_core::uninstall::{self, UninstallResult};
use neon_installer_core::verify::{self, VerifyResult};

/// Проверка вручную выбранной папки: что не так и (если всё в порядке) info.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub check: GameCheck,
    pub game: Option<GameInfo>,
}

/// Состояние payload'а рядом с exe (UI показывает версию и набор языков).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadStatus {
    pub dir: String,
    pub exists: bool,
    pub version: Option<String>,
    pub langs: Vec<String>,
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Язык интерфейса по системе: `ru` для русской Windows, иначе `en`.
#[tauri::command]
fn system_locale() -> String {
    let raw = {
        #[cfg(windows)]
        {
            use winreg::enums::HKEY_CURRENT_USER;
            use winreg::RegKey;
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey("Control Panel\\International")
                .and_then(|k| k.get_value::<String, _>("LocaleName"))
                .unwrap_or_default()
        }
        #[cfg(not(windows))]
        {
            std::env::var("LANG").unwrap_or_default()
        }
    };
    if raw.to_lowercase().starts_with("ru") {
        "ru".to_string()
    } else {
        "en".to_string()
    }
}

/// Найти игру: env `TCNN_GAME_DIR` → Steam-библиотеки.
#[tauri::command]
fn detect_game() -> Option<GameInfo> {
    detect::detect_game()
}

/// Проверить папку, выбранную вручную («выбрать папку»).
#[tauri::command]
fn probe_game(path: String) -> ProbeResult {
    let dir = PathBuf::from(&path);
    let check = detect::probe_game(&dir);
    let game = if check.ok {
        let library = dir
            .ancestors()
            .nth(3)
            .map(PathBuf::from)
            .unwrap_or_default();
        detect::game_info_at(&dir, &library)
    } else {
        None
    };
    ProbeResult { check, game }
}

/// Payload рядом с exe: есть ли, какая версия, какие языки.
#[tauri::command]
fn payload_status() -> PayloadStatus {
    let dir = install::payload_dir(&exe_dir());
    let exists = dir.is_dir();
    let info = install::read_payload_info(&dir);
    let langs = if exists {
        install::available_langs(&dir)
    } else {
        Vec::new()
    };
    PayloadStatus {
        dir: dir.display().to_string(),
        exists,
        version: info.version,
        langs,
    }
}

/// Установить мод. Прогресс уходит событием `install-progress`.
#[tauri::command]
fn install_mod(
    app: AppHandle,
    game_dir: String,
    lang: String,
    payload_dir: Option<String>,
) -> Result<InstallResult, String> {
    let payload = payload_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| install::payload_dir(&exe_dir()));
    let game = PathBuf::from(game_dir);
    install::install_with_progress(&game, &payload, &lang, &mut |progress: InstallProgress| {
        let _ = app.emit("install-progress", progress);
    })
    .map_err(|e| e.wire())
}

/// Удалить ровно поставленное (файлы манифеста при совпадении sha256).
#[tauri::command]
fn uninstall_mod(game_dir: String) -> Result<UninstallResult, String> {
    uninstall::uninstall(&PathBuf::from(game_dir)).map_err(|e| e.wire())
}

/// Сверить установку с манифестом (sha256 каждого файла).
#[tauri::command]
fn verify_mod(game_dir: String) -> Result<VerifyResult, String> {
    verify::verify(&PathBuf::from(game_dir)).map_err(|e| e.wire())
}

/// `--uninstall <game>`: удалить поставленное из CLI (поддержка и E2E).
pub fn cli_uninstall(game: &str) -> i32 {
    match uninstall::uninstall(std::path::Path::new(game)) {
        Ok(result) => {
            println!(
                "удалено {}, оставлено {}, папок {}, манифест удалён: {}",
                result.deleted.len(),
                result.kept.len(),
                result.removed_dirs.len(),
                result.manifest_deleted
            );
            if result.kept.is_empty() {
                0
            } else {
                for path in &result.kept {
                    println!("  оставлено: {path}");
                }
                2
            }
        }
        Err(error) => {
            eprintln!("ОШИБКА: {error}");
            1
        }
    }
}

/// `--verify <game>`: сверить установку с манифестом из CLI.
pub fn cli_verify(game: &str) -> i32 {
    match verify::verify(std::path::Path::new(game)) {
        Ok(result) => {
            println!(
                "установлен: {}, цел: {}, проверено: {}, нет: {}, изменено: {}, лишних: {}",
                result.installed,
                result.ok,
                result.checked,
                result.missing.len(),
                result.modified.len(),
                result.unlisted.len()
            );
            for path in &result.missing {
                println!("  нет: {path}");
            }
            for item in &result.modified {
                println!("  изменён: {}", item.path);
            }
            if result.ok {
                0
            } else {
                2
            }
        }
        Err(error) => {
            eprintln!("ОШИБКА: {error}");
            1
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            system_locale,
            detect_game,
            probe_game,
            payload_status,
            install_mod,
            uninstall_mod,
            verify_mod
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения установщика");
}

/// `--selftest [payload]`: E2E собранного бинаря во временной папке
/// (установка → verify → uninstall → пусто). Реальную игру не трогает:
/// «игра» создаётся в `%TEMP%`.
pub fn selftest(payload_arg: Option<String>) -> i32 {
    let payload = payload_arg
        .map(PathBuf::from)
        .unwrap_or_else(|| install::payload_dir(&exe_dir()));
    if let Err(e) = install::validate_payload(&payload) {
        eprintln!("SELFTEST FAIL: payload: {e}");
        return 1;
    }

    let root = std::env::temp_dir().join(format!("ntdx-selftest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let game = root.join("game");
    let data = game
        .join(neon_installer_core::GAME_DATA_FOLDER)
        .join("Managed");
    if let Err(e) = std::fs::create_dir_all(&data) {
        eprintln!("SELFTEST FAIL: temp: {e}");
        return 1;
    }
    let _ = std::fs::write(
        game.join(format!("{}.exe", neon_installer_core::GAME_FOLDER)),
        b"selftest",
    );
    let _ = std::fs::write(data.join("Assembly-CSharp.dll"), b"selftest");

    println!("SELFTEST dir: {}", game.display());
    println!("SELFTEST payload: {}", payload.display());

    let langs = install::available_langs(&payload);
    let lang = if langs.iter().any(|l| l == "ru") {
        "ru"
    } else {
        langs.first().map(String::as_str).unwrap_or("en")
    };

    let install_result = match install::install(&game, &payload, lang) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("SELFTEST FAIL: install: {e}");
            let _ = std::fs::remove_dir_all(&root);
            return 1;
        }
    };
    println!(
        "SELFTEST install: {} файлов, {} байт, язык {}",
        install_result.copied, install_result.bytes, install_result.lang
    );

    let verify_result = match verify::verify(&game) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("SELFTEST FAIL: verify: {e}");
            let _ = std::fs::remove_dir_all(&root);
            return 1;
        }
    };
    if !verify_result.ok {
        eprintln!("SELFTEST FAIL: verify: {:?}", verify_result);
        let _ = std::fs::remove_dir_all(&root);
        return 1;
    }
    println!("SELFTEST verify: OK ({} файлов)", verify_result.checked);

    let uninstall_result = match uninstall::uninstall(&game) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("SELFTEST FAIL: uninstall: {e}");
            let _ = std::fs::remove_dir_all(&root);
            return 1;
        }
    };
    println!(
        "SELFTEST uninstall: удалено {}, папок {}",
        uninstall_result.deleted.len(),
        uninstall_result.removed_dirs.len()
    );

    // После удаления не остаётся ни наших файлов, ни пустых папок, а маркеры
    // «игры» (которые мы создали) целы.
    let leftovers: Vec<String> = [
        game.join(neon_installer_core::LOADER),
        game.join(neon_installer_core::MODS_FOLDER),
        game.join(neon_installer_core::manifest_path(&game)),
    ]
    .iter()
    .filter(|p| p.exists())
    .map(|p| p.display().to_string())
    .collect();
    let game_intact = game
        .join(format!("{}.exe", neon_installer_core::GAME_FOLDER))
        .is_file();

    let _ = std::fs::remove_dir_all(&root);
    if !leftovers.is_empty() || !game_intact {
        eprintln!("SELFTEST FAIL: остатки {leftovers:?}, игра цела: {game_intact}");
        return 1;
    }
    println!("SELFTEST PASS: после удаления пусто, файлы игры целы");
    0
}
