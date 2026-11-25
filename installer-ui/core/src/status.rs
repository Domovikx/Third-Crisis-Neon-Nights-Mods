//! Статус менеджера: стоит ли мод, какая версия/язык, цела ли установка.
//!
//! `status` не бросает ошибку на битый манифест: менеджер обязан показать
//! «повреждён» и предложить переустановку, а не упасть на старте.

use std::path::Path;

use serde::Serialize;

use crate::error::CoreError;
use crate::manifest;
use crate::{mod_dir, verify, MANIFEST_NAME};

/// Краткая целостность для статуса (полные списки — `verify`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusIntegrity {
    /// `ok` | `missing` | `modified` | `broken` | `unknown`.
    pub state: String,
    pub checked: usize,
    pub missing: usize,
    pub modified: usize,
    pub unlisted: usize,
}

impl StatusIntegrity {
    fn unknown() -> Self {
        Self {
            state: "unknown".into(),
            checked: 0,
            missing: 0,
            modified: 0,
            unlisted: 0,
        }
    }

    fn broken() -> Self {
        Self {
            state: "broken".into(),
            ..Self::unknown()
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    /// Манифест есть — мод считается установленным (даже если файлы побиты).
    pub installed: bool,
    /// Папка `mods/NeonTranslatorDX` существует (даже без манифеста).
    pub mod_dir_exists: bool,
    pub manifest_found: bool,
    /// Версия установленного пакета из манифеста.
    pub version: Option<String>,
    pub lang: Option<String>,
    pub files: usize,
    pub installed_at: Option<String>,
    pub integrity: StatusIntegrity,
    /// Ошибка чтения манифеста (`manifest-invalid`), если он повреждён.
    pub problem: Option<String>,
}

/// Собрать статус: манифест + сверка файлов по sha256.
pub fn status(game: &Path) -> Result<StatusResult, CoreError> {
    let mod_path = mod_dir(game);
    let mod_dir_exists = mod_path.is_dir();
    let manifest_path = crate::manifest_path(game);
    let manifest_found = manifest_path.is_file();

    let manifest = match manifest::read(game) {
        Ok(value) => value,
        Err(error) => {
            return Ok(StatusResult {
                installed: true,
                mod_dir_exists,
                manifest_found,
                version: None,
                lang: None,
                files: 0,
                installed_at: None,
                integrity: StatusIntegrity::broken(),
                problem: Some(error.wire()),
            });
        }
    };

    let Some(manifest) = manifest else {
        return Ok(StatusResult {
            installed: false,
            mod_dir_exists,
            manifest_found,
            version: None,
            lang: None,
            files: 0,
            installed_at: None,
            integrity: StatusIntegrity::unknown(),
            problem: None,
        });
    };

    // Полная сверка: статус должен отвечать «цел/нет/изменён», а не «файл есть».
    let verified = verify::verify(game)?;
    let state = if !verified.modified.is_empty() {
        "modified"
    } else if !verified.missing.is_empty() || !verified.invalid.is_empty() {
        "missing"
    } else {
        "ok"
    };

    Ok(StatusResult {
        installed: true,
        mod_dir_exists,
        manifest_found,
        version: manifest.payload_version.clone(),
        lang: Some(manifest.lang.clone()).filter(|l| !l.is_empty()),
        files: manifest.files.len(),
        installed_at: Some(manifest.installed_at.clone()).filter(|s| !s.is_empty()),
        integrity: StatusIntegrity {
            state: state.into(),
            checked: verified.checked,
            missing: verified.missing.len() + verified.invalid.len(),
            modified: verified.modified.len(),
            unlisted: verified.unlisted.len(),
        },
        problem: None,
    })
}

/// Есть ли в папке мода `install-manifest.json` (быстрая проверка без чтения).
pub fn manifest_exists(game: &Path) -> bool {
    game.join(crate::MODS_FOLDER)
        .join(crate::MOD_FOLDER)
        .join(MANIFEST_NAME)
        .is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::{install, update};
    use crate::testutil::{fake_game, fake_payload, TempDir};
    use std::fs;

    #[test]
    fn status_without_mod_is_unknown() {
        let tmp = TempDir::new("status-none");
        let game = fake_game(&tmp);
        let result = status(&game).unwrap();
        assert!(!result.installed);
        assert!(!result.mod_dir_exists);
        assert!(!result.manifest_found);
        assert_eq!(result.integrity.state, "unknown");
        assert_eq!(result.files, 0);
        assert!(result.problem.is_none());
        assert!(!manifest_exists(&game));
    }

    #[test]
    fn status_after_install_reports_version_lang_and_ok() {
        let tmp = TempDir::new("status-installed");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru", "de"]);
        install(&game, &payload, "ru").unwrap();

        let result = status(&game).unwrap();
        assert!(result.installed && result.manifest_found && result.mod_dir_exists);
        assert_eq!(result.version.as_deref(), Some("test"));
        assert_eq!(result.lang.as_deref(), Some("ru"));
        assert_eq!(result.files, 6);
        assert_eq!(result.integrity.state, "ok");
        assert_eq!(result.integrity.checked, 6);
        assert!(result.problem.is_none());
        assert!(manifest_exists(&game));
    }

    #[test]
    fn status_detects_modified_and_missing_files() {
        let tmp = TempDir::new("status-broken");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru"]);
        install(&game, &payload, "ru").unwrap();

        fs::write(mod_dir(&game).join("NeonTranslatorDX.dll"), "tampered").unwrap();
        let modified = status(&game).unwrap();
        assert_eq!(modified.integrity.state, "modified");
        assert_eq!(modified.integrity.modified, 1);

        // Вернули DLL и убрали словарь: теперь состояние — missing.
        fs::write(
            mod_dir(&game).join("NeonTranslatorDX.dll"),
            b"runtime-bytes",
        )
        .unwrap();
        fs::remove_file(mod_dir(&game).join("patch_ru.dat")).unwrap();
        let missing = status(&game).unwrap();
        assert_eq!(missing.integrity.state, "missing");
        assert_eq!(missing.integrity.missing, 1);
        assert_eq!(missing.integrity.modified, 0);
        assert!(missing.installed);
    }

    #[test]
    fn status_reports_broken_manifest_instead_of_failing() {
        let tmp = TempDir::new("status-manifest-broken");
        let game = fake_game(&tmp);
        let mod_path = mod_dir(&game);
        fs::create_dir_all(&mod_path).unwrap();
        fs::write(crate::manifest_path(&game), "{not json").unwrap();

        let result = status(&game).unwrap();
        assert!(result.installed && result.manifest_found);
        assert_eq!(result.integrity.state, "broken");
        assert!(result.problem.unwrap().starts_with("manifest-invalid"));
    }

    #[test]
    fn status_updates_version_after_update() {
        let tmp = TempDir::new("status-update");
        let game = fake_game(&tmp);
        let payload = fake_payload(&tmp, &["ru"]);
        install(&game, &payload, "ru").unwrap();
        fs::write(
            payload.join(crate::PAYLOAD_INFO),
            r#"{"version":"2026.12.01","langs":["ru"]}"#,
        )
        .unwrap();
        update(&game, &payload).unwrap();
        assert_eq!(
            status(&game).unwrap().version.as_deref(),
            Some("2026.12.01")
        );
    }
}
