import { describe, expect, it } from "vitest";

import {
  canApply,
  initialState,
  installPercent,
  isInstalled,
  localeFromSystem,
  reduce,
  updateAvailable,
} from "./flow";
import type { GameInfo, InstallResult, PayloadStatus, StatusResult } from "./types";

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
  version: "2026.12.01",
  langs: ["de", "en", "ru"],
};

const installed: StatusResult = {
  installed: true,
  modDirExists: true,
  manifestFound: true,
  version: "2026.11.25",
  lang: "ru",
  files: 14,
  installedAt: "2026-11-25T10:00:00.000Z",
  integrity: { state: "ok", checked: 14, missing: 0, modified: 0, unlisted: 0 },
  problem: null,
};

const notInstalled: StatusResult = {
  installed: false,
  modDirExists: false,
  manifestFound: false,
  version: null,
  lang: null,
  files: 0,
  installedAt: null,
  integrity: { state: "unknown", checked: 0, missing: 0, modified: 0, unlisted: 0 },
  problem: null,
};

const installResult: InstallResult = {
  lang: "ru",
  payloadVersion: "2026.12.01",
  files: [],
  copied: 3,
  skipped: 11,
  bytes: 2048,
  manifestPath: "C:\\game\\mods\\NeonTranslatorDX\\install-manifest.json",
  removedStale: ["mods/NeonTranslatorDX/patch_it.dat"],
};

describe("reducer менеджера", () => {
  it("стартует со статуса и не даёт ставить без игры/payload", () => {
    const state = initialState("ru");
    expect(state.screen).toBe("status");
    expect(state.status).toBeNull();
    expect(canApply(state)).toBe(false);
  });

  it("refresh: игра + статус → можно ставить", () => {
    let state = reduce(initialState(), { type: "payload", payload });
    state = reduce(state, { type: "refreshStart" });
    expect(state.detecting).toBe(true);
    state = reduce(state, { type: "refreshDone", game, status: notInstalled });
    expect(state.detecting).toBe(false);
    expect(state.game?.path).toBe(game.path);
    expect(canApply(state)).toBe(true);
    expect(isInstalled(state)).toBe(false);
  });

  it("установка: progress → done, статус сразу «установлен»", () => {
    let state = reduce(initialState(), { type: "refreshDone", game, status: notInstalled });
    state = reduce(state, { type: "payload", payload });
    state = reduce(state, { type: "opStart", op: "install" });
    expect(state.screen).toBe("progress");
    expect(state.busy).toBe(true);
    state = reduce(state, { type: "progress", progress: { done: 3, total: 10, path: "a" } });
    expect(installPercent(state.progress)).toBe(30);
    state = reduce(state, { type: "opDone", op: "install", result: installResult });
    expect(state.screen).toBe("done");
    expect(state.busy).toBe(false);
    expect(state.status?.installed).toBe(true);
    expect(state.status?.version).toBe("2026.12.01");
    expect(state.status?.integrity.state).toBe("ok");
  });

  it("обновление доступно только при другой версии пакета", () => {
    const installedCurrent = { ...installed, version: payload.version };
    expect(updateAvailable({ status: installed, payload })).toBe(true);
    expect(updateAvailable({ status: installedCurrent, payload })).toBe(false);
    expect(updateAvailable({ status: notInstalled, payload })).toBe(false);
    expect(updateAvailable({ status: installed, payload: { ...payload, exists: false } })).toBe(
      false,
    );
  });

  it("обновление: op=update, экран done, версия новая", () => {
    let state = reduce(initialState(), { type: "refreshDone", game, status: installed });
    state = reduce(state, { type: "payload", payload });
    state = reduce(state, { type: "opStart", op: "update" });
    expect(state.op).toBe("update");
    state = reduce(state, { type: "opDone", op: "update", result: installResult });
    expect(state.screen).toBe("done");
    expect(state.op).toBe("update");
    expect(state.result?.copied).toBe(3);
    expect(state.status?.version).toBe("2026.12.01");
  });

  it("удаление сбрасывает статус", () => {
    let state = reduce(initialState(), { type: "refreshDone", game, status: installed });
    state = reduce(state, { type: "uninstallStart" });
    expect(state.screen).toBe("uninstall");
    expect(state.busy).toBe(true);
    state = reduce(state, {
      type: "uninstallDone",
      result: { deleted: ["dwmapi.dll"], kept: [], removedDirs: ["mods"], manifestDeleted: true },
    });
    expect(state.busy).toBe(false);
    expect(state.status?.installed).toBe(false);
    expect(state.status?.files).toBe(0);
    expect(state.game?.modInstalled).toBe(false);
  });

  it("проверка сохраняет экран verify", () => {
    let state = reduce(initialState(), { type: "refreshDone", game, status: installed });
    state = reduce(state, { type: "verifyStart" });
    expect(state.screen).toBe("verify");
    state = reduce(state, {
      type: "verifyDone",
      result: {
        installed: true,
        ok: false,
        checked: 14,
        lang: "ru",
        missing: ["x"],
        modified: [],
        invalid: [],
        unlisted: [],
      },
    });
    expect(state.busy).toBe(false);
    expect(state.verify?.ok).toBe(false);
  });

  it("ошибка снимает busy, но экран и операцию сохраняет", () => {
    let state = reduce(initialState(), { type: "refreshDone", game, status: installed });
    state = reduce(state, { type: "opStart", op: "update" });
    state = reduce(state, { type: "fail", code: "payload-missing: нет" });
    expect(state.screen).toBe("progress");
    expect(state.op).toBe("update");
    expect(state.busy).toBe(false);
    expect(state.error).toBe("payload-missing: нет");
    state = reduce(state, { type: "clearError" });
    expect(state.error).toBeNull();
  });

  it("выбор папки: успех и провал", () => {
    let state = reduce(initialState(), { type: "refreshDone", game: null, status: null });
    state = reduce(state, {
      type: "probeFailed",
      code: "game-invalid",
      missing: ["x.exe"],
    });
    expect(state.folderError).toBe("game-invalid");
    expect(state.folderMissing).toEqual(["x.exe"]);
    state = reduce(state, { type: "probeDone", game, status: notInstalled });
    expect(state.game?.path).toBe(game.path);
    expect(state.status?.installed).toBe(false);
    expect(state.folderError).toBeNull();
  });
});

describe("языки", () => {
  it("язык из системы: en/ru", () => {
    expect(localeFromSystem("en-US")).toBe("en");
    expect(localeFromSystem("ru-RU")).toBe("ru");
    expect(localeFromSystem("de-DE")).toBe("ru");
  });

  it("без busy и при отсутствии данных применять нельзя", () => {
    const base = reduce(initialState(), { type: "refreshDone", game, status: notInstalled });
    expect(canApply({ ...base, payload })).toBe(true);
    expect(canApply({ ...base, payload: { ...payload, exists: false } })).toBe(false);
    expect(canApply({ ...base, payload, busy: true })).toBe(false);
    expect(canApply({ ...base, game: null, payload })).toBe(false);
  });
});
