import { describe, expect, it } from "vitest";

import {
  canInstall,
  initialState,
  installPercent,
  localeFromSystem,
  pickLang,
  reduce,
} from "./flow";
import type { InstallResult, GameInfo, PayloadStatus } from "./types";

const game: GameInfo = {
  path: "C:\\game",
  library: "C:\\Steam",
  buildId: "1",
  modInstalled: false,
  installedLang: null,
};

const payload: PayloadStatus = {
  dir: "C:\\payload",
  exists: true,
  version: "2026.11.25",
  langs: ["de", "en", "ru"],
};

const installResult: InstallResult = {
  lang: "de",
  payloadVersion: payload.version,
  files: [],
  copied: 7,
  bytes: 1024,
  manifestPath: "C:\\game\\mods\\NeonTranslatorDX\\install-manifest.json",
  removedStale: [],
};

describe("reducer", () => {
  it("старт: приветствие, ru, без игры", () => {
    const state = initialState("ru");
    expect(state.screen).toBe("welcome");
    expect(state.game).toBeNull();
    expect(canInstall(state)).toBe(false);
  });

  it("welcome → detect → найдена игра → установка → готово", () => {
    let state = reduce(initialState(), { type: "navigate", screen: "detect" });
    state = reduce(state, { type: "detectStart" });
    expect(state.detecting).toBe(true);
    state = reduce(state, { type: "detectDone", game });
    expect(state.detecting).toBe(false);
    expect(state.game?.path).toBe(game.path);

    state = reduce(state, { type: "payload", payload });
    expect(canInstall(state)).toBe(true);

    state = reduce(state, { type: "installStart" });
    expect(state.screen).toBe("installing");
    expect(state.busy).toBe(true);
    state = reduce(state, { type: "progress", progress: { done: 3, total: 10, path: "a" } });
    expect(installPercent(state.progress)).toBe(30);
    state = reduce(state, { type: "installDone", result: installResult });
    expect(state.screen).toBe("done");
    expect(state.busy).toBe(false);
    expect(state.game?.modInstalled).toBe(true);
    expect(state.game?.installedLang).toBe("de");
  });

  it("не найдена: игра остаётся null, выбор папки может исправить", () => {
    let state = reduce(initialState(), { type: "detectStart" });
    state = reduce(state, { type: "detectDone", game: null });
    expect(state.detecting).toBe(false);
    state = reduce(state, {
      type: "probeFailed",
      code: "game-invalid",
      missing: ["x.exe"],
    });
    expect(state.folderError).toBe("game-invalid");
    expect(state.folderMissing).toEqual(["x.exe"]);
    state = reduce(state, { type: "probeDone", game });
    expect(state.game?.path).toBe(game.path);
    expect(state.folderError).toBeNull();
    expect(state.folderMissing).toEqual([]);
  });

  it("удаление и проверка не теряют игру", () => {
    let state = reduce(initialState(), {
      type: "detectDone",
      game: { ...game, modInstalled: true },
    });
    state = reduce(state, { type: "uninstallStart" });
    expect(state.busy).toBe(true);
    state = reduce(state, {
      type: "uninstallDone",
      result: { deleted: ["dwmapi.dll"], kept: [], removedDirs: ["mods"], manifestDeleted: true },
    });
    expect(state.game?.modInstalled).toBe(false);
    expect(state.uninstall?.deleted).toEqual(["dwmapi.dll"]);

    state = reduce(state, { type: "verifyStart" });
    expect(state.screen).toBe("verify");
    state = reduce(state, {
      type: "verifyDone",
      result: {
        installed: false,
        ok: false,
        checked: 0,
        lang: null,
        missing: [],
        modified: [],
        invalid: [],
        unlisted: [],
      },
    });
    expect(state.busy).toBe(false);
    expect(state.verify?.installed).toBe(false);
  });

  it("ошибка снимает busy, но оставляет экран", () => {
    let state = reduce(initialState(), { type: "detectDone", game });
    state = reduce(state, { type: "installStart" });
    state = reduce(state, { type: "fail", code: "payload-missing: no" });
    expect(state.screen).toBe("installing");
    expect(state.busy).toBe(false);
    expect(state.error).toBe("payload-missing: no");
    state = reduce(state, { type: "clearError" });
    expect(state.error).toBeNull();
  });
});

describe("языки", () => {
  it("язык из системы: en/ru", () => {
    expect(localeFromSystem("en-US")).toBe("en");
    expect(localeFromSystem("ru-RU")).toBe("ru");
    expect(localeFromSystem("de-DE")).toBe("ru");
  });

  it("выбор языка: текущий → ru → первый", () => {
    expect(pickLang("de", payload)).toBe("de");
    expect(pickLang("fr", payload)).toBe("ru");
    expect(pickLang("fr", { ...payload, langs: ["it", "en"] })).toBe("it");
  });

  it("нельзя ставить без игры или без payload", () => {
    const base = reduce(initialState(), { type: "detectDone", game });
    expect(canInstall({ ...base, payload })).toBe(true);
    expect(canInstall({ ...base, payload: { ...payload, exists: false } })).toBe(false);
    expect(canInstall({ ...base, game: null, payload })).toBe(false);
    expect(canInstall({ ...base, payload, busy: true })).toBe(false);
  });
});
