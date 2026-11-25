//! Проверка установки: каждый файл манифеста на месте и с тем же sha256.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::error::CoreError;
use crate::manifest;
use crate::{fsutil, mod_dir, rel_path, MANIFEST_NAME, RUNTIME_ARTIFACTS};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyMismatch {
    pub path: String,
    pub expected: String,
    pub actual: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    /// Мод установлен (нашёлся манифест).
    pub installed: bool,
    /// Все файлы манифеста на месте и с ожидаемыми хэшами.
    pub ok: bool,
    pub checked: usize,
    pub lang: Option<String>,
    pub missing: Vec<String>,
    pub modified: Vec<VerifyMismatch>,
    /// Пути из манифеста, которые нельзя проверять (выход за папку мода).
    pub invalid: Vec<String>,
    /// Файлы в папке мода, которых нет в манифесте (логи рантайма не считаем).
    pub unlisted: Vec<String>,
}

impl VerifyResult {
    fn not_installed() -> Self {
        Self {
            installed: false,
            ok: false,
            checked: 0,
            lang: None,
            missing: Vec::new(),
            modified: Vec::new(),
            invalid: Vec::new(),
            unlisted: Vec::new(),
        }
    }
}

/// Сверить установку с её манифестом. Отсутствие манифеста — не ошибка:
/// `installed: false` (UI скажет «мод не установлен»).
pub fn verify(game: &Path) -> Result<VerifyResult, CoreError> {
    let Some(install_manifest) = manifest::read(game)? else {
        return Ok(VerifyResult::not_installed());
    };

    let mut result = VerifyResult {
        installed: true,
        ok: true,
        checked: 0,
        lang: Some(install_manifest.lang.clone()).filter(|l| !l.is_empty()),
        missing: Vec::new(),
        modified: Vec::new(),
        invalid: Vec::new(),
        unlisted: Vec::new(),
    };

    let mut listed = Vec::new();
    for file in &install_manifest.files {
        result.checked += 1;
        let Some(abs) = manifest::resolve_inside(game, &file.path) else {
            result.invalid.push(file.path.clone());
            result.ok = false;
            continue;
        };
        if !manifest::is_install_path(&file.path) {
            result.invalid.push(file.path.clone());
            result.ok = false;
            continue;
        }
        listed.push(abs.clone());
        if !abs.is_file() {
            result.missing.push(file.path.clone());
            result.ok = false;
            continue;
        }
        let actual = fsutil::sha256_file(&abs)?;
        if actual != file.sha256 {
            result.ok = false;
            result.modified.push(VerifyMismatch {
                path: file.path.clone(),
                expected: file.sha256.clone(),
                actual: Some(actual),
            });
        }
    }

    // Что появилось в папке мода сверх манифеста (логи/дампы рантайма — не в счёт).
    let mod_path = mod_dir(game);
    if mod_path.is_dir() {
        for rel in fsutil::list_files(&mod_path)? {
            let abs = mod_path.join(&rel);
            let game_rel = rel_path(abs.strip_prefix(game).unwrap_or(&abs));
            if rel == MANIFEST_NAME {
                continue;
            }
            if listed.iter().any(|p| p == &abs) {
                continue;
            }
            if RUNTIME_ARTIFACTS.iter().any(|name| rel == *name) {
                continue;
            }
            result.unlisted.push(game_rel);
        }
    }

    Ok(result)
}

/// Быстрая проверка «файл на месте и не пустой» (для UI-индикатора).
pub fn file_ok(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::install;
    use crate::testutil::{fake_game, fake_payload, TempDir};

    #[test]
    fn verify_ok_after_install() {
        let tmp = TempDir::new("verify-ok");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru"]);
        let installed = install(&game, &payload, "ru").unwrap();
        let result = verify(&game).unwrap();
        assert!(result.installed && result.ok);
        assert_eq!(result.checked, installed.copied);
        assert_eq!(result.lang.as_deref(), Some("ru"));
        assert!(result.missing.is_empty() && result.modified.is_empty());
        assert!(result.unlisted.is_empty(), "{:?}", result.unlisted);
    }

    #[test]
    fn verify_reports_missing_and_modified() {
        let tmp = TempDir::new("verify-broken");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru"]);
        install(&game, &payload, "ru").unwrap();

        fs::remove_file(mod_dir(&game).join("patch_ru.dat")).unwrap();
        fs::write(mod_dir(&game).join("NeonTranslatorDX.dll"), "tampered").unwrap();

        let result = verify(&game).unwrap();
        assert!(!result.ok);
        assert_eq!(result.missing, vec!["mods/NeonTranslatorDX/patch_ru.dat"]);
        assert_eq!(result.modified.len(), 1);
        assert!(result.modified[0].path.ends_with("NeonTranslatorDX.dll"));
        assert_ne!(
            result.modified[0].expected,
            result.modified[0].actual.clone().unwrap()
        );
    }

    #[test]
    fn verify_lists_extra_files_but_ignores_runtime_log() {
        let tmp = TempDir::new("verify-extra");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru"]);
        install(&game, &payload, "ru").unwrap();
        fs::write(mod_dir(&game).join("NeonTranslatorDX.log"), "log").unwrap();
        fs::write(mod_dir(&game).join("extra.bin"), "extra").unwrap();

        let result = verify(&game).unwrap();
        assert!(result.ok, "лог рантайма не ломает целостность");
        assert_eq!(result.unlisted, vec!["mods/NeonTranslatorDX/extra.bin"]);
    }

    #[test]
    fn verify_not_installed_is_not_an_error() {
        let tmp = TempDir::new("verify-none");
        let game = fake_game(&tmp);
        let result = verify(&game).unwrap();
        assert!(!result.installed);
        assert!(!result.ok);
        assert_eq!(result.checked, 0);
    }

    #[test]
    fn verify_after_uninstall_is_not_installed() {
        let tmp = TempDir::new("verify-uninstalled");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru"]);
        install(&game, &payload, "ru").unwrap();
        crate::uninstall::uninstall(&game).unwrap();
        let result = verify(&game).unwrap();
        assert!(!result.installed);
        assert!(!game.join("dwmapi.dll").exists());
    }
}
