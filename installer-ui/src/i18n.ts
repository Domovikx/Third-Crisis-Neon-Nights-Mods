/**
 * Локали интерфейса установщика — ru/en на старте.
 *
 * Ключ — смысл, не текст: переименование текста не ломает типы, а пропуск
 * перевода ловится `Record<MessageKey, string>` у `en`. Параметры — `{name}`.
 */

const ru = {
  appTitle: "NeonTranslatorDX",
  appSubtitle: "Перевод Third Crisis: Neon Nights",
  winNote: "Windows 10/11 · официальная Steam-версия",
  langLabel: "Язык интерфейса",
  next: "Продолжить",
  back: "Назад",
  cancel: "Отмена",
  close: "Закрыть",
  retry: "Повторить",
  mockBanner: "Демо-режим без Tauri: действия имитируются.",

  welcomeTitle: "Установка перевода",
  welcomeLead:
    "Установщик найдёт игру в библиотеках Steam, поставит перевод и запишет манифест установки. Удаление — по тому же манифесту, без следов.",
  welcomeIncluded: "Что будет установлено",
  welcomeLoader: "загрузчик в корне игры",
  welcomeModFolder: "переводчик, словари всех языков и шрифты",
  welcomeSafe:
    "Файлы игры не изменяются: добавляются только эти два места. Steam «Проверить целостность» ничего не перекачивает.",
  start: "Начать",

  detectTitle: "Поиск игры",
  detectSearching: "Ищем Third Crisis: Neon Nights в библиотеках Steam…",
  gameFound: "Игра найдена",
  gameNotFound: "Игра не найдена",
  notFoundBody:
    "Автопоиск не нашёл игру в Steam. Выберите папку игры вручную — ту, где лежит {exe}.",
  chooseFolder: "Выбрать папку",
  folderInvalid: "В выбранной папке нет игры: не хватает {missing}.",
  gameFolder: "Папка игры",
  steamBuild: "Сборка Steam",
  modInstalled: "Мод установлен",
  modNotInstalled: "Мод не установлен",
  install: "Установить",
  uninstall: "Удалить",
  verify: "Проверить установку",
  update: "Переустановить",
  payloadLine: "Пакет: {version} · языков: {count}",
  payloadMissing:
    "Рядом с установщиком нет папки payload — пересоберите пакет (см. README установщика).",

  installingTitle: "Установка",
  installingNote: "Не закрывайте окно: файлы пишутся атомарно, папка игры не блокируется.",
  installingFile: "{done} из {total}: {path}",
  installFailed: "Установка не удалась",

  doneTitle: "Готово",
  doneBody:
    "Перевод установлен. Запустите игру: язык переключается в меню мода. Если меняли язык — это же меню сохранит выбор.",
  doneFiles: "Файлов: {count}",
  doneSize: "Объём: {size}",
  doneLang: "Стартовый язык: {lang}",
  doneStale: "Убрано из прошлой установки: {count}",
  doneVerify: "Проверить установку",
  doneClose: "К экрану игры",

  uninstallTitle: "Удаление",
  uninstallBody:
    "Будет удалено только поставленное установщиком: файлы из манифеста (при совпадении контрольных сумм), лоадер и опустевшие папки. Сохранения и файлы игры не трогаются.",
  uninstallConfirm: "Удалить мод",
  uninstallDone: "Мод удалён",
  uninstallDeleted: "Удалено файлов: {count}",
  uninstallKept: "Оставлено (изменены или чужие): {count}",
  uninstallDirs: "Удалено пустых папок: {count}",

  verifyTitle: "Проверка установки",
  verifyOk: "Установка цела: все {count} файлов на месте.",
  verifyNotInstalled: "Мод не установлен.",
  verifyMissing: "Не хватает файлов: {count}",
  verifyModified: "Изменены после установки: {count}",
  verifyUnlisted: "Лишние файлы в папке мода: {count}",
  verifyChecked: "Проверено файлов: {count}",
  verifyLang: "Язык в манифесте: {lang}",

  rowFiles: "Файлов",
  rowSize: "Объём",
  rowLang: "Язык",
  rowStale: "Убрано из прошлой установки",
  rowKept: "Оставлено (изменены или чужие)",
  rowDirs: "Пустых папок удалено",
  rowChecked: "Проверено файлов",
  rowModified: "Изменено после установки",
  rowUnlisted: "Лишних файлов",
  errPayloadMissing: "Пакет установки не найден или неполный.",
  errLangUnavailable: "В пакете нет словаря для выбранного языка.",
  errGameInvalid: "Папка не похожа на установку игры.",
  errManifestMissing: "Манифест установки не найден: удалять нечего.",
  errManifestInvalid: "Манифест установки повреждён.",
  errUnsafePath: "В манифесте недопустимый путь — действие остановлено.",
  errIo: "Ошибка файловой системы.",
  errUnknown: "Неизвестная ошибка: {detail}",
} as const;

export type MessageKey = keyof typeof ru;

const en: Record<MessageKey, string> = {
  appTitle: "NeonTranslatorDX",
  appSubtitle: "Third Crisis: Neon Nights translation",
  winNote: "Windows 10/11 · official Steam version",
  langLabel: "Interface language",
  next: "Continue",
  back: "Back",
  cancel: "Cancel",
  close: "Close",
  retry: "Retry",
  mockBanner: "Demo mode without Tauri: actions are simulated.",

  welcomeTitle: "Install the translation",
  welcomeLead:
    "The installer finds the game in your Steam libraries, installs the translation and writes an install manifest. Uninstall uses the same manifest and leaves no traces.",
  welcomeIncluded: "What gets installed",
  welcomeLoader: "loader in the game root",
  welcomeModFolder: "runtime, dictionaries for every language and fonts",
  welcomeSafe:
    "Game files are not modified: only these two places are added. Steam “Verify integrity” will not redownload anything.",
  start: "Start",

  detectTitle: "Finding the game",
  detectSearching: "Looking for Third Crisis: Neon Nights in Steam libraries…",
  gameFound: "Game found",
  gameNotFound: "Game not found",
  notFoundBody:
    "The automatic search did not find the game in Steam. Pick the game folder manually — the one containing {exe}.",
  chooseFolder: "Choose folder",
  folderInvalid: "The selected folder is not the game: missing {missing}.",
  gameFolder: "Game folder",
  steamBuild: "Steam build",
  modInstalled: "Mod installed",
  modNotInstalled: "Mod not installed",
  install: "Install",
  uninstall: "Uninstall",
  verify: "Check installation",
  update: "Reinstall",
  payloadLine: "Package: {version} · languages: {count}",
  payloadMissing:
    "No payload folder next to the installer — rebuild the package (see the installer README).",

  installingTitle: "Installing",
  installingNote:
    "Keep this window open: files are written atomically, the game folder is not locked.",
  installingFile: "{done} of {total}: {path}",
  installFailed: "Installation failed",

  doneTitle: "Done",
  doneBody:
    "The translation is installed. Start the game: the language is switched in the mod menu. The same menu remembers your choice.",
  doneFiles: "Files: {count}",
  doneSize: "Size: {size}",
  doneLang: "Initial language: {lang}",
  doneStale: "Removed from the previous install: {count}",
  doneVerify: "Check installation",
  doneClose: "Back to game screen",

  uninstallTitle: "Uninstall",
  uninstallBody:
    "Only what the installer placed is removed: files from the manifest (when checksums match), the loader and empty folders. Saves and game files are untouched.",
  uninstallConfirm: "Uninstall mod",
  uninstallDone: "Mod removed",
  uninstallDeleted: "Files removed: {count}",
  uninstallKept: "Kept (modified or foreign): {count}",
  uninstallDirs: "Empty folders removed: {count}",

  verifyTitle: "Installation check",
  verifyOk: "Installation is intact: all {count} files are in place.",
  verifyNotInstalled: "The mod is not installed.",
  verifyMissing: "Missing files: {count}",
  verifyModified: "Modified after install: {count}",
  verifyUnlisted: "Extra files in the mod folder: {count}",
  verifyChecked: "Files checked: {count}",
  verifyLang: "Manifest language: {lang}",

  rowFiles: "Files",
  rowSize: "Size",
  rowLang: "Language",
  rowStale: "Removed from previous install",
  rowKept: "Kept (modified or foreign)",
  rowDirs: "Empty folders removed",
  rowChecked: "Files checked",
  rowModified: "Modified after install",
  rowUnlisted: "Extra files",
  errPayloadMissing: "The install package is missing or incomplete.",
  errLangUnavailable: "The package has no dictionary for the selected language.",
  errGameInvalid: "The folder does not look like a game installation.",
  errManifestMissing: "Install manifest not found: nothing to remove.",
  errManifestInvalid: "The install manifest is damaged.",
  errUnsafePath: "The manifest contains an unsafe path — the action was stopped.",
  errIo: "File system error.",
  errUnknown: "Unknown error: {detail}",
};

export const MESSAGES = { ru, en } as const;

export type Locale = keyof typeof MESSAGES;

export const LOCALES: Locale[] = ["ru", "en"];

/** Названия языков для переключателя (на своём языке). */
export const LOCALE_LABELS: Record<Locale, string> = {
  ru: "Русский",
  en: "English",
};

export type Vars = Record<string, string | number>;

/** Перевод строки с подстановкой `{name}`. */
export function t(locale: Locale, key: MessageKey, vars: Vars = {}): string {
  const template: string = MESSAGES[locale][key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Коды ошибок Rust (`CoreError::wire`) → ключи словаря. */
const ERROR_KEYS: Record<string, MessageKey> = {
  "payload-missing": "errPayloadMissing",
  "lang-unavailable": "errLangUnavailable",
  "game-invalid": "errGameInvalid",
  "manifest-missing": "errManifestMissing",
  "manifest-invalid": "errManifestInvalid",
  "unsafe-path": "errUnsafePath",
  io: "errIo",
};

/** Разобрать `код: подробность`; код без двоеточия считается целым кодом. */
export function parseError(raw: string): { code: string; detail: string } {
  const index = raw.indexOf(": ");
  if (index === -1) return { code: raw, detail: "" };
  return { code: raw.slice(0, index), detail: raw.slice(index + 2) };
}

/** Локализованный текст ошибки по коду. */
export function errorText(locale: Locale, raw: string): string {
  const { code, detail } = parseError(raw);
  const key = ERROR_KEYS[code];
  if (key) return t(locale, key);
  return t(locale, "errUnknown", { detail: detail || code });
}
