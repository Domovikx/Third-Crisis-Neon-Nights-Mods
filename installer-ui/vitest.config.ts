import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";

import viteConfig from "./vite.config";

/**
 * Vitest берёт боевой vite-конфиг (алиас `@/`, плагин React и компиляцию
 * StyleX), чтобы тесты видели те же стили, что и приложение.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      exclude: ["node_modules/**", "dist/**", "src-tauri/**"],
    },
  }),
);
