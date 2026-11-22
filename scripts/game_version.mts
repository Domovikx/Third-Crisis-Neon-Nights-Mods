/**
 * game_version.mts — следит, не обновилась ли игра, и не устарел ли дамп.
 *
 * Зачем: дампер запускается редко — только когда игра обновилась. Без этой проверки
 * легко остаться с дампом от прошлой версии и переводить строки, которых уже нет
 * (или не видеть новых). Источник истины — Steam-манифест установки:
 * `<steamapps>/appmanifest_<appid>.acf` (buildid + LastUpdated).
 *
 * Снимок «с какой версии сделан дамп» хранится в `config/game-snapshot.json` и
 * коммитится: тогда любой (и CI) видит, актуален ли дамп.
 *
 * CLI:
 *   node scripts/game_version.mts           # сравнить с сохранённым снимком
 *   node scripts/game_version.mts --write   # записать текущую версию как «дамп актуален»
 *   node scripts/game_version.mts --json    # машинный вывод
 *
 * Коды выхода: 0 — совпадает; 1 — игра обновилась (нужен новый дамп); 2 — снимка нет.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import { findGameDir } from "./game_dir.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "..");
export const SNAPSHOT_PATH = join(REPO_ROOT, "config", "game-snapshot.json");

export interface GameSnapshot {
  appid: string;
  buildid: string;
  /** Epoch-секунды из манифеста (0, если поля нет). */
  lastUpdated: number;
  sizeOnDisk: number;
  installdir: string;
  /** Когда снимок записан (ISO). */
  recordedAt: string;
}

/** Разбор Valve KeyValues (.acf): плоские пары `"key" "value"`. */
export function parseAcf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*"([^"]+)"\s+"([^"]*)"\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** `<lib>/steamapps/common/<game>` → `<lib>/steamapps`. */
export function steamappsDir(gameDir: string): string {
  return resolve(gameDir, "..", "..");
}

/** Найти манифест этой установки (по `installdir`, иначе по имени папки). */
export function findAppManifest(gameDir: string): string | null {
  const dir = steamappsDir(gameDir);
  if (!existsSync(dir)) return null;
  const folder = basename(gameDir);
  const manifests = readdirSync(dir).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
  for (const f of manifests) {
    const full = join(dir, f);
    try {
      const acf = parseAcf(readFileSync(full, "utf8"));
      if (acf.installdir === folder) return full;
    } catch {
      /* нечитаемый манифест пропускаем */
    }
  }
  return null;
}

/** Текущая версия установки или null, если манифеста нет (не Steam-установка). */
export function readInstalledSnapshot(
  gameDir: string,
  now: Date = new Date(),
): GameSnapshot | null {
  const manifest = findAppManifest(gameDir);
  if (!manifest) return null;
  const acf = parseAcf(readFileSync(manifest, "utf8"));
  return {
    appid: acf.appid ?? "",
    buildid: acf.buildid ?? "",
    lastUpdated: Number(acf.LastUpdated ?? 0) || 0,
    sizeOnDisk: Number(acf.SizeOnDisk ?? 0) || 0,
    installdir: acf.installdir ?? "",
    recordedAt: now.toISOString(),
  };
}

/** Сохранённый снимок (с какой версии сделан дамп) или null. */
export function readSavedSnapshot(path: string = SNAPSHOT_PATH): GameSnapshot | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as GameSnapshot;
  } catch {
    return null;
  }
}

export interface SnapshotDiff {
  same: boolean;
  /** Человекочитаемые изменения (пусто, если версия та же). */
  changes: string[];
}

/** Сравнить снимки по значимым полям. */
export function compareSnapshots(prev: GameSnapshot, next: GameSnapshot): SnapshotDiff {
  const changes: string[] = [];
  if (prev.buildid !== next.buildid) {
    changes.push(`buildid: ${prev.buildid || "?"} -> ${next.buildid || "?"}`);
  }
  if (prev.appid && next.appid && prev.appid !== next.appid) {
    changes.push(`appid: ${prev.appid} -> ${next.appid}`);
  }
  if (prev.lastUpdated !== next.lastUpdated) {
    const asDate = (s: number): string => (s ? new Date(s * 1000).toISOString().slice(0, 10) : "?");
    changes.push(`обновлена: ${asDate(prev.lastUpdated)} -> ${asDate(next.lastUpdated)}`);
  }
  return { same: changes.length === 0, changes };
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const game = findGameDir();
  if (!game) {
    console.error("Игра не найдена. Задайте TCNN_GAME_DIR.");
    return 1;
  }
  const current = readInstalledSnapshot(game);
  if (!current) {
    console.error(`Steam-манифест не найден рядом с ${game} — версию проверить нечем.`);
    return 1;
  }

  if (argv.includes("--write")) {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + "\n", "utf8");
    console.log(`Снимок записан: ${SNAPSHOT_PATH}`);
    console.log(
      `  buildid ${current.buildid}, обновлена ${new Date(current.lastUpdated * 1000).toISOString().slice(0, 10)}`,
    );
    return 0;
  }

  const saved = readSavedSnapshot();
  if (!saved) {
    console.error("Снимка нет: неизвестно, с какой версии сделан дамп.");
    console.error("Записать текущую версию: npm run check:version -- --write");
    return 2;
  }

  const diff = compareSnapshots(saved, current);
  if (json) {
    console.log(JSON.stringify({ current, saved, diff }, null, 2));
  } else if (diff.same) {
    console.log(`Игра не менялась (buildid ${current.buildid}) — дамп актуален.`);
  } else {
    console.error("ИГРА ОБНОВИЛАСЬ — дамп устарел, нужен новый:");
    for (const c of diff.changes) console.error("  -", c);
    console.error("Дальше: npm run dump && npm run potgen -- --update && npm run po:update");
    console.error("Затем зафиксировать версию: npm run check:version -- --write");
  }
  return diff.same ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
