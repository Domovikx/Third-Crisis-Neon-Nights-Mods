//! Установка и обновление payload'а: копирование по sha256, `active_lang.txt`,
//! манифест с версией пакета.
//!
//! Payload — папка рядом с exe (v1):
//!
//! ```text
//! payload/
//!   payload.json                 {version, langs} — пишет build_payload.mts
//!   dwmapi.dll
//!   mods/NeonTranslatorDX/…      DLL, fonts/, patch_<lang>.dat (все языки)
//! ```
//!
//! Копируется только лоадер и папка мода: `payload.json` — описание пакета,
//! в игру ему нельзя.
//!
//! `install` пишет всё заново, `update` — только то, что отличается по sha256,
//! и удаляет свои файлы, которых в новом пакете больше нет. Обе операции
//! идемпотентны: повторный запуск после обрыва доводит установку до конца.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode};
use crate::manifest::{self, ManifestFile};
use crate::{
    detect, fsutil, mod_dir, rel_path, ACTIVE_LANG, LOADER, MODS_FOLDER, MOD_FOLDER, PAYLOAD_INFO,
    RUNTIME_DLL, SOURCE_LANG,
};

/// Что лежит в payload'е (пишет `scripts/build_payload.mts`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PayloadInfo {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub langs: Vec<String>,
}

/// Прогресс копирования (уходит в UI событием).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub done: usize,
    pub total: usize,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub lang: String,
    pub payload_version: Option<String>,
    pub files: Vec<ManifestFile>,
    /// Файлов реально записано (новые или изменённые).
    pub copied: usize,
    /// Файлов уже совпадало по sha256 — не перезаписывались.
    pub skipped: usize,
    /// Записано байт (без пропущенных).
    pub bytes: u64,
    pub manifest_path: String,
    /// Файлы прошлой установки, которых нет в новом пакете (удалены).
    pub removed_stale: Vec<String>,
}

/// Папка payload'а по умолчанию: рядом с exe.
pub fn payload_dir(exe_dir: &Path) -> PathBuf {
    exe_dir.join("payload")
}

/// Прочитать `payload.json` (нет файла — пустые поля, это не ошибка).
pub fn read_payload_info(payload: &Path) -> PayloadInfo {
    let path = payload.join(PAYLOAD_INFO);
    if !path.is_file() {
        return PayloadInfo::default();
    }
    fsutil::read_text(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Языки, для которых в payload'е есть словарь (`en` — native, без словаря).
pub fn available_langs(payload: &Path) -> Vec<String> {
    let dir = payload.join(MODS_FOLDER).join(MOD_FOLDER);
    let mut langs = vec![SOURCE_LANG.to_string()];
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(code) = name
                .strip_prefix("patch_")
                .and_then(|rest| rest.strip_suffix(".dat"))
            {
                if code.len() == 2 && code.chars().all(|c| c.is_ascii_lowercase()) {
                    langs.push(code.to_string());
                }
            }
        }
    }
    langs.sort();
    langs.dedup();
    langs
}

/// Проверить payload: папка, лоадер, рантайм. Возвращает описание пакета.
pub fn validate_payload(payload: &Path) -> Result<PayloadInfo, CoreError> {
    if !payload.is_dir() {
        return Err(CoreError::new(
            ErrorCode::PayloadMissing,
            format!("нет папки payload: {}", payload.display()),
        ));
    }
    for required in [
        payload.join(LOADER),
        payload.join(MODS_FOLDER).join(MOD_FOLDER).join(RUNTIME_DLL),
    ] {
        if !required.is_file() {
            return Err(CoreError::new(
                ErrorCode::PayloadMissing,
                format!("в payload нет файла: {}", required.display()),
            ));
        }
    }
    let mut info = read_payload_info(payload);
    if info.langs.is_empty() {
        info.langs = available_langs(payload);
    }
    Ok(info)
}

/// Установить пакет в игру. `lang` — стартовый язык (`en` = без словаря).
pub fn install(game: &Path, payload: &Path, lang: &str) -> Result<InstallResult, CoreError> {
    install_with_progress(game, payload, lang, &mut |_| {})
}

/// То же с колбэком прогресса (Tauri шлёт его в UI событием).
pub fn install_with_progress(
    game: &Path,
    payload: &Path,
    lang: &str,
    on_progress: &mut dyn FnMut(InstallProgress),
) -> Result<InstallResult, CoreError> {
    apply(game, payload, Mode::Install(lang.to_string()), on_progress)
}

/// Обновить установленный мод: заменить только изменившиеся файлы, убрать
/// исчезнувшие из пакета, сохранить активный язык (если он есть в пакете).
pub fn update(game: &Path, payload: &Path) -> Result<InstallResult, CoreError> {
    update_with_progress(game, payload, &mut |_| {})
}

/// То же с колбэком прогресса.
pub fn update_with_progress(
    game: &Path,
    payload: &Path,
    on_progress: &mut dyn FnMut(InstallProgress),
) -> Result<InstallResult, CoreError> {
    let Some(old) = manifest::read(game)? else {
        return Err(CoreError::new(
            ErrorCode::ManifestMissing,
            format!(
                "мод не установлен: нет {} — сначала «Установить»",
                crate::manifest_path(game).display()
            ),
        ));
    };
    let preferred = if old.lang.is_empty() {
        SOURCE_LANG.to_string()
    } else {
        old.lang
    };
    apply(game, payload, Mode::Update(preferred), on_progress)
}

#[derive(Debug, Clone)]
enum Mode {
    /// `lang` задан пользователем (стартовый язык свежей установки).
    Install(String),
    /// `preferred` — язык прошлой установки; если словаря нет в пакете,
    /// берётся `ru`, иначе первый доступный.
    Update(String),
}

fn apply(
    game: &Path,
    payload: &Path,
    mode: Mode,
    on_progress: &mut dyn FnMut(InstallProgress),
) -> Result<InstallResult, CoreError> {
    let check = detect::check_game_dir(Some(game));
    if !check.ok {
        return Err(CoreError::new(
            ErrorCode::GameInvalid,
            format!("{}: нет {}", game.display(), check.missing.join(", ")),
        ));
    }
    let info = validate_payload(payload)?;

    let langs = available_langs(payload);
    let lang = match mode {
        Mode::Install(lang) => {
            if !is_lang_code(&lang) {
                return Err(CoreError::new(
                    ErrorCode::LangUnavailable,
                    format!("странный код языка: {lang}"),
                ));
            }
            if !langs.iter().any(|l| l == &lang) {
                return Err(CoreError::new(
                    ErrorCode::LangUnavailable,
                    format!("patch_{lang}.dat нет в пакете (есть: {})", langs.join(", ")),
                ));
            }
            lang
        }
        Mode::Update(preferred) => {
            if langs.iter().any(|l| l == &preferred) {
                preferred
            } else if langs.iter().any(|l| l == "ru") {
                "ru".to_string()
            } else {
                langs
                    .first()
                    .cloned()
                    .unwrap_or_else(|| SOURCE_LANG.to_string())
            }
        }
    };

    // Что из прошлой установки больше не входит в пакет — убрать (только своё
    // и только при совпадении sha256: правленый руками файл не трогаем).
    let payload_files: Vec<String> = fsutil::list_files(payload)?
        .into_iter()
        .filter(|rel| should_install(rel))
        .collect();
    let removed_stale = remove_stale(game, &payload_files)?;

    // +1 — `active_lang.txt`: он пишется после копирования, но тоже идёт в
    // прогресс, иначе «20 из 20» висело бы до открытия экрана «Готово».
    let total = payload_files.len() + 1;
    let mut manifest_files: Vec<ManifestFile> = Vec::new();
    let mut copied = 0usize;
    let mut skipped = 0usize;
    let mut bytes = 0u64;
    let mut done = 0usize;

    for rel in &payload_files {
        let from = payload.join(rel);
        let to = manifest::resolve_inside(game, rel)
            .ok_or_else(|| CoreError::new(ErrorCode::UnsafePath, rel.clone()))?;
        let size = fs::metadata(&from)
            .map_err(|e| CoreError::io(format!("{}: {e}", from.display())))?
            .len();
        let source_sha = fsutil::sha256_file(&from)?;
        let up_to_date = to.is_file()
            && fs::metadata(&to).map(|m| m.len()).ok() == Some(size)
            && fsutil::sha256_file(&to).ok().as_deref() == Some(source_sha.as_str());
        if up_to_date {
            skipped += 1;
        } else {
            fsutil::copy_atomic(&from, &to)?;
            copied += 1;
            bytes += size;
        }
        manifest_files.push(ManifestFile {
            path: rel.clone(),
            size,
            sha256: source_sha,
        });
        done += 1;
        on_progress(InstallProgress {
            done,
            total,
            path: rel.clone(),
        });
    }

    // active_lang.txt — наш файл, тоже в манифест (удаляется вместе с модом).
    let active = mod_dir(game).join(ACTIVE_LANG);
    let active_rel = rel_path(active.strip_prefix(game).unwrap_or(&active));
    let active_now = fsutil::read_text(&active).ok();
    if active_now.as_deref() == Some(lang.as_str()) {
        skipped += 1;
    } else {
        fsutil::write_atomic(&active, &lang)?;
        copied += 1;
        bytes += lang.len() as u64;
    }
    manifest_files.push(ManifestFile {
        path: active_rel.clone(),
        size: fs::metadata(&active).map(|m| m.len()).unwrap_or(0),
        sha256: fsutil::sha256_file(&active)?,
    });
    done += 1;
    on_progress(InstallProgress {
        done,
        total,
        path: active_rel,
    });

    manifest::write(game, &lang, info.version.as_deref(), &mut manifest_files)?;

    Ok(InstallResult {
        lang,
        payload_version: info.version,
        copied,
        skipped,
        bytes,
        manifest_path: crate::manifest_path(game).display().to_string(),
        removed_stale,
        files: manifest_files,
    })
}

/// Копируем только лоадер и папку мода (payload.json — описание пакета).
pub fn should_install(rel: &str) -> bool {
    rel == LOADER || rel.starts_with(&format!("{MODS_FOLDER}/{MOD_FOLDER}/"))
}

/// Код языка: две строчные латинские буквы.
pub fn is_lang_code(lang: &str) -> bool {
    lang.len() == 2 && lang.chars().all(|c| c.is_ascii_lowercase())
}

/// Удалить файлы прошлого манифеста, которых нет в новом пакете.
fn remove_stale(game: &Path, payload_files: &[String]) -> Result<Vec<String>, CoreError> {
    let Some(old) = manifest::read(game)? else {
        return Ok(Vec::new());
    };
    let mut removed = Vec::new();
    for file in old.files {
        if payload_files.iter().any(|rel| rel == &file.path) {
            continue;
        }
        // active_lang.txt менеджер пишет заново при каждом прогоне.
        if file.path == format!("{MODS_FOLDER}/{MOD_FOLDER}/{ACTIVE_LANG}") {
            continue;
        }
        let Some(abs) = manifest::resolve_inside(game, &file.path) else {
            continue;
        };
        if !manifest::is_install_path(&file.path) || !abs.is_file() {
            continue;
        }
        if fsutil::sha256_file(&abs).ok().as_deref() != Some(file.sha256.as_str()) {
            continue;
        }
        fs::remove_file(&abs).map_err(|e| CoreError::io(format!("{}: {e}", abs.display())))?;
        removed.push(file.path);
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest;
    use crate::testutil::{fake_game, fake_payload, TempDir};

    #[test]
    fn installs_payload_and_writes_manifest_with_hashes() {
        let tmp = TempDir::new("install");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru", "de"]);
        let result = install(&game, &payload, "ru").unwrap();

        assert_eq!(result.lang, "ru");
        assert_eq!(result.payload_version.as_deref(), Some("test"));
        assert_eq!(result.skipped, 0);
        assert!(game.join(LOADER).is_file());
        assert!(mod_dir(&game).join(RUNTIME_DLL).is_file());
        assert!(mod_dir(&game).join("patch_de.dat").is_file());
        assert_eq!(
            fs::read_to_string(mod_dir(&game).join(ACTIVE_LANG)).unwrap(),
            "ru"
        );
        // payload.json в игру не попадает.
        assert!(!game.join(PAYLOAD_INFO).exists());

        let manifest = manifest::read(&game).unwrap().unwrap();
        assert_eq!(manifest.lang, "ru");
        assert_eq!(manifest.payload_version.as_deref(), Some("test"));
        assert_eq!(manifest.files.len(), result.files.len());
        for file in &manifest.files {
            let abs = game.join(&file.path);
            assert!(abs.is_file(), "{}", file.path);
            assert_eq!(fsutil::sha256_file(&abs).unwrap(), file.sha256);
            assert_eq!(fs::metadata(&abs).unwrap().len(), file.size);
        }
        let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"dwmapi.dll"));
        assert!(paths.contains(&"mods/NeonTranslatorDX/active_lang.txt"));
    }

    #[test]
    fn install_is_idempotent_and_switches_language() {
        let tmp = TempDir::new("install-twice");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru", "de"]);
        install(&game, &payload, "ru").unwrap();
        let second = install(&game, &payload, "de").unwrap();
        assert_eq!(second.lang, "de");
        assert_eq!(second.copied, 1, "переписаться должен только active_lang");
        assert!(second.skipped > 0);
        assert_eq!(
            fs::read_to_string(mod_dir(&game).join(ACTIVE_LANG)).unwrap(),
            "de"
        );
        assert!(mod_dir(&game).join("patch_ru.dat").is_file());
        assert_eq!(manifest::read(&game).unwrap().unwrap().lang, "de");
    }

    #[test]
    fn reinstall_removes_files_dropped_from_payload() {
        let tmp = TempDir::new("install-stale");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru", "it"]);
        install(&game, &payload, "ru").unwrap();
        assert!(mod_dir(&game).join("patch_it.dat").is_file());

        fs::remove_file(mod_dir(&payload).join("patch_it.dat")).unwrap();
        let result = install(&game, &payload, "ru").unwrap();
        assert_eq!(
            result.removed_stale,
            vec!["mods/NeonTranslatorDX/patch_it.dat"]
        );
        assert!(!mod_dir(&game).join("patch_it.dat").exists());
    }

    #[test]
    fn reinstall_keeps_modified_stale_file() {
        let tmp = TempDir::new("install-stale-keep");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru", "it"]);
        install(&game, &payload, "ru").unwrap();
        let stale = mod_dir(&game).join("patch_it.dat");
        fs::write(&stale, "{\"hand\":\"edited\"}").unwrap();
        fs::remove_file(mod_dir(&payload).join("patch_it.dat")).unwrap();
        let result = install(&game, &payload, "ru").unwrap();
        assert!(result.removed_stale.is_empty());
        assert!(stale.is_file());
    }

    #[test]
    fn rejects_unknown_language_and_non_game_dir() {
        let tmp = TempDir::new("install-errors");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru"]);
        let err = install(&game, &payload, "de").unwrap_err();
        assert_eq!(err.code, ErrorCode::LangUnavailable);

        let not_game = tmp.path().join("not-a-game");
        fs::create_dir_all(&not_game).unwrap();
        let err = install(&not_game, &payload, "ru").unwrap_err();
        assert_eq!(err.code, ErrorCode::GameInvalid);
    }

    #[test]
    fn rejects_missing_payload_and_incomplete_payload() {
        let tmp = TempDir::new("payload-errors");
        let game = fake_game(&tmp);
        let err = install(&game, &tmp.path().join("nope"), "ru").unwrap_err();
        assert_eq!(err.code, ErrorCode::PayloadMissing);

        let payload = fake_payload(&tmp, &["ru"]);
        fs::remove_file(payload.join(LOADER)).unwrap();
        let err = install(&game, &payload, "ru").unwrap_err();
        assert_eq!(err.code, ErrorCode::PayloadMissing);
        assert!(err.detail.contains(LOADER));
    }

    #[test]
    fn progress_reaches_total_once_per_file() {
        let tmp = TempDir::new("install-progress");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru"]);
        let mut seen: Vec<(usize, usize)> = Vec::new();
        install_with_progress(&game, &payload, "ru", &mut |p| seen.push((p.done, p.total)))
            .unwrap();
        assert!(!seen.is_empty());
        assert_eq!(seen.last().unwrap().0, seen.last().unwrap().1);
        for (i, (done, _)) in seen.iter().enumerate() {
            assert_eq!(*done, i + 1);
        }
    }

    #[test]
    fn update_replaces_adds_removes_and_is_idempotent() {
        let tmp = TempDir::new("update");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru", "it"]);
        install(&game, &payload, "ru").unwrap();

        // Новый пакет: DLL изменён, patch_it убран, шрифт добавлен.
        fs::write(mod_dir(&payload).join(RUNTIME_DLL), b"runtime-v2").unwrap();
        fs::remove_file(mod_dir(&payload).join("patch_it.dat")).unwrap();
        fs::write(mod_dir(&payload).join("fonts").join("Extra.ttf"), b"extra").unwrap();
        fs::write(
            payload.join(PAYLOAD_INFO),
            r#"{"version":"v2","langs":["ru"]}"#,
        )
        .unwrap();

        let result = update(&game, &payload).unwrap();
        assert_eq!(result.payload_version.as_deref(), Some("v2"));
        assert_eq!(result.copied, 2, "DLL + новый шрифт");
        assert!(result.skipped > 0, "остальные файлы уже совпадали");
        assert_eq!(
            result.removed_stale,
            vec!["mods/NeonTranslatorDX/patch_it.dat"]
        );
        assert_eq!(
            fs::read_to_string(mod_dir(&game).join(RUNTIME_DLL)).unwrap(),
            "runtime-v2"
        );
        assert!(mod_dir(&game).join("fonts/Extra.ttf").is_file());
        assert!(!mod_dir(&game).join("patch_it.dat").exists());
        assert_eq!(
            manifest::read(&game)
                .unwrap()
                .unwrap()
                .payload_version
                .as_deref(),
            Some("v2")
        );

        // Повторный прогон: ничего не пишет и ничего не удаляет.
        let again = update(&game, &payload).unwrap();
        assert_eq!(again.copied, 0);
        assert_eq!(again.removed_stale, Vec::<String>::new());
        assert_eq!(again.files.len(), again.skipped);
        assert!(crate::verify::verify(&game).unwrap().ok);
    }

    #[test]
    fn update_finishes_after_interruption() {
        let tmp = TempDir::new("update-resume");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru", "it"]);
        install(&game, &payload, "ru").unwrap();

        // Обрыв «на середине»: новый файл уже скопирован, манифест — старый.
        fs::remove_file(mod_dir(&payload).join("patch_it.dat")).unwrap();
        fs::write(mod_dir(&payload).join("fonts").join("New.ttf"), b"new").unwrap();
        fs::create_dir_all(mod_dir(&game).join("fonts")).unwrap();
        fs::copy(
            mod_dir(&payload).join("fonts/New.ttf"),
            mod_dir(&game).join("fonts/New.ttf"),
        )
        .unwrap();

        let result = update(&game, &payload).unwrap();
        assert_eq!(result.copied, 0, "уже скопированный файл не переписывается");
        assert_eq!(
            result.removed_stale,
            vec!["mods/NeonTranslatorDX/patch_it.dat"]
        );
        assert!(crate::verify::verify(&game).unwrap().ok);
    }

    #[test]
    fn update_keeps_language_and_falls_back_when_dictionary_removed() {
        let tmp = TempDir::new("update-lang");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru", "de"]);
        install(&game, &payload, "de").unwrap();
        let kept = update(&game, &payload).unwrap();
        assert_eq!(kept.lang, "de");

        fs::remove_file(mod_dir(&payload).join("patch_de.dat")).unwrap();
        let fallback = update(&game, &payload).unwrap();
        assert_eq!(fallback.lang, "ru");
        assert_eq!(
            fs::read_to_string(mod_dir(&game).join(ACTIVE_LANG)).unwrap(),
            "ru"
        );
        assert!(!mod_dir(&game).join("patch_de.dat").exists());
    }

    #[test]
    fn update_without_manifest_is_an_error() {
        let tmp = TempDir::new("update-none");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru"]);
        let err = update(&game, &payload).unwrap_err();
        assert_eq!(err.code, ErrorCode::ManifestMissing);
        assert!(!game.join(LOADER).exists());
    }

    #[test]
    fn lang_codes_are_two_lowercase_letters() {
        assert!(is_lang_code("ru"));
        assert!(!is_lang_code("RU"));
        assert!(!is_lang_code("rus"));
        assert!(!is_lang_code("../ru"));
    }
}
