/**
 * Локали интерфейса менеджера — ru/en.
 *
 * Ключ — смысл, не текст: переименование текста не ломает типы, а пропуск
 * перевода ловится `Record<MessageKey, string>` у `en`. Параметры — `{name}`.
 */

const ru = {
  appTitle: "NeonTranslatorDX Manager",
  appSubtitle: "Third Crisis: Neon Nights — перевод под управлением",
  winNote: "Windows 10/11 · официальная Steam-версия",
  langLabel: "Язык интерфейса",
  refresh: "Обновить данные",
  back: "К статусу",
  cancel: "Отмена",
  retry: "Повторить",
  mockBanner: "Демо-режим без Tauri: действия имитируются.",

  statusTitle: "Состояние мода",
  statusSearching: "Ищем игру и состояние мода…",
  statusLead:
    "Менеджер ставит, обновляет, проверяет и удаляет перевод. Все действия — из этого окна.",
  gameLabel: "Игра",
  gameFound: "Игра найдена",
  gameNotFound: "Игра не найдена",
  gameNotFoundBody:
    "Автопоиск не нашёл игру в Steam. Выберите папку игры вручную — ту, где лежит {exe}.",
  chooseFolder: "Выбрать папку",
  folderInvalid: "В выбранной папке нет игры: не хватает {missing}.",
  gameFolder: "Папка игры",
  steamBuild: "Сборка Steam",

  modLabel: "Мод",
  modInstalled: "Установлен",
  modNotInstalled: "Не установлен",
  manifestPending:
    "Файлы мода на месте, но манифеста нет. Запустите игру один раз — рантайм создаст манифест; либо нажмите «Установить».",
  modLang: "Активный язык: {lang}",
  modFiles: "Файлов: {count}",
  integrityLabel: "Целостность",
  integrityOk: "ok",
  integrityMissing: "не хватает файлов: {count}",
  integrityModified: "изменены: {count}",
  integrityBroken: "манифест повреждён",
  integrityUnknown: "нет данных",

  payloadLabel: "Пакет",
  payloadLine: "Пакет: {version} · языков: {count}",
  payloadMissing: "В пакете менеджера нет payload — пересоберите пакет (см. README).",
  updateAvailable: "Доступно обновление: {from} → {to}",
  actionInstall: "Установить",
  actionUpdate: "Обновить",
  actionVerify: "Проверить",
  actionUninstall: "Удалить",

  opInstallTitle: "Установка",
  opUpdateTitle: "Обновление",
  progressNote:
    "Не закрывайте окно: файлы пишутся атомарно. Если операция оборвалась — запустите её снова, менеджер доведёт установку до конца.",
  progressFile: "{done} из {total}: {path}",
  opFailed: "Операция не удалась",

  doneInstallTitle: "Установлено",
  doneUpdateTitle: "Обновлено",
  doneBody: "Готово. Язык переключается в меню мода в игре.",
  doneCopied: "Записано файлов: {count}",
  doneSkipped: "Пропущено (уже совпадали): {count}",
  doneRemoved: "Удалено из прошлой установки: {count}",
  doneSize: "Записано объёмом: {size}",
  doneVersion: "Версия: {version}",
  doneVerify: "Проверить установку",
  doneBack: "К статусу",

  uninstallTitle: "Удаление",
  uninstallBody:
    "Будет удалено только поставленное менеджером: файлы из манифеста (при совпадении контрольных сумм), лоадер и опустевшие папки. Сохранения и файлы игры не трогаются.",
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
  verifyRunning: "Сверяем файлы…",

  rowVersion: "Версия",
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
  errManifestMissing: "Мод не установлен: сначала нажмите «Установить».",
  errManifestInvalid: "Манифест установки повреждён.",
  errUnsafePath: "В манифесте недопустимый путь — действие остановлено.",
  errIo: "Ошибка файловой системы.",
  errUnknown: "Неизвестная ошибка: {detail}",
} as const;

export type MessageKey = keyof typeof ru;

const en: Record<MessageKey, string> = {
  appTitle: "NeonTranslatorDX Manager",
  appSubtitle: "Third Crisis: Neon Nights — translation under management",
  winNote: "Windows 10/11 · official Steam version",
  langLabel: "Interface language",
  refresh: "Refresh",
  back: "Back to status",
  cancel: "Cancel",
  retry: "Retry",
  mockBanner: "Demo mode without Tauri: actions are simulated.",

  statusTitle: "Mod status",
  statusSearching: "Looking for the game and mod status…",
  statusLead:
    "The manager installs, updates, verifies and removes the translation. Everything happens from this window.",
  gameLabel: "Game",
  gameFound: "Game found",
  gameNotFound: "Game not found",
  gameNotFoundBody:
    "The automatic search did not find the game in Steam. Pick the game folder manually — the one containing {exe}.",
  chooseFolder: "Choose folder",
  folderInvalid: "The selected folder is not the game: missing {missing}.",
  gameFolder: "Game folder",
  steamBuild: "Steam build",

  modLabel: "Mod",
  modInstalled: "Installed",
  modNotInstalled: "Not installed",
  manifestPending:
    "Mod files are in place, but there is no manifest. Start the game once — the runtime creates it; or press “Install”.",
  modLang: "Active language: {lang}",
  modFiles: "Files: {count}",
  integrityLabel: "Integrity",
  integrityOk: "ok",
  integrityMissing: "missing files: {count}",
  integrityModified: "modified: {count}",
  integrityBroken: "manifest is damaged",
  integrityUnknown: "no data",

  payloadLabel: "Package",
  payloadLine: "Package: {version} · languages: {count}",
  payloadMissing: "The manager package has no payload — rebuild the package (see README).",
  updateAvailable: "Update available: {from} → {to}",
  actionInstall: "Install",
  actionUpdate: "Update",
  actionVerify: "Verify",
  actionUninstall: "Uninstall",

  opInstallTitle: "Installing",
  opUpdateTitle: "Updating",
  progressNote:
    "Keep this window open: files are written atomically. If the operation was interrupted, run it again — the manager will finish the installation.",
  progressFile: "{done} of {total}: {path}",
  opFailed: "Operation failed",

  doneInstallTitle: "Installed",
  doneUpdateTitle: "Updated",
  doneBody: "Done. The language is switched in the in-game mod menu.",
  doneCopied: "Files written: {count}",
  doneSkipped: "Skipped (already matched): {count}",
  doneRemoved: "Removed from the previous install: {count}",
  doneSize: "Bytes written: {size}",
  doneVersion: "Version: {version}",
  doneVerify: "Check installation",
  doneBack: "Back to status",

  uninstallTitle: "Uninstall",
  uninstallBody:
    "Only what the manager placed is removed: files from the manifest (when checksums match), the loader and empty folders. Saves and game files are untouched.",
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
  verifyRunning: "Checking files…",

  rowVersion: "Version",
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
  errManifestMissing: "The mod is not installed: press “Install” first.",
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
