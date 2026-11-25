/**
 * Связка reducer'а с платформой: все побочные эффекты установщика здесь.
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

export function useInstaller(platform: InstallerPlatform) {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState("ru"));
  const [ready, setReady] = useState(false);

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

  useEffect(
    () => platform.onProgress((progress) => dispatch({ type: "progress", progress })),
    [platform],
  );

  const detect = useCallback(async () => {
    dispatch({ type: "detectStart" });
    try {
      const game = await platform.detectGame();
      dispatch({ type: "detectDone", game });
    } catch (error) {
      dispatch({ type: "fail", code: errorMessage(error) });
    }
  }, [platform]);

  const start = useCallback(() => {
    dispatch({ type: "navigate", screen: "detect" });
    void detect();
  }, [detect]);

  const chooseFolder = useCallback(async () => {
    try {
      const folder = await platform.chooseFolder();
      if (!folder) return;
      const probe = await platform.probeGame(folder);
      if (probe.game) dispatch({ type: "probeDone", game: probe.game });
      else
        dispatch({
          type: "probeFailed",
          code: "game-invalid",
          missing: probe.check.missing,
        });
    } catch (error) {
      dispatch({ type: "fail", code: errorMessage(error) });
    }
  }, [platform]);

  const install = useCallback(async () => {
    if (!state.game?.path) return;
    dispatch({ type: "installStart" });
    try {
      const result = await platform.install({ gameDir: state.game.path, lang: state.lang });
      dispatch({ type: "installDone", result });
    } catch (error) {
      dispatch({ type: "fail", code: errorMessage(error) });
    }
  }, [platform, state.game?.path, state.lang]);

  const uninstall = useCallback(async () => {
    if (!state.game?.path) return;
    dispatch({ type: "uninstallStart" });
    try {
      const result = await platform.uninstall(state.game.path);
      dispatch({ type: "uninstallDone", result });
    } catch (error) {
      dispatch({ type: "fail", code: errorMessage(error) });
    }
  }, [platform, state.game?.path]);

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
    start,
    detect,
    chooseFolder,
    install,
    uninstall,
    verify,
    navigate,
    setLocale,
    clearError,
  };
}

export type InstallerController = ReturnType<typeof useInstaller>;
