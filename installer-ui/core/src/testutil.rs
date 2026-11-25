//! Временные каталоги и фикстуры для тестов — без внешних крейтов.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use crate::{GAME_DATA_FOLDER, GAME_FOLDER};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Уникальная временная папка, удаляется на Drop.
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ntdx-test-{tag}-{}-{nanos}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temp dir");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Каталог, который выглядит как установка игры: exe + Managed/Assembly-CSharp.dll.
pub fn fake_game(tmp: &TempDir) -> PathBuf {
    let game = tmp.path().join("game");
    fs::create_dir_all(game.join(GAME_DATA_FOLDER).join("Managed")).expect("game data");
    fs::write(game.join(format!("{GAME_FOLDER}.exe")), b"fake exe").expect("exe");
    fs::write(
        game.join(GAME_DATA_FOLDER)
            .join("Managed")
            .join("Assembly-CSharp.dll"),
        b"fake assembly",
    )
    .expect("assembly");
    game
}

/// Payload: лоадер + папка мода с DLL, словарями и шрифтом.
pub fn fake_payload(tmp: &TempDir, langs: &[&str]) -> PathBuf {
    let payload = tmp.path().join("payload");
    let mod_path = payload.join("mods").join(crate::MOD_FOLDER);
    fs::create_dir_all(mod_path.join("fonts")).expect("payload dirs");
    fs::write(payload.join(crate::LOADER), b"loader-bytes").expect("loader");
    fs::write(mod_path.join(crate::RUNTIME_DLL), b"runtime-bytes").expect("runtime");
    fs::write(
        mod_path.join("fonts").join("RobotoCondensed-Regular.ttf"),
        b"font",
    )
    .expect("font");
    for lang in langs {
        fs::write(
            mod_path.join(format!("patch_{lang}.dat")),
            format!("{{\"lang\":\"{lang}\"}}"),
        )
        .expect("dat");
    }
    fs::write(
        payload.join(crate::PAYLOAD_INFO),
        format!(
            "{{\"version\":\"test\",\"langs\":{}}}",
            serde_json::to_string(langs).unwrap()
        ),
    )
    .expect("payload.json");
    payload
}
