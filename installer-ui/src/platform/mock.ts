/**
 * Мок-транспорт: смотреть интерфейс в браузере (`npm run dev`) и тестировать
 * экраны без сборки exe. Это НЕ вторая реализация менеджера — только ответы
 * с правдоподобными данными.
 */
import type {
  GameInfo,
  InstallerPlatform,
  InstallProgress,
  PayloadStatus,
  StatusResult,
} from "@/core/types";

export const MOCK_GAME_PATH = "C:\\Games\\Third Crisis Neon Nights";
export const MOCK_VERSION = "2026.11.25";

const SAMPLE_FILES = [
  "dwmapi.dll",
  "mods/NeonTranslatorDX/NeonTranslatorDX.dll",
  "mods/NeonTranslatorDX/fonts/RobotoCondensed-Regular.ttf",
  "mods/NeonTranslatorDX/fonts/NotoSansSC.ttf",
  "mods/NeonTranslatorDX/patch_ru.dat",
  "mods/NeonTranslatorDX/patch_de.dat",
  "mods/NeonTranslatorDX/active_lang.txt",
];

export interface MockOptions {
  /** Найти игру сразу (по умолчанию да). */
  found?: boolean;
  payloadExists?: boolean;
  /** Мод «уже стоит» при старте (для демонстрации экрана статуса). */
  installed?: boolean;
  /** Версия установленного мода (по умолчанию dev-версия пакета). */
  installedVersion?: string | null;
}

export function createMockPlatform(options: MockOptions = {}): InstallerPlatform {
  const found = options.found ?? true;
  let installed = options.installed ?? false;
  let installedLang: string | null = installed ? "ru" : null;
  let installedVersion: string | null = installed
    ? (options.installedVersion ?? MOCK_VERSION)
    : null;
  let progressListeners: Array<(progress: InstallProgress) => void> = [];

  const payload: PayloadStatus = {
    dir: "C:\\Tools\\NeonTranslatorDX Manager\\payload",
    exists: options.payloadExists ?? true,
    version: MOCK_VERSION,
    langs: ["de", "en", "fr", "it", "ko", "ru", "zh"],
  };

  const game = (): GameInfo => ({
    path: MOCK_GAME_PATH,
    library: "C:\\Program Files (x86)\\Steam",
    buildId: "9876543",
    modInstalled: installed,
    installedLang,
  });

  const status = (): StatusResult => ({
    installed,
    modDirExists: installed,
    manifestFound: installed,
    version: installedVersion,
    lang: installedLang,
    files: installed ? SAMPLE_FILES.length : 0,
    installedAt: installed ? "2026-11-25T10:00:00.000Z" : null,
    integrity: {
      state: installed ? "ok" : "unknown",
      checked: installed ? SAMPLE_FILES.length : 0,
      missing: 0,
      modified: 0,
      unlisted: 0,
    },
    problem: null,
  });

  const emit = (progress: InstallProgress) => {
    for (const listener of progressListeners) listener(progress);
  };

  const simulate = async (copied: number) => {
    for (let i = 0; i < SAMPLE_FILES.length; i++) {
      emit({ done: i + 1, total: SAMPLE_FILES.length, path: SAMPLE_FILES[i] });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return {
      lang: installedLang ?? "ru",
      payloadVersion: payload.version,
      files: SAMPLE_FILES.map((path, index) => ({
        path,
        size: 1024 * (index + 1),
        sha256: "mock",
      })),
      copied,
      skipped: SAMPLE_FILES.length - copied,
      bytes: copied * 2048,
      manifestPath: `${MOCK_GAME_PATH}\\mods\\NeonTranslatorDX\\install-manifest.json`,
      removedStale: [],
    };
  };

  return {
    kind: "mock",
    systemLocale: async () => "ru-RU",
    detectGame: async () => (found ? game() : null),
    probeGame: async (path) => ({
      check: { dir: path, ok: true, missing: [] },
      game: { ...game(), path },
    }),
    chooseFolder: async () => MOCK_GAME_PATH,
    payloadStatus: async () => payload,
    statusMod: async () => status(),
    install: async ({ lang }) => {
      installed = true;
      installedLang = lang;
      installedVersion = payload.version;
      return simulate(SAMPLE_FILES.length);
    },
    updateMod: async () => {
      installed = true;
      installedLang = installedLang ?? "ru";
      installedVersion = payload.version;
      return simulate(2);
    },
    uninstall: async () => {
      installed = false;
      installedLang = null;
      installedVersion = null;
      return {
        deleted: SAMPLE_FILES,
        kept: [],
        removedDirs: ["mods/NeonTranslatorDX", "mods"],
        manifestDeleted: true,
      };
    },
    verify: async () => ({
      installed,
      ok: installed,
      checked: installed ? SAMPLE_FILES.length : 0,
      lang: installedLang,
      missing: [],
      modified: [],
      invalid: [],
      unlisted: [],
    }),
    onProgress: (callback) => {
      progressListeners.push(callback);
      return () => {
        progressListeners = progressListeners.filter((cb) => cb !== callback);
      };
    },
  };
}
