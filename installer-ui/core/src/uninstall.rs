//! Удаление: ровно то, что записано в манифесте, и только при совпадении sha256.
//!
//! Гарантии:
//!   • чужие файлы не трогаются — путь обязан быть `dwmapi.dll` или внутри
//!     `mods/NeonTranslatorDX/` (подделанный манифест с `..` отклоняется);
//!   • изменённый после установки файл остаётся (его правка — чужая работа);
//!   • пустые папки (`fonts`, папка мода, `mods`) удаляются, непустые — нет.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{CoreError, ErrorCode};
use crate::manifest;
use crate::{fsutil, mod_dir, rel_path, FONT_SUBDIR, MODS_FOLDER, RUNTIME_ARTIFACTS};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallTarget {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub exists: bool,
    /// Хэш на диске совпадает с манифестом (файл не правили руками).
    pub matches: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPlan {
    pub game: String,
    pub manifest: String,
    pub lang: Option<String>,
    pub targets: Vec<UninstallTarget>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResult {
    pub deleted: Vec<String>,
    pub kept: Vec<String>,
    pub removed_dirs: Vec<String>,
    pub manifest_deleted: bool,
}

/// Что будет удалено. Ошибка, если манифеста нет или он битый.
pub fn plan_uninstall(game: &Path) -> Result<UninstallPlan, CoreError> {
    let path = crate::manifest_path(game);
    let Some(manifest) = manifest::read(game)? else {
        return Err(CoreError::new(
            ErrorCode::ManifestMissing,
            format!(
                "манифест не найден: {} — поставьте мод заново или удалите вручную",
                path.display()
            ),
        ));
    };

    let mut warnings = Vec::new();
    let mut targets = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();

    for file in &manifest.files {
        let Some(abs) = manifest::resolve_inside(game, &file.path) else {
            warnings.push(format!("пропущен опасный путь из манифеста: {}", file.path));
            continue;
        };
        if !manifest::is_install_path(&file.path) {
            warnings.push(format!(
                "пропущен путь вне папки мода: {} (удаление только своего)",
                file.path
            ));
            continue;
        }
        seen.push(abs.clone());
        let exists = abs.is_file();
        // active_lang.txt переключается в игре — хэш сверять бессмысленно.
        let mutable = crate::is_runtime_mutable(&file.path);
        let matches =
            exists && (mutable || fsutil::sha256_file(&abs).ok().as_deref() == Some(&file.sha256));
        if exists && !matches {
            warnings.push(format!(
                "файл изменён после установки — оставлю: {}",
                file.path
            ));
        }
        targets.push(UninstallTarget {
            path: file.path.clone(),
            size: file.size,
            sha256: file.sha256.clone(),
            exists,
            matches,
        });
    }

    // Рантайм создаёт эти файлы сам; они наши по имени в нашей папке.
    let mod_path = mod_dir(game);
    let mut own = Vec::new();
    for name in RUNTIME_ARTIFACTS {
        own.push(mod_path.join(name));
    }
    own.push(mod_path.join("dwmapi_real.dll"));
    for abs in own {
        if seen.iter().any(|p| p == &abs) || !abs.is_file() {
            continue;
        }
        seen.push(abs.clone());
        targets.push(UninstallTarget {
            path: rel_path(abs.strip_prefix(game).unwrap_or(&abs)),
            size: fs::metadata(&abs).map(|m| m.len()).unwrap_or(0),
            sha256: String::new(),
            exists: true,
            matches: true,
        });
    }

    Ok(UninstallPlan {
        game: game.display().to_string(),
        manifest: path.display().to_string(),
        lang: Some(manifest.lang).filter(|l| !l.is_empty()),
        targets,
        warnings,
    })
}

/// Удалить поставленное и опустевшие папки. Чужие файлы остаются.
pub fn uninstall(game: &Path) -> Result<UninstallResult, CoreError> {
    let plan = plan_uninstall(game)?;
    let mut deleted = Vec::new();
    let mut kept = Vec::new();

    for target in &plan.targets {
        if !target.exists {
            kept.push(target.path.clone());
            continue;
        }
        if !target.matches {
            kept.push(target.path.clone());
            continue;
        }
        let Some(abs) = manifest::resolve_inside(game, &target.path) else {
            kept.push(target.path.clone());
            continue;
        };
        if !manifest::is_install_path(&target.path) {
            kept.push(target.path.clone());
            continue;
        }
        fs::remove_file(&abs).map_err(|e| CoreError::io(format!("{}: {e}", abs.display())))?;
        deleted.push(target.path.clone());
    }

    let manifest_file = crate::manifest_path(game);
    let manifest_deleted = if manifest_file.is_file() {
        fs::remove_file(&manifest_file)
            .map_err(|e| CoreError::io(format!("{}: {e}", manifest_file.display())))?;
        true
    } else {
        false
    };

    // Сначала подпапка шрифтов, потом папка мода, потом mods (только пустые).
    let mut removed_dirs = Vec::new();
    for dir in [
        mod_dir(game).join(FONT_SUBDIR),
        mod_dir(game),
        game.join(MODS_FOLDER),
    ] {
        let rel = rel_path(dir.strip_prefix(game).unwrap_or(&dir));
        if fsutil::remove_dir_if_empty(&dir) {
            removed_dirs.push(rel);
        }
    }

    Ok(UninstallResult {
        deleted,
        kept,
        removed_dirs,
        manifest_deleted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::{install, InstallResult};
    use crate::testutil::{fake_game, fake_payload, TempDir};
    use std::fs;

    fn installed(tmp: &TempDir) -> (PathBuf, PathBuf, InstallResult) {
        let game = fake_game(tmp);
        let payload = fake_payload(tmp, &["ru", "de"]);
        let result = install(&game, &payload, "ru").unwrap();
        (game, payload, result)
    }

    #[test]
    fn uninstall_removes_everything_it_installed() {
        let tmp = TempDir::new("uninstall");
        let (game, _payload, result) = installed(&tmp);
        let before: Vec<String> = result.files.iter().map(|f| f.path.clone()).collect();

        let plan = plan_uninstall(&game).unwrap();
        assert_eq!(plan.lang.as_deref(), Some("ru"));
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);

        let done = uninstall(&game).unwrap();
        assert_eq!(done.deleted.len(), before.len());
        for rel in &before {
            assert!(!game.join(rel).exists(), "{rel}");
        }
        assert!(!mod_dir(&game).exists());
        assert!(!game.join(MODS_FOLDER).exists());
        assert!(done.manifest_deleted);
        assert!(done.kept.is_empty(), "{:?}", done.kept);
        assert!(game.join("Third Crisis Neon Nights.exe").is_file());
    }

    #[test]
    fn uninstall_keeps_modified_files_and_non_empty_dirs() {
        let tmp = TempDir::new("uninstall-keep");
        let (game, _payload, _) = installed(&tmp);
        let edited = mod_dir(&game).join("patch_ru.dat");
        fs::write(&edited, "{\"hand\":true}").unwrap();
        let alien = mod_dir(&game).join("alien.txt");
        fs::write(&alien, "not ours").unwrap();

        let plan = plan_uninstall(&game).unwrap();
        assert!(
            plan.warnings.iter().any(|w| w.contains("изменён")),
            "{:?}",
            plan.warnings
        );
        let done = uninstall(&game).unwrap();
        assert!(edited.is_file());
        assert!(alien.is_file());
        assert!(done.kept.iter().any(|p| p.ends_with("patch_ru.dat")));
        assert!(
            mod_dir(&game).is_dir(),
            "папка с чужим файлом должна остаться"
        );
    }

    #[test]
    fn uninstall_removes_active_lang_changed_in_game() {
        let tmp = TempDir::new("uninstall-active-lang");
        let (game, _payload, _) = installed(&tmp);
        let lang_file = mod_dir(&game).join(crate::ACTIVE_LANG);
        fs::write(&lang_file, "de").unwrap();
        let done = uninstall(&game).unwrap();
        assert!(!lang_file.exists());
        assert!(done.kept.is_empty(), "{:?}", done.kept);
        assert!(!mod_dir(&game).exists());
    }

    #[test]
    fn uninstall_without_manifest_errors_and_touches_nothing() {
        let tmp = TempDir::new("uninstall-nomanifest");
        let game = fake_game(&tmp);
        let err = uninstall(&game).unwrap_err();
        assert_eq!(err.code, ErrorCode::ManifestMissing);
        assert!(game.join("Third Crisis Neon Nights.exe").is_file());
    }

    #[test]
    fn uninstall_skips_unsafe_manifest_paths() {
        let tmp = TempDir::new("uninstall-unsafe");
        let game = fake_game(&tmp);
        let mod_path = mod_dir(&game);
        fs::create_dir_all(&mod_path).unwrap();
        let outside = tmp.path().join("outside.dll");
        fs::write(&outside, "keep me").unwrap();
        let game_exe = game.join("Third Crisis Neon Nights.exe");
        let exe_hash = fsutil::sha256_file(&game_exe).unwrap();
        let log = mod_path.join("NeonTranslatorDX.log");
        fs::write(&log, "log").unwrap();
        let log_hash = fsutil::sha256_file(&log).unwrap();

        let raw = format!(
            r#"{{"version":1,"lang":"ru","installedAt":"x","files":[
                {{"path":"../outside.dll","size":7,"sha256":"{exe_hash}"}},
                {{"path":"Third Crisis Neon Nights.exe","size":7,"sha256":"{exe_hash}"}},
                {{"path":"mods/NeonTranslatorDX/NeonTranslatorDX.log","size":3,"sha256":"{log_hash}"}}
            ]}}"#
        );
        fs::write(crate::manifest_path(&game), raw).unwrap();

        let plan = plan_uninstall(&game).unwrap();
        assert_eq!(plan.warnings.len(), 2, "{:?}", plan.warnings);
        let done = uninstall(&game).unwrap();
        assert!(outside.is_file());
        assert!(game_exe.is_file());
        assert!(!log.exists());
        assert_eq!(
            done.deleted,
            vec!["mods/NeonTranslatorDX/NeonTranslatorDX.log"]
        );
        assert!(done.removed_dirs.contains(&"mods".to_string()));
        assert!(!crate::manifest_path(&game).exists());
    }

    #[test]
    fn uninstall_removes_runtime_artifacts_not_in_manifest() {
        let tmp = TempDir::new("uninstall-log");
        let (game, _payload, _) = installed(&tmp);
        let log = mod_dir(&game).join("NeonTranslatorDX.log");
        fs::write(&log, "log").unwrap();
        let done = uninstall(&game).unwrap();
        assert!(done
            .deleted
            .iter()
            .any(|p| p.ends_with("NeonTranslatorDX.log")));
        assert!(!log.exists());
        assert!(!mod_dir(&game).exists());
    }

    #[test]
    fn uninstall_accepts_powershell_style_manifest() {
        let tmp = TempDir::new("uninstall-ps");
        let game = fake_game(&tmp);
        let mod_path = mod_dir(&game);
        fs::create_dir_all(&mod_path).unwrap();
        let loader = game.join("dwmapi.dll");
        fs::write(&loader, "loader").unwrap();
        let hash = fsutil::sha256_file(&loader).unwrap();
        let json = format!(
            "{{\"version\":1,\"lang\":\"ru\",\"installedAt\":\"2026-11-25T10:00:00.0000000+03:00\",\
             \"files\":{{\"path\":\"dwmapi.dll\",\"size\":6,\"sha256\":\"{hash}\"}}}}"
        );
        fs::write(crate::manifest_path(&game), json).unwrap();

        let done = uninstall(&game).unwrap();
        assert!(!loader.exists());
        assert!(!mod_path.exists());
        assert_eq!(done.deleted, vec!["dwmapi.dll"]);
    }
}
