/**
 * Мок-транспорт: смотреть интерфейс в браузере (`npm run dev`) и тестировать
 * экраны без сборки exe. Это НЕ вторая реализация установки — только ответы
 * с правдоподобными данными.
 */
import type { GameInfo, InstallerPlatform, InstallProgress, PayloadStatus } from "@/core/types";

export const MOCK_GAME_PATH = "C:\\Games\\Third Crisis Neon Nights";

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
}

export function createMockPlatform(options: MockOptions = {}): InstallerPlatform {
  const found = options.found ?? true;
  let installed = false;
  let installedLang: string | null = null;
  let progressListeners: Array<(progress: InstallProgress) => void> = [];

  const payload: PayloadStatus = {
    dir: "C:\\Tools\\NeonTranslatorDX Installer\\payload",
    exists: options.payloadExists ?? true,
    version: "dev",
    langs: ["de", "en", "fr", "it", "ko", "ru", "zh"],
  };

  const game = (): GameInfo => ({
    path: MOCK_GAME_PATH,
    library: "C:\\Program Files (x86)\\Steam",
    buildId: "9876543",
    modInstalled: installed,
    installedLang,
  });

  const emit = (progress: InstallProgress) => {
    for (const listener of progressListeners) listener(progress);
  };

  return {
    kind: "mock",
    systemLocale: async () => "ru-RU",
    detectGame: async () => (found ? game() : null),
    probeGame: async (path) => ({
      check: {
        dir: path,
        ok: true,
        missing: [],
      },
      game: { ...game(), path },
    }),
    chooseFolder: async () => MOCK_GAME_PATH,
    payloadStatus: async () => payload,
    install: async ({ gameDir, lang }) => {
      for (let i = 0; i < SAMPLE_FILES.length; i++) {
        emit({ done: i + 1, total: SAMPLE_FILES.length, path: SAMPLE_FILES[i] });
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      installed = true;
      installedLang = lang;
      return {
        lang,
        payloadVersion: payload.version,
        files: SAMPLE_FILES.map((path, index) => ({
          path,
          size: 1024 * (index + 1),
          sha256: "mock",
        })),
        copied: SAMPLE_FILES.length,
        bytes: SAMPLE_FILES.length * 2048,
        manifestPath: `${gameDir}\\mods\\NeonTranslatorDX\\install-manifest.json`,
        removedStale: [],
      };
    },
    uninstall: async () => {
      installed = false;
      installedLang = null;
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
