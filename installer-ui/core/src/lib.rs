//! Логика установщика NeonTranslatorDX: без Tauri, без окна.
//!
//! Здесь живёт всё, что можно проверить юнит-тестом во временной папке:
//! поиск игры по Steam, установка payload'а, манифест с sha256, удаление
//! ровно поставленного и сверка целостности. Слой `src-tauri` только
//! оборачивает эти функции в `#[tauri::command]` и шлёт прогресс в UI.
//!
//! Раскладка (протокол `tasks/2026-11-24-installer-protocol.md`):
//!
//! ```text
//! <игра>/dwmapi.dll                          лоадер, единственный файл вне папки
//! <игра>/mods/NeonTranslatorDX/
//!   NeonTranslatorDX.dll
//!   fonts/*.ttf
//!   patch_<lang>.dat                         все языки сразу
//!   active_lang.txt                          текущий язык
//!   install-manifest.json                    путь, размер, sha256 — для удаления
//! ```
#![forbid(unsafe_code)]

pub mod detect;
pub mod error;
pub mod fsutil;
pub mod install;
pub mod manifest;
pub mod uninstall;
pub mod verify;

#[cfg(test)]
pub(crate) mod testutil;

use std::path::{Path, PathBuf};

/// Папка игры внутри `steamapps/common`.
pub const GAME_FOLDER: &str = "Third Crisis Neon Nights";

/// Папка данных Unity: `<GameFolder>_Data`.
pub const GAME_DATA_FOLDER: &str = "Third Crisis Neon Nights_Data";

/// Steam App ID игры (store.steampowered.com/app/3400350). Не единственный
/// признак: игру находим по маркерам, `appmanifest` нужен для версии (buildid).
pub const STEAM_APP_ID: &str = "3400350";

/// Запасные App ID: в протоколе установщика фигурировал `2166470` (это App ID
/// TSSR). Если у игры когда-нибудь окажется несколько манифестов, buildid
/// возьмётся из первого найденного.
pub const STEAM_APP_IDS: [&str; 2] = [STEAM_APP_ID, "2166470"];

/// Папка модов в установке (единая конвенция с TSSR).
pub const MODS_FOLDER: &str = "mods";

/// Папка мода внутри `mods/`: сюда идёт всё, кроме лоадера.
pub const MOD_FOLDER: &str = "NeonTranslatorDX";

/// Лоадер в корне игры (DLL-hijack, иначе рантайм не загрузится).
pub const LOADER: &str = "dwmapi.dll";

/// Имя рантайм-сборки внутри папки мода.
pub const RUNTIME_DLL: &str = "NeonTranslatorDX.dll";

/// Манифест установки: что поставлено (файл, размер, sha256).
pub const MANIFEST_NAME: &str = "install-manifest.json";

/// Файл с выбранным языком (пишется установщиком, читается рантаймом).
pub const ACTIVE_LANG: &str = "active_lang.txt";

/// Описание payload'а, которое кладёт `scripts/build_payload.mts`.
pub const PAYLOAD_INFO: &str = "payload.json";

/// Подпапка шрифтов внутри папки мода.
pub const FONT_SUBDIR: &str = "fonts";

/// Файлы, которые рантайм создаёт сам в папке мода (в манифест не попадают).
pub const RUNTIME_ARTIFACTS: [&str; 3] = [
    "NeonTranslatorDX.log",
    "dump_GUIDictionary.json",
    "nolog.txt",
];

/// Язык оригинала: словарь не нужен (`patch_en.dat` не существует).
pub const SOURCE_LANG: &str = "en";

/// `<игра>/mods/NeonTranslatorDX`.
pub fn mod_dir(game: &Path) -> PathBuf {
    game.join(MODS_FOLDER).join(MOD_FOLDER)
}

/// `<игра>/mods/NeonTranslatorDX/install-manifest.json`.
pub fn manifest_path(game: &Path) -> PathBuf {
    mod_dir(game).join(MANIFEST_NAME)
}

/// Файлы, без которых каталог не считается установкой игры.
pub fn required_markers() -> [String; 2] {
    [
        format!("{GAME_FOLDER}.exe"),
        format!("{GAME_DATA_FOLDER}/Managed/Assembly-CSharp.dll"),
    ]
}

/// Путь относительного файла в формате манифеста: только прямые слэши.
pub fn rel_path(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}
