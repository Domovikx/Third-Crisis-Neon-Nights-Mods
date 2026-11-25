import type { InstallerPlatform } from "@/core/types";

import { createMockPlatform } from "./mock";
import { isTauri, tauriPlatform } from "./tauri";

/** В окне Tauri — настоящий бэкенд, в браузере — мок (только для разработки). */
export function createPlatform(): InstallerPlatform {
  return isTauri() ? tauriPlatform : createMockPlatform();
}

export { isTauri };
