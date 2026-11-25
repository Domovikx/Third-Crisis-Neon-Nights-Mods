/**
 * Экраны установщика — чистый reducer: никаких вызовов Tauri, всё проверяется
 * юнит-тестом. Побочные эффекты живут в `hooks/useInstaller.ts`.
 */

import type { Locale } from "@/i18n";

import type {
  GameInfo,
  InstallProgress,
  InstallResult,
  PayloadStatus,
  UninstallResult,
  VerifyResult,
} from "./types";

export type Screen = "welcome" | "detect" | "installing" | "done" | "uninstall" | "verify";

export interface InstallerState {
  screen: Screen;
  locale: Locale;
  game: GameInfo | null;
  detecting: boolean;
  /** Ошибка проверки выбранной вручную папки (код). */
  folderError: string | null;
  /** Чего не хватает в выбранной папке (маркеры). */
  folderMissing: string[];
  payload: PayloadStatus | null;
  lang: string;
  busy: boolean;
  /** Ошибка текущей операции (код из Rust). */
  error: string | null;
  progress: InstallProgress | null;
  install: InstallResult | null;
  uninstall: UninstallResult | null;
  verify: VerifyResult | null;
}

export type InstallerAction =
  | { type: "navigate"; screen: Screen }
  | { type: "setLocale"; locale: Locale }
  | { type: "payload"; payload: PayloadStatus }
  | { type: "detectStart" }
  | { type: "detectDone"; game: GameInfo | null }
  | { type: "probeDone"; game: GameInfo }
  | { type: "probeFailed"; code: string; missing: string[] }
  | { type: "installStart" }
  | { type: "progress"; progress: InstallProgress }
  | { type: "installDone"; result: InstallResult }
  | { type: "uninstallStart" }
  | { type: "uninstallDone"; result: UninstallResult }
  | { type: "verifyStart" }
  | { type: "verifyDone"; result: VerifyResult }
  | { type: "fail"; code: string }
  | { type: "clearError" };

export function initialState(locale: Locale = "ru"): InstallerState {
  return {
    screen: "welcome",
    locale,
    game: null,
    detecting: false,
    folderError: null,
    folderMissing: [],
    payload: null,
    lang: "ru",
    busy: false,
    error: null,
    progress: null,
    install: null,
    uninstall: null,
    verify: null,
  };
}

/** Язык по умолчанию: ru/en из системы, иначе ru. */
export function localeFromSystem(system: string): Locale {
  return system.toLowerCase().startsWith("en") ? "en" : "ru";
}

export function reduce(state: InstallerState, action: InstallerAction): InstallerState {
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
      return { ...state, payload: action.payload, lang: pickLang(state.lang, action.payload) };
    case "detectStart":
      return { ...state, detecting: true, folderError: null, error: null };
    case "detectDone":
      return {
        ...state,
        detecting: false,
        game: action.game,
        lang: action.game?.installedLang ?? state.lang,
      };
    case "probeDone":
      return {
        ...state,
        detecting: false,
        game: action.game,
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
    case "installStart":
      return { ...state, screen: "installing", busy: true, error: null, progress: null };
    case "progress":
      return { ...state, progress: action.progress };
    case "installDone":
      return {
        ...state,
        screen: "done",
        busy: false,
        progress: null,
        install: action.result,
        lang: action.result.lang,
        game: state.game
          ? {
              ...state.game,
              modInstalled: true,
              installedLang: action.result.lang,
            }
          : state.game,
      };
    case "uninstallStart":
      return { ...state, screen: "uninstall", busy: true, error: null };
    case "uninstallDone":
      return {
        ...state,
        screen: "uninstall",
        busy: false,
        uninstall: action.result,
        game: state.game ? { ...state.game, modInstalled: false, installedLang: null } : null,
      };
    case "verifyStart":
      return { ...state, screen: "verify", busy: true, error: null, verify: null };
    case "verifyDone":
      return { ...state, screen: "verify", busy: false, verify: action.result };
    case "fail":
      return { ...state, busy: false, detecting: false, error: action.code };
    case "clearError":
      return { ...state, error: null, folderError: null };
    default:
      return state;
  }
}

/** Язык из пакета: текущий, иначе ru, иначе первый доступный. */
export function pickLang(current: string, payload: PayloadStatus): string {
  if (payload.langs.includes(current)) return current;
  if (payload.langs.includes("ru")) return "ru";
  return payload.langs[0] ?? current;
}

/** Можно ли начинать установку. */
export function canInstall(state: InstallerState): boolean {
  return Boolean(state.game?.path) && Boolean(state.payload?.exists) && !state.busy;
}

/** Процент выполнения (0..100); без данных — 0. */
export function installPercent(progress: InstallProgress | null): number {
  if (!progress || progress.total <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, progress.done / progress.total));
  return Math.round(ratio * 100);
}

/** Маркеры, которых не хватает в выбранной папке (человекочитаемо). */
export function missingList(missing: string[]): string {
  return missing.join(", ");
}
