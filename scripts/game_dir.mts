/**
 * game_dir.mts — находит и проверяет установку игры Third Crisis: Neon Nights.
 *
 * Репозиторий больше НЕ живёт внутри папки игры (в отличие от старого
 * NeonTranslator/), поэтому путь к игре определяется один раз здесь и
 * используется деплоем/сборкой. Порядок поиска:
 *
 *   1. env TCNN_GAME_DIR — явный оверрайд (главный способ).
 *   2. Steam: библиотеки из steamapps/libraryfolders.vdf известных установок.
 *   3. Прямые кандидаты вида <Steam>/steamapps/common/<GAME_FOLDER>.
 *
 * CLI: node scripts/game_dir.mts [--check]
 *   --check — печатает путь и наличие маркеров, код выхода 1 если игры нет.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

export const GAME_FOLDER = "Third Crisis Neon Nights";

/** Папка данных Unity: <GameFolder>_Data (не просто `_Data`). */
export const GAME_DATA_FOLDER = `${GAME_FOLDER}_Data`;

/** Файлы, без которых пайплайн работать не может. */
export const REQUIRED_MARKERS = [
  `${GAME_FOLDER}.exe`,
  join(GAME_DATA_FOLDER, "Managed", "Assembly-CSharp.dll"),
];

const STEAM_ROOTS = [
  "C:\\Program Files (x86)\\Steam",
  "C:\\Program Files\\Steam",
  "D:\\Steam",
  "D:\\SteamLibrary",
  "E:\\SteamLibrary",
];

/** Пути библиотек из steamapps/libraryfolders.vdf (регулярка по строкам `"path" "..."`). */
export function readLibraryFolders(steamRoot: string): string[] {
  const vdf = join(steamRoot, "steamapps", "libraryfolders.vdf");
  if (!existsSync(vdf)) return [];
  let text: string;
  try {
    text = readFileSync(vdf, "utf8");
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /"path"\s+"([^"]+)"/.exec(line);
    if (m) paths.push(m[1].replace(/\\\\/g, "\\"));
  }
  return paths;
}

/** Все известные библиотеки Steam: корни + их содержимое из vdf. */
export function steamLibraries(): string[] {
  const out = new Set<string>();
  for (const root of STEAM_ROOTS) {
    if (!existsSync(root)) continue;
    out.add(root);
    for (const lib of readLibraryFolders(root)) out.add(lib);
  }
  return [...out];
}

/** Кандидаты путей к игре в порядке приоритета. */
export function gameDirCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.TCNN_GAME_DIR) out.push(resolve(env.TCNN_GAME_DIR));
  for (const lib of steamLibraries()) {
    out.push(join(lib, "steamapps", "common", GAME_FOLDER));
  }
  return out;
}

/** Первый существующий каталог игры или null. */
export function findGameDir(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of gameDirCandidates(env)) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

export interface GameCheck {
  dir: string | null;
  ok: boolean;
  missing: string[];
}

/** Проверка, что в каталоге лежит именно игра и её сборки. */
export function checkGameDir(dir: string | null): GameCheck {
  if (!dir) return { dir: null, ok: false, missing: REQUIRED_MARKERS };
  const missing = REQUIRED_MARKERS.filter((m) => !existsSync(join(dir, m)));
  return { dir, ok: missing.length === 0, missing };
}

function main(argv: string[]): number {
  const found = findGameDir();
  const check = checkGameDir(found);
  if (!check.dir) {
    console.error("Игра не найдена. Задайте TCNN_GAME_DIR=<путь к папке игры>.");
    for (const c of gameDirCandidates()) console.error("  проверено:", c);
    return 1;
  }
  console.log("Игра:", check.dir);
  if (!check.ok) {
    console.error("Отсутствуют обязательные файлы:");
    for (const m of check.missing) console.error("  -", m);
    return 1;
  }
  if (argv.includes("--check")) console.log("OK: маркеры игры на месте.");
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
