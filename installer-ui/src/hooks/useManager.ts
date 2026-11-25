/**
 * Связка reducer'а с платформой: все побочные эффекты менеджера здесь.
 * Экраны получают готовые колбэки и состояние, поэтому их можно рендерить
 * в тестах без Tauri.
 */
import { useCallback, useEffect, useReducer, useState } from "react";

import { initialState, localeFromSystem, reduce } from "@/core/flow";
import type { Screen } from "@/core/flow";
import type { InstallerPlatform } from "@/core/types";

/** Tauri отдаёт `Err(String)` строкой; на всякий случай разбираем и Error. */
function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useManager(platform: InstallerPlatform) {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState("ru"));
  const [ready, setReady] = useState(false);

  /** Опросить игру и статус мода; вызывается после каждой операции. */
  const refresh = useCallback(async () => {
    dispatch({ type: "refreshStart" });
    try {
      const game = await platform.detectGame();
      const status = game ? await platform.statusMod(game.path) : null;
      dispatch({ type: "refreshDone", game, status });
    } catch (error) {
      dispatch({ type: "fail", code: errorMessage(error) });
    }
  }, [platform]);

  useEffect(() => {
    let alive = true;
    void Promise.all([platform.systemLocale(), platform.payloadStatus()])
      .then(([system, payload]) => {
        if (!alive) return;
        dispatch({ type: "setLocale", locale: localeFromSystem(system) });
        dispatch({ type: "payload", payload });
        setReady(true);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        dispatch({ type: "fail", code: errorMessage(error) });
        setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [platform]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => platform.onProgress((progress) => dispatch({ type: "progress", progress })),
    [platform],
  );

  const install = useCallback(async () => {
    if (!state.game?.path) return;
    dispatch({ type: "opStart", op: "install" });
    try {
      const result = await platform.install({ gameDir: state.game.path, lang: "ru" });
      dispatch({ type: "opDone", op: "install", result });
      void refresh();
    } catch (error) {
      dispatch({ type: "fail", code: errorMessage(error) });
    }
  }, [platform, refresh, state.game?.path]);

  const update = useCallback(async () => {
    if (!state.game?.path) return;
    dispatch({ type: "opStart", op: "update" });
    try {
      const result = await platform.updateMod(state.game.path);
      dispatch({ type: "opDone", op: "update", result });
      void refresh();
    } catch (error) {
      dispatch({ type: "fail", code: errorMessage(error) });
    }
  }, [platform, refresh, state.game?.path]);

  const retry = useCallback(() => {
    if (state.op === "update") void update();
    else void install();
  }, [install, state.op, update]);

  const uninstall = useCallback(async () => {
    if (!state.game?.path) return;
    dispatch({ type: "uninstallStart" });
    try {
      const result = await platform.uninstall(state.game.path);
      dispatch({ type: "uninstallDone", result });
      void refresh();
    } catch (error) {
      dispatch({ type: "fail", code: errorMessage(error) });
    }
  }, [platform, refresh, state.game?.path]);

  const verify = useCallback(async () => {
    if (!state.game?.path) return;
    dispatch({ type: "verifyStart" });
    try {
      const result = await platform.verify(state.game.path);
      dispatch({ type: "verifyDone", result });
    } catch (error) {
      dispatch({ type: "fail", code: errorMessage(error) });
    }
  }, [platform, state.game?.path]);

  const chooseFolder = useCallback(async () => {
    try {
      const folder = await platform.chooseFolder();
      if (!folder) return;
      const probe = await platform.probeGame(folder);
      if (probe.game) {
        const status = await platform.statusMod(probe.game.path);
        dispatch({ type: "probeDone", game: probe.game, status });
      } else {
        dispatch({ type: "probeFailed", code: "game-invalid", missing: probe.check.missing });
      }
    } catch (error) {
      dispatch({ type: "fail", code: errorMessage(error) });
    }
  }, [platform]);

  const navigate = useCallback((screen: Screen) => {
    dispatch({ type: "navigate", screen });
  }, []);

  const setLocale = useCallback((locale: "ru" | "en") => {
    dispatch({ type: "setLocale", locale });
  }, []);

  const clearError = useCallback(() => {
    dispatch({ type: "clearError" });
  }, []);

  return {
    state,
    ready,
    refresh,
    install,
    update,
    retry,
    uninstall,
    verify,
    chooseFolder,
    navigate,
    setLocale,
    clearError,
  };
}

export type ManagerController = ReturnType<typeof useManager>;
