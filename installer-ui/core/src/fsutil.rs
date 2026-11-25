//! Файловые примитивы: sha256, атомарная запись/копирование, обход дерева.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::CoreError;

/// sha256 файла (нижний hex).
pub fn sha256_file(path: &Path) -> Result<String, CoreError> {
    let mut file =
        File::open(path).map_err(|e| CoreError::io(format!("{}: {e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| CoreError::io(format!("{}: {e}", path.display())))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Атомарная запись текста: `<путь>.part` → rename.
pub fn write_atomic(path: &Path, content: &str) -> Result<(), CoreError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| CoreError::io(format!("{}: {e}", dir.display())))?;
    }
    let part = with_suffix(path, ".part");
    if let Err(e) = fs::write(&part, content) {
        let _ = fs::remove_file(&part);
        return Err(CoreError::io(format!("{}: {e}", part.display())));
    }
    if let Err(e) = fs::rename(&part, path) {
        let _ = fs::remove_file(&part);
        return Err(CoreError::io(format!("{}: {e}", path.display())));
    }
    Ok(())
}

/// Атомарное копирование: `.part` → rename.
pub fn copy_atomic(from: &Path, to: &Path) -> Result<(), CoreError> {
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir).map_err(|e| CoreError::io(format!("{}: {e}", dir.display())))?;
    }
    let part = with_suffix(to, ".part");
    if let Err(e) = fs::copy(from, &part) {
        let _ = fs::remove_file(&part);
        return Err(CoreError::io(format!(
            "{} -> {}: {e}",
            from.display(),
            to.display()
        )));
    }
    if let Err(e) = fs::rename(&part, to) {
        let _ = fs::remove_file(&part);
        return Err(CoreError::io(format!("{}: {e}", to.display())));
    }
    Ok(())
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Все файлы дерева: пути относительно `base`, с `/`, отсортированы.
pub fn list_files(base: &Path) -> Result<Vec<String>, CoreError> {
    let mut out = Vec::new();
    walk(base, base, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), CoreError> {
    let entries =
        fs::read_dir(dir).map_err(|e| CoreError::io(format!("{}: {e}", dir.display())))?;
    for entry in entries {
        let entry = entry.map_err(|e| CoreError::io(format!("{}: {e}", dir.display())))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| CoreError::io(format!("{}: {e}", path.display())))?;
        if file_type.is_dir() {
            walk(base, &path, out)?;
        } else if file_type.is_file() {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| CoreError::io(e.to_string()))?;
            out.push(crate::rel_path(rel));
        }
    }
    Ok(())
}

/// Удалить каталог, только если он пуст (чужие файлы сохраняют папку).
pub fn remove_dir_if_empty(dir: &Path) -> bool {
    match fs::read_dir(dir) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return false;
            }
            fs::remove_dir(dir).is_ok()
        }
        Err(_) => false,
    }
}

/// Прочитать текст, сняв UTF-8 BOM (PowerShell 5.1 пишет его в `Set-Content`).
pub fn read_text(path: &Path) -> Result<String, CoreError> {
    let bytes = fs::read(path).map_err(|e| CoreError::io(format!("{}: {e}", path.display())))?;
    let bytes = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF][..])
        .unwrap_or(&bytes);
    String::from_utf8(bytes.to_vec()).map_err(|e| CoreError::io(format!("{}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn sha256_matches_reference_vector() {
        let tmp = TempDir::new("sha");
        let file = tmp.path().join("abc.txt");
        fs::write(&file, "abc").unwrap();
        assert_eq!(
            sha256_file(&file).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_part() {
        let tmp = TempDir::new("write");
        let file = tmp.path().join("nested/active_lang.txt");
        write_atomic(&file, "ru").unwrap();
        write_atomic(&file, "de").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "de");
        assert!(!tmp.path().join("nested/active_lang.txt.part").exists());
    }

    #[test]
    fn list_files_is_recursive_sorted_with_slashes() {
        let tmp = TempDir::new("list");
        fs::create_dir_all(tmp.path().join("mods/NeonTranslatorDX/fonts")).unwrap();
        fs::write(tmp.path().join("dwmapi.dll"), b"x").unwrap();
        fs::write(tmp.path().join("mods/NeonTranslatorDX/fonts/a.ttf"), b"y").unwrap();
        fs::write(tmp.path().join("mods/NeonTranslatorDX/b.dll"), b"z").unwrap();
        assert_eq!(
            list_files(tmp.path()).unwrap(),
            vec![
                "dwmapi.dll",
                "mods/NeonTranslatorDX/b.dll",
                "mods/NeonTranslatorDX/fonts/a.ttf"
            ]
        );
    }

    #[test]
    fn remove_dir_if_empty_keeps_non_empty() {
        let tmp = TempDir::new("rmdir");
        let dir = tmp.path().join("mods");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("alien.txt"), b"x").unwrap();
        assert!(!remove_dir_if_empty(&dir));
        assert!(dir.exists());
        fs::remove_file(dir.join("alien.txt")).unwrap();
        assert!(remove_dir_if_empty(&dir));
        assert!(!dir.exists());
    }

    #[test]
    fn read_text_strips_bom() {
        let tmp = TempDir::new("bom");
        let file = tmp.path().join("install-manifest.json");
        fs::write(
            &file,
            [&[0xEFu8, 0xBB, 0xBF][..], br#"{"version":1}"#].concat(),
        )
        .unwrap();
        assert_eq!(read_text(&file).unwrap(), r#"{"version":1}"#);
    }
}
