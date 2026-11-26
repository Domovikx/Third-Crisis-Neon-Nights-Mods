//! Tauri-слой менеджера: команды и прогресс. Вся логика — в `neon-manager-core`
//! (её юнит-тесты гоняются без окна и без Tauri).
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use neon_manager_core::detect::{self, GameCheck, GameInfo};
use neon_manager_core::install::{self, InstallProgress, InstallResult};
use neon_manager_core::status::{self, StatusResult};
use neon_manager_core::uninstall::{self, UninstallResult};
use neon_manager_core::verify::{self, VerifyResult};

/// Состояние payload'а рядом с exe (UI показывает версию и набор языков).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadStatus {
    pub dir: String,
    pub exists: bool,
    pub version: Option<String>,
    pub langs: Vec<String>,
}

/// Проверка вручную выбранной папки: что не так и (если всё в порядке) info.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub check: GameCheck,
    pub game: Option<GameInfo>,
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Payload, вшитый в бандл через `bundle.resources` (`resource_dir()/payload`).
fn bundled_payload(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("payload"))
        .filter(|dir| dir.is_dir())
}

/// Порядок поиска: явный путь → ресурс бандла → рядом с exe / dev-дерево.
fn resolve_payload(app: Option<&AppHandle>, explicit: Option<String>) -> PathBuf {
    if let Some(dir) = explicit {
        return PathBuf::from(dir);
    }
    if let Some(app) = app {
        if let Some(dir) = bundled_payload(app) {
            return dir;
        }
    }
    install::find_payload(&exe_dir())
}

/// Журнал менеджера: рядом с exe, а если папка только для чтения — в `%TEMP%`.
/// Формат — ISO-время + строка; пишется best-effort, установку не ломает.
fn log(line: &str) {
    let entry = format!("{} {}\n", neon_manager_core::manifest::now_iso8601(), line);
    let exe_log = exe_dir().join("NeonTranslatorDXManager.log");
    let temp_log = std::env::temp_dir().join("NeonTranslatorDXManager.log");
    for path in [exe_log, temp_log] {
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = file.write_all(entry.as_bytes());
            return;
        }
    }
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

/// Payload: есть ли, какая версия, какие языки. Сначала ресурс бандла,
/// затем папка рядом с exe (dev).
#[tauri::command]
fn payload_status(app: AppHandle) -> PayloadStatus {
    let dir = resolve_payload(Some(&app), None);
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

/// Статус мода: установлен, версия, язык, число файлов, целостность.
#[tauri::command]
fn status_mod(game_dir: String) -> Result<StatusResult, String> {
    let result = status::status(Path::new(&game_dir)).map_err(|e| {
        log(&format!("status ERROR {}: {e}", game_dir));
        e.wire()
    })?;
    log(&format!(
        "status game={} installed={} version={} lang={} files={} integrity={}",
        game_dir,
        result.installed,
        result.version.as_deref().unwrap_or("-"),
        result.lang.as_deref().unwrap_or("-"),
        result.files,
        result.integrity.state
    ));
    Ok(result)
}

/// Установить мод. Прогресс уходит событием `mod-progress`.
#[tauri::command]
fn install_mod(
    app: AppHandle,
    game_dir: String,
    lang: String,
    payload_dir: Option<String>,
) -> Result<InstallResult, String> {
    let payload = resolve_payload(Some(&app), payload_dir);
    let game = PathBuf::from(&game_dir);
    let result =
        install::install_with_progress(&game, &payload, &lang, &mut |progress: InstallProgress| {
            let _ = app.emit("mod-progress", progress);
        })
        .map_err(|e| {
            log(&format!("install ERROR {}: {e}", game_dir));
            e.wire()
        })?;
    log(&format!(
        "install game={} payload={} lang={} version={} copied={} skipped={} removed={}",
        game_dir,
        payload.display(),
        result.lang,
        result.payload_version.as_deref().unwrap_or("-"),
        result.copied,
        result.skipped,
        result.removed_stale.len()
    ));
    Ok(result)
}

/// Обновить установленный мод: заменить изменившиеся по sha256 файлы, убрать
/// исчезнувшие из пакета, сохранить язык. Идемпотентно.
#[tauri::command]
fn update_mod(
    app: AppHandle,
    game_dir: String,
    payload_dir: Option<String>,
) -> Result<InstallResult, String> {
    let payload = resolve_payload(Some(&app), payload_dir);
    let game = PathBuf::from(&game_dir);
    let result =
        install::update_with_progress(&game, &payload, &mut |progress: InstallProgress| {
            let _ = app.emit("mod-progress", progress);
        })
        .map_err(|e| {
            log(&format!("update ERROR {}: {e}", game_dir));
            e.wire()
        })?;
    log(&format!(
        "update game={} payload={} lang={} version={} copied={} skipped={} removed={}",
        game_dir,
        payload.display(),
        result.lang,
        result.payload_version.as_deref().unwrap_or("-"),
        result.copied,
        result.skipped,
        result.removed_stale.len()
    ));
    Ok(result)
}

/// Удалить ровно поставленное (файлы манифеста при совпадении sha256).
#[tauri::command]
fn uninstall_mod(game_dir: String) -> Result<UninstallResult, String> {
    let result = uninstall::uninstall(Path::new(&game_dir)).map_err(|e| {
        log(&format!("uninstall ERROR {}: {e}", game_dir));
        e.wire()
    })?;
    log(&format!(
        "uninstall game={} deleted={} kept={} dirs={}",
        game_dir,
        result.deleted.len(),
        result.kept.len(),
        result.removed_dirs.len()
    ));
    Ok(result)
}

/// Сверить установку с манифестом (sha256 каждого файла).
#[tauri::command]
fn verify_mod(game_dir: String) -> Result<VerifyResult, String> {
    let result = verify::verify(Path::new(&game_dir)).map_err(|e| {
        log(&format!("verify ERROR {}: {e}", game_dir));
        e.wire()
    })?;
    log(&format!(
        "verify game={} installed={} ok={} checked={} missing={} modified={}",
        game_dir,
        result.installed,
        result.ok,
        result.checked,
        result.missing.len(),
        result.modified.len()
    ));
    Ok(result)
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
            status_mod,
            install_mod,
            update_mod,
            uninstall_mod,
            verify_mod
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска NeonTranslatorDX Manager");
}

// ---------------------------------------------------------------------------
// CLI: поддержка и E2E (в реальную игру без явного пути не ходит)
// ---------------------------------------------------------------------------

/// `--install <game> [lang]`: поставить мод из payload (по умолчанию `ru`).
pub fn cli_install(game: &str, lang: &str) -> i32 {
    let payload = install::find_payload(&exe_dir());
    println!("payload: {}", payload.display());
    match install::install(Path::new(game), &payload, lang) {
        Ok(result) => {
            println!(
                "установлено: {} файлов, записано {}, язык {}, версия {}",
                result.files.len(),
                result.copied,
                result.lang,
                result.payload_version.as_deref().unwrap_or("-")
            );
            println!("манифест: {}", result.manifest_path);
            0
        }
        Err(error) => {
            eprintln!("ОШИБКА: {error}");
            1
        }
    }
}

/// `--update <game>`: обновить установленное из payload бандла.
pub fn cli_update(game: &str) -> i32 {
    let payload = install::find_payload(&exe_dir());
    println!("payload: {}", payload.display());
    match install::update(Path::new(game), &payload) {
        Ok(result) => {
            println!(
                "обновлено: язык {}, версия {}, записано {}, пропущено {}, удалено {}",
                result.lang,
                result.payload_version.as_deref().unwrap_or("-"),
                result.copied,
                result.skipped,
                result.removed_stale.len()
            );
            for path in &result.removed_stale {
                println!("  удалено: {path}");
            }
            0
        }
        Err(error) => {
            eprintln!("ОШИБКА: {error}");
            1
        }
    }
}

/// `--status <game>`: напечатать статус и код 0/2.
pub fn cli_status(game: &str) -> i32 {
    match status::status(Path::new(game)) {
        Ok(result) => {
            println!(
                "установлен: {}, версия: {}, язык: {}, файлов: {}, целостность: {} (нет {}, изменено {})",
                result.installed,
                result.version.as_deref().unwrap_or("-"),
                result.lang.as_deref().unwrap_or("-"),
                result.files,
                result.integrity.state,
                result.integrity.missing,
                result.integrity.modified
            );
            if result.installed && result.integrity.state == "ok" {
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

/// `--uninstall <game>`: удалить поставленное из CLI.
pub fn cli_uninstall(game: &str) -> i32 {
    match uninstall::uninstall(Path::new(game)) {
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
    match verify::verify(Path::new(game)) {
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

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// `--selftest [payload]`: E2E собранного бинаря во временной папке:
/// install → status(ok) → update меньшим payload (лишний файл удалён) →
/// verify(ok) → uninstall(пусто). Реальную игру не трогает.
pub fn selftest(payload_arg: Option<String>) -> i32 {
    let payload = payload_arg
        .map(PathBuf::from)
        .unwrap_or_else(|| install::find_payload(&exe_dir()));
    if let Err(e) = install::validate_payload(&payload) {
        eprintln!("SELFTEST FAIL: payload: {e}");
        return 1;
    }

    let root = std::env::temp_dir().join(format!("ntdx-manager-selftest-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let work = root.join("payload");
    if let Err(e) = copy_tree(&payload, &work) {
        eprintln!("SELFTEST FAIL: copy payload: {e}");
        let _ = fs::remove_dir_all(&root);
        return 1;
    }
    let game = root.join("game");
    let data = game
        .join(neon_manager_core::GAME_DATA_FOLDER)
        .join("Managed");
    if let Err(e) = fs::create_dir_all(&data) {
        eprintln!("SELFTEST FAIL: temp: {e}");
        let _ = fs::remove_dir_all(&root);
        return 1;
    }
    let _ = fs::write(
        game.join(format!("{}.exe", neon_manager_core::GAME_FOLDER)),
        b"selftest",
    );
    let _ = fs::write(data.join("Assembly-CSharp.dll"), b"selftest");

    println!("SELFTEST dir: {}", game.display());
    println!(
        "SELFTEST payload: {} (копия во временной папке)",
        payload.display()
    );

    let langs = install::available_langs(&work);
    let lang = if langs.iter().any(|l| l == "ru") {
        "ru"
    } else {
        langs.first().map(String::as_str).unwrap_or("en")
    };
    let expected_version = install::read_payload_info(&work).version;

    let fail = |stage: &str, error: String| -> i32 {
        eprintln!("SELFTEST FAIL: {stage}: {error}");
        let _ = fs::remove_dir_all(&root);
        1
    };

    // 1. Установка.
    let install_result = match install::install(&game, &work, lang) {
        Ok(result) => result,
        Err(e) => return fail("install", e.wire()),
    };
    println!(
        "SELFTEST install: {} файлов, {} записано, язык {}",
        install_result.files.len(),
        install_result.copied,
        install_result.lang
    );

    // 2. Статус: установлен, версия пакета, целостность ok.
    let status_ok = match status::status(&game) {
        Ok(result) => result,
        Err(e) => return fail("status", e.wire()),
    };
    if !status_ok.installed || status_ok.integrity.state != "ok" {
        return fail(
            "status",
            format!(
                "installed={} state={}",
                status_ok.installed, status_ok.integrity.state
            ),
        );
    }
    if status_ok.version != expected_version {
        return fail(
            "status",
            format!("версия {:?} != {:?}", status_ok.version, expected_version),
        );
    }
    println!(
        "SELFTEST status: installed, version {}, lang {}, files {}, integrity ok",
        status_ok.version.as_deref().unwrap_or("-"),
        status_ok.lang.as_deref().unwrap_or("-"),
        status_ok.files
    );

    // 3. Обновление меньшим пакетом: убираем один словарь.
    let mod_path = work
        .join(neon_manager_core::MODS_FOLDER)
        .join(neon_manager_core::MOD_FOLDER);
    let mut dats: Vec<String> = fs::read_dir(&mod_path)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|name| name.starts_with("patch_") && name.ends_with(".dat"))
                .collect()
        })
        .unwrap_or_default();
    dats.sort();
    let Some(removed_name) = dats.last().cloned() else {
        return fail("update", "в payload нет patch_*.dat".to_string());
    };
    if let Err(e) = fs::remove_file(mod_path.join(&removed_name)) {
        return fail("update", format!("{removed_name}: {e}"));
    }
    // Версию пакета сдвигаем, чтобы статус показал новую.
    let update_version = format!(
        "{}.1",
        expected_version.clone().unwrap_or_else(|| "0".to_string())
    );
    let _ = fs::write(
        work.join(neon_manager_core::PAYLOAD_INFO),
        format!(
            "{{\"version\":\"{}\",\"langs\":{}}}\n",
            update_version,
            serde_json::to_string(&install::available_langs(&work)).unwrap_or_else(|_| "[]".into())
        ),
    );
    let expected_stale = format!(
        "{}/{}/{}",
        neon_manager_core::MODS_FOLDER,
        neon_manager_core::MOD_FOLDER,
        removed_name
    );

    let update_result = match install::update(&game, &work) {
        Ok(result) => result,
        Err(e) => return fail("update", e.wire()),
    };
    if !update_result.removed_stale.contains(&expected_stale) {
        return fail(
            "update",
            format!("лишний файл не удалён: {:?}", update_result.removed_stale),
        );
    }
    if update_result.payload_version.as_deref() != Some(update_version.as_str()) {
        return fail(
            "update",
            format!("версия {:?}", update_result.payload_version),
        );
    }
    println!(
        "SELFTEST update: удалён {}, записано {}, пропущено {}, версия {}",
        expected_stale, update_result.copied, update_result.skipped, update_version
    );

    // 4. Повторный прогон идемпотентен.
    let again = match install::update(&game, &work) {
        Ok(result) => result,
        Err(e) => return fail("update-again", e.wire()),
    };
    if again.copied != 0 || !again.removed_stale.is_empty() {
        return fail(
            "update-again",
            format!("copied={} removed={:?}", again.copied, again.removed_stale),
        );
    }
    println!("SELFTEST update again: 0 записей (идемпотентно)");

    // 5. Целостность и статус после обновления.
    let verified = match verify::verify(&game) {
        Ok(result) => result,
        Err(e) => return fail("verify", e.wire()),
    };
    if !verified.ok {
        return fail("verify", format!("{:?}", verified));
    }
    println!("SELFTEST verify: OK ({} файлов)", verified.checked);

    // 6. Удаление: пусто, маркеры игры целы.
    let removed = match uninstall::uninstall(&game) {
        Ok(result) => result,
        Err(e) => return fail("uninstall", e.wire()),
    };
    println!(
        "SELFTEST uninstall: удалено {}, папок {}",
        removed.deleted.len(),
        removed.removed_dirs.len()
    );
    let leftovers: Vec<String> = [
        game.join(neon_manager_core::LOADER),
        game.join(neon_manager_core::MODS_FOLDER),
        neon_manager_core::manifest_path(&game),
    ]
    .iter()
    .filter(|path| path.exists())
    .map(|path| path.display().to_string())
    .collect();
    let game_intact = game
        .join(format!("{}.exe", neon_manager_core::GAME_FOLDER))
        .is_file();

    let _ = fs::remove_dir_all(&root);
    if !leftovers.is_empty() || !game_intact {
        eprintln!("SELFTEST FAIL: остатки {leftovers:?}, игра цела: {game_intact}");
        return 1;
    }
    println!("SELFTEST PASS: после удаления пусто, файлы игры целы");
    0
}
