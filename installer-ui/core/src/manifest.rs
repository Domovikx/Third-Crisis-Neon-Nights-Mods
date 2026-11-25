//! Манифест установки — общий контракт exe и ручного `install.ps1`.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode};
use crate::{fsutil, manifest_path, LOADER, MANIFEST_NAME, MODS_FOLDER, MOD_FOLDER};

/// Один поставленный файл. `path` — от корня игры, всегда с `/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// Версия формата манифеста. Ручной `install.ps1` пишет тот же version=1.
pub const MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallManifest {
    pub version: u32,
    #[serde(default)]
    pub lang: String,
    #[serde(rename = "installedAt", default)]
    pub installed_at: String,
    /// PowerShell при одном элементе отдаёт объект вместо массива — принимаем оба.
    #[serde(default, deserialize_with = "one_or_many")]
    pub files: Vec<ManifestFile>,
}

/// Принять и массив, и одиночный объект (`ConvertTo-Json` схлопывает `@(x)`).
fn one_or_many<'de, D>(deserializer: D) -> Result<Vec<ManifestFile>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(ManifestFile),
        Many(Vec<ManifestFile>),
    }
    Ok(match OneOrMany::deserialize(deserializer)? {
        OneOrMany::One(file) => vec![file],
        OneOrMany::Many(files) => files,
    })
}

/// Прочитать манифест; `Ok(None)` — файла нет.
pub fn read(game: &Path) -> Result<Option<InstallManifest>, CoreError> {
    let path = manifest_path(game);
    if !path.is_file() {
        return Ok(None);
    }
    let text = fsutil::read_text(&path)?;
    let manifest: InstallManifest = serde_json::from_str(&text).map_err(|e| {
        CoreError::new(
            ErrorCode::ManifestInvalid,
            format!("{}: {e}", path.display()),
        )
    })?;
    if manifest.version != MANIFEST_VERSION {
        return Err(CoreError::new(
            ErrorCode::ManifestInvalid,
            format!("{}: версия {}", path.display(), manifest.version),
        ));
    }
    Ok(Some(manifest))
}

/// Записать манифест атомарно (отсортирован по пути — стабильный diff).
pub fn write(game: &Path, lang: &str, files: &mut [ManifestFile]) -> Result<(), CoreError> {
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let manifest = InstallManifest {
        version: MANIFEST_VERSION,
        lang: lang.to_string(),
        installed_at: now_iso8601(),
        files: files.to_vec(),
    };
    let text = serde_json::to_string_pretty(&manifest)
        .map_err(|e| CoreError::io(format!("manifest: {e}")))?;
    fsutil::write_atomic(&manifest_path(game), &(text + "\n"))
}

/// ISO-8601 UTC без внешних крейтов (формат совместим с `new Date().toISOString()`).
pub fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Гражданская дата из числа дней от 1970-01-01 (Howard Hinnant, public domain).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Путь внутри корня игры; `None` — выход за корень (`..`, абсолютный).
pub fn resolve_inside(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.replace('\\', "/");
    let candidate = Path::new(&rel);
    if candidate.is_absolute() {
        return None;
    }
    let mut depth = 0i32;
    for component in candidate.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return None;
                }
            }
            _ => return None,
        }
    }
    if depth == 0 {
        return None;
    }
    Some(root.join(candidate))
}

/// Разрешённые для удаления места: лоадер в корне и папка мода.
/// Всё остальное из манифеста (в т.ч. подделанного) не трогаем.
pub fn is_install_path(rel: &str) -> bool {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_start_matches("./");
    if rel.split('/').any(|part| part == "..") {
        return false;
    }
    rel == LOADER
        || rel == MANIFEST_NAME
        || rel == "install.ps1"
        || rel == "README-INSTALL.md"
        || rel.starts_with(&format!("{MODS_FOLDER}/{MOD_FOLDER}/"))
}

/// Проверить, что путь внутри папки мода.
pub fn is_own_mod_path(rel: &str) -> bool {
    let rel = rel.replace('\\', "/");
    if rel.split('/').any(|part| part == "..") {
        return false;
    }
    rel.starts_with(&format!("{MODS_FOLDER}/{MOD_FOLDER}/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mod_dir;
    use crate::testutil::{fake_game, TempDir};
    use std::fs;

    #[test]
    fn resolve_inside_rejects_traversal_and_absolute() {
        let root = Path::new("C:/game");
        assert!(resolve_inside(root, "mods/NeonTranslatorDX/a.dll").is_some());
        assert!(resolve_inside(root, "../evil.dll").is_none());
        assert!(resolve_inside(root, "mods/../../evil.dll").is_none());
        assert!(resolve_inside(root, "C:/Windows/system32/x.dll").is_none());
        assert!(resolve_inside(root, "mods/./NeonTranslatorDX/a.dll").is_some());
    }

    #[test]
    fn install_path_allows_only_loader_and_mod_folder() {
        assert!(is_install_path("dwmapi.dll"));
        assert!(is_install_path("mods\\NeonTranslatorDX\\fonts\\a.ttf"));
        assert!(is_install_path("install.ps1"));
        assert!(is_install_path("README-INSTALL.md"));
        assert!(!is_install_path("Third Crisis Neon Nights.exe"));
        assert!(!is_install_path("some-other.txt"));
        assert!(!is_install_path("mods/other-mod/x.dll"));
        assert!(!is_install_path("mods/NeonTranslatorDX/../../x.dll"));
    }

    #[test]
    fn manifest_roundtrip_and_sorted() {
        let tmp = TempDir::new("manifest");
        let game = fake_game(&tmp);
        let mut files = vec![
            ManifestFile {
                path: "dwmapi.dll".into(),
                size: 1,
                sha256: "aa".into(),
            },
            ManifestFile {
                path: "mods/NeonTranslatorDX/NeonTranslatorDX.dll".into(),
                size: 2,
                sha256: "bb".into(),
            },
        ];
        write(&game, "ru", &mut files).unwrap();
        let read_back = read(&game).unwrap().expect("manifest");
        assert_eq!(read_back.version, 1);
        assert_eq!(read_back.lang, "ru");
        assert_eq!(read_back.files[0].path, "dwmapi.dll");
        assert!(read_back.files[1].path.ends_with("NeonTranslatorDX.dll"));
        assert!(read_back.installed_at.ends_with('Z'));
    }

    #[test]
    fn manifest_accepts_powershell_single_object_and_bom() {
        let tmp = TempDir::new("ps-manifest");
        let game = fake_game(&tmp);
        fs::create_dir_all(mod_dir(&game)).unwrap();
        // Ровно то, что может выдать PowerShell 5.1: BOM + объект вместо массива.
        let json = r#"{"version":1,"lang":"ru","installedAt":"2026-11-25T10:00:00.0000000+03:00","files":{"path":"dwmapi.dll","size":7,"sha256":"cc"}}"#;
        fs::write(
            manifest_path(&game),
            [&[0xEFu8, 0xBB, 0xBF][..], json.as_bytes()].concat(),
        )
        .unwrap();
        let manifest = read(&game).unwrap().unwrap();
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].size, 7);
    }

    #[test]
    fn manifest_unknown_version_is_error() {
        let tmp = TempDir::new("manifest-v2");
        let game = fake_game(&tmp);
        fs::create_dir_all(mod_dir(&game)).unwrap();
        fs::write(manifest_path(&game), r#"{"version":2,"files":[]}"#).unwrap();
        let err = read(&game).unwrap_err();
        assert_eq!(err.code, ErrorCode::ManifestInvalid);
    }

    #[test]
    fn iso8601_shape() {
        let value = now_iso8601();
        assert_eq!(value.len(), 24, "{value}");
        assert!(value.ends_with(".000Z"));
    }
}
