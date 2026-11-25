/**
 * Tauri-транспорт. Экраны не знают, где живут: они зовут методы
 * `InstallerPlatform`, а этот файл превращает их в `invoke(...)`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  GameInfo,
  InstallProgress,
  InstallResult,
  InstallerPlatform,
  PayloadStatus,
  ProbeResult,
  StatusResult,
  UninstallResult,
  VerifyResult,
} from "@/core/types";

/** Мы внутри окна Tauri (а не в браузере). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const tauriPlatform: InstallerPlatform = {
  kind: "tauri",
  systemLocale: () => invoke<string>("system_locale"),
  detectGame: () => invoke<GameInfo | null>("detect_game"),
  probeGame: (path) => invoke<ProbeResult>("probe_game", { path }),
  chooseFolder: async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Third Crisis Neon Nights",
    });
    return typeof picked === "string" ? picked : null;
  },
  payloadStatus: () => invoke<PayloadStatus>("payload_status"),
  statusMod: (gameDir) => invoke<StatusResult>("status_mod", { gameDir }),
  install: ({ gameDir, lang }) => invoke<InstallResult>("install_mod", { gameDir, lang }),
  updateMod: (gameDir) => invoke<InstallResult>("update_mod", { gameDir }),
  uninstall: (gameDir) => invoke<UninstallResult>("uninstall_mod", { gameDir }),
  verify: (gameDir) => invoke<VerifyResult>("verify_mod", { gameDir }),
  onProgress: (callback) => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen<InstallProgress>("mod-progress", (event) => callback(event.payload)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  },
};
