/**
 * Экраны менеджера — чистый reducer: никаких вызовов Tauri, всё проверяется
 * юнит-тестом. Побочные эффекты живут в `hooks/useManager.ts`.
 *
 * Поток один: статус — хаб. Из него — установка/обновление, проверка, удаление;
 * после операции снова статус.
 */

import type { Locale } from "@/i18n";

import type {
  GameInfo,
  InstallProgress,
  InstallResult,
  ModOperation,
  PayloadStatus,
  StatusResult,
  UninstallResult,
  VerifyResult,
} from "./types";

export type Screen = "status" | "progress" | "done" | "verify" | "uninstall";

export interface ManagerState {
  screen: Screen;
  locale: Locale;
  game: GameInfo | null;
  /** Статус мода (null — игра не найдена или ещё не спросили). */
  status: StatusResult | null;
  payload: PayloadStatus | null;
  detecting: boolean;
  /** Ошибка проверки выбранной вручную папки (код). */
  folderError: string | null;
  /** Чего не хватает в выбранной папке (маркеры). */
  folderMissing: string[];
  busy: boolean;
  /** Ошибка текущей операции (код из Rust). */
  error: string | null;
  /** Какая операция идёт/шла последней. */
  op: ModOperation | null;
  progress: InstallProgress | null;
  result: InstallResult | null;
  uninstall: UninstallResult | null;
  verify: VerifyResult | null;
}

export type ManagerAction =
  | { type: "navigate"; screen: Screen }
  | { type: "setLocale"; locale: Locale }
  | { type: "payload"; payload: PayloadStatus }
  | { type: "refreshStart" }
  | { type: "refreshDone"; game: GameInfo | null; status: StatusResult | null }
  | { type: "probeDone"; game: GameInfo; status: StatusResult }
  | { type: "probeFailed"; code: string; missing: string[] }
  | { type: "opStart"; op: ModOperation }
  | { type: "progress"; progress: InstallProgress }
  | { type: "opDone"; op: ModOperation; result: InstallResult }
  | { type: "uninstallStart" }
  | { type: "uninstallDone"; result: UninstallResult }
  | { type: "verifyStart" }
  | { type: "verifyDone"; result: VerifyResult }
  | { type: "fail"; code: string }
  | { type: "clearError" };

export function initialState(locale: Locale = "ru"): ManagerState {
  return {
    screen: "status",
    locale,
    game: null,
    status: null,
    payload: null,
    detecting: false,
    folderError: null,
    folderMissing: [],
    busy: false,
    error: null,
    op: null,
    progress: null,
    result: null,
    uninstall: null,
    verify: null,
  };
}

/** Язык по умолчанию: ru/en из системы, иначе ru. */
export function localeFromSystem(system: string): Locale {
  return system.toLowerCase().startsWith("en") ? "en" : "ru";
}

/** Статус после операции: не ждём повторного опроса, чтобы не мигать. */
function statusAfterInstall(status: StatusResult | null, result: InstallResult): StatusResult {
  return {
    installed: true,
    modDirExists: true,
    manifestFound: true,
    version: result.payloadVersion,
    lang: result.lang,
    files: result.files.length,
    installedAt: status?.installedAt ?? null,
    integrity: {
      state: "ok",
      checked: result.files.length,
      missing: 0,
      modified: 0,
      unlisted: status?.integrity.unlisted ?? 0,
    },
    problem: null,
  };
}

export function reduce(state: ManagerState, action: ManagerAction): ManagerState {
  switch (action.type) {
    case "navigate":
      return {
        ...state,
        screen: action.screen,
        error: null,
        folderError: null,
        folderMissing: [],
      };
    case "setLocale":
      return { ...state, locale: action.locale };
    case "payload":
      return { ...state, payload: action.payload };
    case "refreshStart":
      return { ...state, detecting: true, folderError: null, folderMissing: [] };
    case "refreshDone":
      return {
        ...state,
        detecting: false,
        game: action.game,
        status: action.status,
      };
    case "probeDone":
      return {
        ...state,
        detecting: false,
        game: action.game,
        status: action.status,
        folderError: null,
        folderMissing: [],
      };
    case "probeFailed":
      return {
        ...state,
        detecting: false,
        folderError: action.code,
        folderMissing: action.missing,
      };
    case "opStart":
      return {
        ...state,
        screen: "progress",
        busy: true,
        error: null,
        op: action.op,
        progress: null,
        result: null,
      };
    case "progress":
      return { ...state, progress: action.progress };
    case "opDone":
      return {
        ...state,
        screen: "done",
        busy: false,
        progress: null,
        op: action.op,
        result: action.result,
        status: statusAfterInstall(state.status, action.result),
      };
    case "uninstallStart":
      return { ...state, screen: "uninstall", busy: true, error: null };
    case "uninstallDone":
      return {
        ...state,
        screen: "uninstall",
        busy: false,
        uninstall: action.result,
        status: state.status
          ? {
              ...state.status,
              installed: false,
              manifestFound: false,
              modDirExists: false,
              version: null,
              lang: null,
              files: 0,
              integrity: {
                state: "unknown",
                checked: 0,
                missing: 0,
                modified: 0,
                unlisted: 0,
              },
              problem: null,
            }
          : null,
        game: state.game ? { ...state.game, modInstalled: false, installedLang: null } : null,
      };
    case "verifyStart":
      return { ...state, screen: "verify", busy: true, error: null, verify: null };
    case "verifyDone":
      return { ...state, screen: "verify", busy: false, verify: action.result };
    case "fail":
      return { ...state, busy: false, detecting: false, error: action.code };
    case "clearError":
      return { ...state, error: null, folderError: null, folderMissing: [] };
    default:
      return state;
  }
}

/** Можно ли начинать установку/обновление. */
export function canApply(state: ManagerState): boolean {
  return Boolean(state.game?.path) && Boolean(state.payload?.exists) && !state.busy;
}

/** Установлен ли мод (по статусу). */
export function isInstalled(state: ManagerState): boolean {
  return Boolean(state.status?.installed);
}

/** Есть ли что обновлять: версия пакета отличается от установленной. */
export function updateAvailable(state: Pick<ManagerState, "status" | "payload">): boolean {
  const installed = state.status;
  const payload = state.payload;
  if (!installed?.installed || !payload?.exists) return false;
  return !installed.version || installed.version !== payload.version;
}

/** Процент выполнения (0..100); без данных — 0. */
export function installPercent(progress: InstallProgress | null): number {
  if (!progress || progress.total <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, progress.done / progress.total));
  return Math.round(ratio * 100);
}
