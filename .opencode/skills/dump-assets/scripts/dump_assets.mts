/**
 * dump_assets.mts — TS-дампер Unity-ассетов Third Crisis: Neon Nights.
 *
 * ПОКА РЕАЛИЗОВАНЫ СТАДИИ 0–2 (фундамент):
 *   0. харнесс паритета против Python-эталона — `scripts/dump_parity.mts`;
 *   1. контейнер UnityFS — `unityfs.mts`;
 *   2. SerializedFile (header/type table/object table/externals) — `serialized.mts`.
 *
 * Команда `structure` печатает то, что можно сверить с UnityPy уже сейчас:
 * список entry бандла и таблицу объектов (path_id, typeID) каждого файла.
 *
 * Стадии 3–4 (разбор типов и генерация JSONL-контракта, который читают
 * `inventory.mts`/`potgen.mts`) — следующий заход. Место под них — функция
 * `extractObject` ниже: сырые байты объекта она уже получает по path_id.
 *
 * CLI:
 *   node .opencode/skills/dump-assets/scripts/dump_assets.mts structure \
 *     [--all | --files <путь,путь,...>] [--json] [--no-objects]
 *
 * Путь к игре — только через `scripts/game_dir.mts` (env TCNN_GAME_DIR).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { checkGameDir, findGameDir, GAME_DATA_FOLDER } from "../../../../scripts/game_dir.mts";
import { isSerializedFile, readSerializedFile, type SerializedObject } from "./serialized.mts";
import { isUnityFs, readUnityFs } from "./unityfs.mts";

/** Кто перед нами: Unity-файл, сырой бинарь или .NET-сборка. */
export type AssetKind = "serialized" | "unityfs" | "raw" | "dotnet" | "unknown";

export interface StructureObject {
  /** Строкой: path_id бывает 64-битным и отрицательным. */
  pathId: string;
  typeId: number;
  classId: number;
}

export interface StructureSerializedFile {
  name: string;
  unityVersion: string;
  headerVersion: number;
  typeTreeEnabled: boolean;
  objectCount: number;
  objects: StructureObject[];
}

export interface StructureEntry {
  path: string;
  offset: number;
  size: number;
}

export interface StructureReport {
  /** Отображаемое имя (как у Python-дампа: level0, bundle_*, resource_*). */
  file: string;
  /** Абсолютный путь к исходному файлу. */
  path: string;
  kind: AssetKind;
  entries: StructureEntry[];
  files: StructureSerializedFile[];
  /** Текст ошибки разбора (файл остаётся в отчёте, прогон продолжается). */
  error?: string;
  /** Некритичные проблемы (например, битый entry бандла). */
  warnings?: string[];
}

function objectToStructure(obj: SerializedObject): StructureObject {
  return { pathId: obj.pathId.toString(), typeId: obj.typeId, classId: obj.classId };
}

function serializedToStructure(
  name: string,
  bytes: Uint8Array,
  includeObjects: boolean,
): StructureSerializedFile {
  const sf = readSerializedFile(bytes);
  return {
    name,
    unityVersion: sf.header.unityVersion,
    headerVersion: sf.header.version,
    typeTreeEnabled: sf.header.enableTypeTree,
    objectCount: sf.objects.length,
    objects: includeObjects ? sf.objects.map(objectToStructure) : [],
  };
}

/**
 * Расширения, которые UnityPy НЕ пытается разбирать как SerializedFile
 * (сырые ресурсы рядом с ассетом). Повторяем список, иначе `.resS` с
 * нулевой «версией» в заголовке примет себя за SerializedFile.
 */
const NON_SERIALIZED_EXTENSIONS = [".resS", ".resource", ".config", ".xml", ".dat"];

function isNonSerializedEntryName(path: string): boolean {
  return NON_SERIALIZED_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * Разобрать один файл до уровня «entry + объекты».
 *
 * `includeObjects = false` экономит память на больших ассетах (resources.assets
 * — сотни тысяч объектов), оставляя только счётчики.
 */
export function describeAssetFile(
  file: string,
  path: string,
  bytes: Uint8Array,
  includeObjects = true,
): StructureReport {
  const report: StructureReport = { file, path, kind: "unknown", entries: [], files: [] };

  try {
    if (isUnityFs(bytes)) {
      report.kind = "unityfs";
      const archive = readUnityFs(bytes);
      report.entries = archive.entries.map((e) => ({
        path: e.path,
        offset: e.offset,
        size: e.size,
      }));
      for (const entry of archive.entries) {
        if (isNonSerializedEntryName(entry.path)) continue;
        const body = archive.readEntry(entry);
        if (!isSerializedFile(body)) continue;
        try {
          report.files.push(serializedToStructure(entry.path, body, includeObjects));
        } catch (err) {
          // Один битый entry не должен обнулять отчёт по всему бандлу.
          (report.warnings ??= []).push(
            `${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return report;
    }
    if (isSerializedFile(bytes)) {
      report.kind = "serialized";
      const internalName = path.split(/[\\/]/).pop() ?? file;
      report.files.push(serializedToStructure(internalName, bytes, includeObjects));
      return report;
    }
    // Сырые .resource и .NET-сборки разбираются на стадии 3 (raw-скан).
    if (path.toLowerCase().endsWith(".dll")) report.kind = "dotnet";
    else if (path.toLowerCase().endsWith(".resource")) report.kind = "raw";
  } catch (err) {
    // Ошибка формата — это данные отчёта, а не падение всего прогона.
    report.kind = "unknown";
    report.error = err instanceof Error ? err.message : String(err);
  }
  return report;
}

export interface DiscoveredFile {
  name: string;
  path: string;
}

/** Найти бандлы рекурсивно (StreamingAssets может быть глубоким). */
function findBundles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(current, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else if (name.endsWith(".bundle")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Список файлов игры — ровно как в Python-эталоне (display-имена совпадают,
 * чтобы будущий daмп-parity сравнивал одно и то же).
 */
export function discoverGameFiles(gameDir: string): DiscoveredFile[] {
  const dataDir = join(gameDir, GAME_DATA_FOLDER);
  const out: DiscoveredFile[] = [];
  for (let i = 0; i < 16; i++) {
    const p = join(dataDir, `level${i}`);
    if (exists(p)) out.push({ name: `level${i}`, path: p });
  }
  for (let i = 0; i < 16; i++) {
    const p = join(dataDir, `sharedassets${i}.assets`);
    if (exists(p)) out.push({ name: `sharedassets${i}`, path: p });
  }
  // Python-эталон даёт обоим globalgamemanagers* одно display-имя и второй
  // файл пропускает (dedupe по display). Повторяем ровно это: иначе паритет
  // набора файлов разъедется.
  const seenDisplay = new Set<string>();
  for (const name of ["resources.assets", "globalgamemanagers.assets", "globalgamemanagers"]) {
    const p = join(dataDir, name);
    if (!exists(p)) continue;
    const display = name.replace(/\.assets$/, "");
    if (seenDisplay.has(display)) continue;
    seenDisplay.add(display);
    out.push({ name: display, path: p });
  }
  for (const p of findBundles(join(dataDir, "StreamingAssets"))) {
    const base = p.split(/[\\/]/).pop() ?? p;
    const display = base.replace(/\.bundle$/, "").slice(0, 60);
    out.push({ name: `bundle_${display}`, path: p });
  }
  let resources: string[] = [];
  try {
    resources = readdirSync(dataDir)
      .filter((n) => n.endsWith(".resource"))
      .sort()
      .map((n) => join(dataDir, n));
  } catch {
    resources = [];
  }
  for (const p of resources) {
    const base = p.split(/[\\/]/).pop() ?? p;
    out.push({ name: `resource_${base.replace(/\.resource$/, "")}`, path: p });
  }
  const managed = join(dataDir, "Managed");
  for (const dll of ["Assembly-CSharp.dll", "Assembly-CSharp-firstpass.dll"]) {
    const p = join(managed, dll);
    if (exists(p)) out.push({ name: `dll_${dll.replace(/\.dll$/, "")}`, path: p });
  }
  return out;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Стадии 3–4: разбор объектов по типам и генерация JSONL-контракта. */
export function extractObject(_file: StructureSerializedFile, _raw: Uint8Array): never {
  throw new Error(
    "extractObject: стадии 3–4 ещё не реализованы (см. tasks/2026-11-21-dump-assets-island.md)",
  );
}

// ---------------------------------------------------------------- CLI

function humanReport(report: StructureReport): string {
  const lines: string[] = [];
  if (report.kind === "unityfs") {
    lines.push(`${report.file}  unityfs entries=${report.entries.length}`);
  } else {
    lines.push(`${report.file}  ${report.kind}`);
  }
  for (const f of report.files) {
    lines.push(
      `  ${f.name}  serialized v${f.headerVersion} (${f.unityVersion}) ` +
        `objects=${f.objectCount} typeTree=${f.typeTreeEnabled ? "on" : "off"}`,
    );
  }
  if (report.error) lines.push(`  ОШИБКА: ${report.error}`);
  return lines.join("\n");
}

function usage(): void {
  console.error(
    [
      "usage: dump_assets.mts structure [--all | --files <путь,...>] [--json] [--no-objects]",
      "",
      "  --all          все Unity-файлы установленной игры (нужен TCNN_GAME_DIR)",
      "  --files a,b    конкретные файлы (пути или имена из установки)",
      "  --json         машинный отчёт: один JSON на файл (JSONL) в stdout",
      "  --no-objects   без списка объектов (только счётчики)",
    ].join("\n"),
  );
}

function resolveFiles(argv: string[], gameDir: string | null): DiscoveredFile[] {
  let raw = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--files=")) raw = argv[i].slice("--files=".length);
    else if (argv[i] === "--files" && i + 1 < argv.length) raw = argv[i + 1];
  }
  if (raw) {
    const discovered = gameDir ? discoverGameFiles(gameDir) : [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((item) => {
        const base = item.split(/[\\/]/).pop() ?? item;
        const match =
          discovered.find((d) => d.name === item) ??
          discovered.find((d) => (d.path.split(/[\\/]/).pop() ?? "") === base);
        return { name: match?.name ?? base, path: resolve(match?.path ?? item) };
      });
  }
  if (!gameDir) {
    console.error("Игра не найдена: задайте TCNN_GAME_DIR или передайте --files.");
    return [];
  }
  return discoverGameFiles(gameDir);
}

function main(argv: string[]): number {
  const command = argv[0];
  if (command !== "structure") {
    usage();
    return 2;
  }
  const json = argv.includes("--json");
  const includeObjects = !argv.includes("--no-objects");
  const found = findGameDir();
  const game = checkGameDir(found);
  if (!game.ok && !argv.some((a) => a.startsWith("--files"))) {
    console.error("Игра не найдена или неполная. Проверьте TCNN_GAME_DIR:", found ?? "(нет)");
    return 2;
  }
  const targets = resolveFiles(argv, game.dir);
  if (targets.length === 0) return 2;

  let failed = 0;
  for (const target of targets) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(target.path));
    } catch (err) {
      console.error(`${target.name}: не читается: ${err instanceof Error ? err.message : err}`);
      failed += 1;
      continue;
    }
    const report = describeAssetFile(target.name, target.path, bytes, includeObjects);
    if (report.kind === "unknown") failed += 1;
    if (json) console.log(JSON.stringify(report));
    else console.log(humanReport(report));
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
