/**
 * dump_assets.mts — TS-дампер Unity-ассетов Third Crisis: Neon Nights.
 *
 * Реализованы все стадии:
 *   0. харнесс паритета против Python-эталона — `scripts/dump_parity.mts`;
 *   1. контейнер UnityFS — `unityfs.mts` (свой LZ4/LZMA);
 *   2. SerializedFile (header/type table/object table/externals) — `serialized.mts`;
 *   3. объекты: raw-сканеры, типизированные поля по type tree из файла
 *      (`extract.mts`, `rawscan.mts`, `typetree.mts`);
 *   4. полный дамп JSONL (`summaries.jsonl` + `<asset>.jsonl`) — команда `dump`.
 *
 * CLI:
 *   node .opencode/skills/dump-assets/scripts/dump_assets.mts structure \
 *     [--all | --files <путь,путь,...>] [--json] [--no-objects]
 *   node .opencode/skills/dump-assets/scripts/dump_assets.mts dump \
 *     [--out <каталог>] [--all | --files <путь,...>]
 *
 * Путь к игре — только через `scripts/game_dir.mts` (env TCNN_GAME_DIR).
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { checkGameDir, findGameDir, GAME_DATA_FOLDER } from "../../../../scripts/game_dir.mts";
import { scanDotnetSettings, scanDotnetUiStrings } from "./dotnet.mts";
import { extractObject, type RawScans } from "./extract.mts";
import { JsonlWriter } from "./jsonl.mts";
import {
  isGlobalStringCandidate,
  scanGlobalStrings,
  scanSettingsKeys,
  uiPriority,
} from "./rawscan.mts";
import { cpLen, pyStrip } from "./pystr.mts";
import { runRustDecoder, type RawTarget } from "./rawdump.mts";
import type { Endian } from "./binary.mts";
import { isSerializedFile, readSerializedFile, type SerializedObject } from "./serialized.mts";
import { parseTypeTree, type TypeTreeNode } from "./typetree.mts";
import { unityClassName } from "./unity_classes.mts";
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
 * Все числовые индексы файлов вида `<prefix><N><suffix>` в каталоге, по возрастанию.
 *
 * Почему не диапазон `0..15`: Python-эталон жёстко ограничивал обход шестнадцатью
 * сценами, а в установке их девятнадцать — `level16..18` и `sharedassets16..18`
 * молча не попадали в дамп (найдено 2026-11-22: ~70 000 объектов, включая цели
 * квестов). Обход по факту наличия файлов лечит это и не теряет новые сцены
 * после апдейта игры.
 */
export function sceneIndexes(dataDir: string, prefix: string, suffix = ""): number[] {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`^${prefix}(\\d+)${escaped}$`);
  const out: number[] = [];
  for (const name of readdirSync(dataDir)) {
    const m = rx.exec(name);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

/**
 * Список файлов игры: сцены — по факту наличия файлов (не диапазоном),
 * остальное — как в Python-эталоне (display-имена совпадают, чтобы паритет
 * сравнивал одно и то же).
 */
export function discoverGameFiles(gameDir: string): DiscoveredFile[] {
  const dataDir = join(gameDir, GAME_DATA_FOLDER);
  const out: DiscoveredFile[] = [];
  for (const i of sceneIndexes(dataDir, "level")) {
    out.push({ name: `level${i}`, path: join(dataDir, `level${i}`) });
  }
  for (const i of sceneIndexes(dataDir, "sharedassets", ".assets")) {
    out.push({ name: `sharedassets${i}`, path: join(dataDir, `sharedassets${i}.assets`) });
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

/** Один объект с контекстом разбора: сырые байты, type tree и порядок байт. */
export interface CollectedObject {
  obj: SerializedObject;
  raw: Uint8Array;
  tree: TypeTreeNode | null;
  endian: Endian;
}

/**
 * Собрать объекты SerializedFile с сырыми байтами и разобранным type tree.
 *
 * Type tree парсится один раз на тип файла (кэш по typeId): в бандлах он
 * включён, в `*.assets` его нет — тогда `tree = null` и типизированная часть
 * объекта помечается `read_failed` (как у эталона на MonoBehaviour).
 */
export function collectSerializedObjects(body: Uint8Array): CollectedObject[] {
  const sf = readSerializedFile(body);
  const trees = new Map<number, TypeTreeNode | null>();
  const out: CollectedObject[] = [];
  for (const obj of sf.objects) {
    let tree = trees.get(obj.typeId);
    if (tree === undefined) {
      const info = sf.types[obj.typeId]?.typeTree;
      if (info) {
        try {
          tree = parseTypeTree(sf.raw, info, sf.header.endian);
        } catch {
          tree = null;
        }
      } else {
        tree = null;
      }
      trees.set(obj.typeId, tree);
    }
    out.push({
      obj,
      raw: sf.raw.subarray(obj.byteStart, obj.byteStart + obj.byteSize),
      tree,
      endian: sf.header.endian,
    });
  }
  return out;
}

/** Разложить файл на объекты (бандл → все внутренние SerializedFile). */
export function collectAssetObjects(bytes: Uint8Array): CollectedObject[] {
  if (isUnityFs(bytes)) {
    const archive = readUnityFs(bytes);
    const out: CollectedObject[] = [];
    for (const entry of archive.entries) {
      if (isNonSerializedEntryName(entry.path)) continue;
      const body = archive.readEntry(entry);
      if (!isSerializedFile(body)) continue;
      try {
        out.push(...collectSerializedObjects(body));
      } catch {
        // Один битый entry не обнуляет ассет: строки остальных всё равно в дамп.
        // (Эталон в такой ситуации теряет ассет целиком — расхождение осознанное.)
      }
    }
    return out;
  }
  if (isSerializedFile(bytes)) return collectSerializedObjects(bytes);
  return [];
}

/** `Counter.most_common()`: по убыванию частоты, равные — в порядке встречи. */
export function counterMostCommon(values: Iterable<string>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const name of values) counts.set(name, (counts.get(name) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const result: Record<string, number> = {};
  for (const [name, count] of sorted) result[name] = count;
  return result;
}

export function countObjectTypes(objects: CollectedObject[]): Record<string, number> {
  return counterMostCommon(objects.map((item) => unityClassName(item.obj.classId)));
}

/** Пара «ключ → подпись» для `summaries.jsonl`. */
export interface SettingsEntry {
  key: string;
  display: string;
}

/** settings_keys + global_strings из сырых байтов ассета (порт эталона). */
export function scanFileStrings(rawData: Uint8Array): {
  settings: SettingsEntry[];
  globalStrings: string[];
} {
  const settings = scanSettingsKeys(rawData);
  const found = new Set<string>();
  for (const item of settings) {
    found.add(item.key);
    found.add(item.display);
  }
  const globalStrings = scanGlobalStrings(rawData).filter((text) => !found.has(text));
  return { settings, globalStrings };
}

/**
 * settings_keys для .NET-сборки: ключи + автономные UI-строки.
 *
 * `heapRange` — границы кучи `#US`, если декодер отдал только её.
 */
export function scanDotnetStrings(
  rawData: Uint8Array,
  heapRange?: [number, number],
): SettingsEntry[] {
  const settings = scanDotnetSettings(rawData);
  const uiStrings = scanDotnetUiStrings(rawData, heapRange);
  const displays = new Set(settings.map((item) => item.display));
  for (const text of uiStrings) {
    if (!displays.has(text)) settings.push({ key: text, display: text });
  }
  return settings;
}

export interface DumpStats {
  assets: number;
  objects: number;
  /** Файлы, которые не удалось прочитать (бандл/ассет битый). */
  failed: number;
}

/**
 * Полный дамп: `summaries.jsonl` + `<asset>.jsonl` на каждый файл.
 *
 * Порядок и имена файлов — те же, что у Python-эталона: уровень/шенный
 * ассет → бандлы → `.resource` → DLL. `index.md` — человеческий индекс.
 */
export function dumpAssets(targets: DiscoveredFile[], outDir: string): DumpStats {
  mkdirSync(outDir, { recursive: true });
  const summariesPath = join(outDir, "summaries.jsonl");
  const summaries = new JsonlWriter(summariesPath);
  const stats: DumpStats = { assets: 0, objects: 0, failed: 0 };
  const index: Array<{ name: string; total: number }> = [];

  try {
    for (const target of targets) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(target.path));
      } catch (err) {
        console.error(`    ERROR: ${target.name}: ${err instanceof Error ? err.message : err}`);
        stats.failed += 1;
        continue;
      }
      try {
        const lower = target.path.toLowerCase();
        if (lower.endsWith(".dll")) {
          const settings = scanDotnetStrings(bytes);
          summaries.write({
            schema_version: "3",
            asset: target.name,
            total_objects: 0,
            object_types: {},
            format: "dotnet_us_heap",
            ...(settings.length > 0 ? { settings_keys: settings } : {}),
          });
          index.push({ name: target.name, total: 0 });
          stats.assets += 1;
          continue;
        }
        if (lower.endsWith(".resource")) {
          const { settings, globalStrings } = scanFileStrings(bytes);
          summaries.write({
            schema_version: "3",
            asset: target.name,
            total_objects: 0,
            object_types: {},
            format: "raw_binary",
            ...(settings.length > 0 ? { settings_keys: settings } : {}),
            ...(globalStrings.length > 0 ? { global_strings: globalStrings } : {}),
          });
          index.push({ name: target.name, total: 0 });
          stats.assets += 1;
          continue;
        }

        const objects = collectAssetObjects(bytes);
        const objectTypes = countObjectTypes(objects);
        const { settings, globalStrings } = scanFileStrings(bytes);
        summaries.write({
          schema_version: "3",
          asset: target.name,
          total_objects: objects.length,
          object_types: objectTypes,
          ...(settings.length > 0 ? { settings_keys: settings } : {}),
          ...(globalStrings.length > 0 ? { global_strings: globalStrings } : {}),
        });

        const writer = new JsonlWriter(join(outDir, `${target.name}.jsonl`));
        try {
          for (const item of objects) {
            writer.write({
              asset: target.name,
              ...extractObject(item.obj, item.raw, item.tree, item.endian),
            });
          }
        } finally {
          writer.close();
        }
        index.push({ name: target.name, total: objects.length });
        stats.objects += objects.length;
        stats.assets += 1;
        console.error(`  ${target.name}: ${objects.length} objects`);
      } catch (err) {
        console.error(`    ERROR: ${target.name}: ${err instanceof Error ? err.message : err}`);
        stats.failed += 1;
      }
    }
  } finally {
    summaries.close();
  }

  const indexLines = ["# Asset Dump Index (Unity)", "", "| File | Objects |", "|------|---------|"];
  for (const item of [...index].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    indexLines.push(`| [${item.name}](${item.name}.jsonl) | ${item.total} |`);
  }
  writeFileSync(join(outDir, "index.md"), `${indexLines.join("\n")}\n`, "utf8");

  return stats;
}

// ------------------------------------------------ чтение rd1 (Rust-декодер)

/**
 * Построчное чтение файла синхронно.
 *
 * rd1 бывает в сотни МБ (печатные строки всех ассетов), поэтому `readFileSync`
 * целиком не годится: читаем блоками и режем по `\n`. Декодер строки держит
 * состояние между блоками — UTF-8-символ не рвётся на границе.
 */
function* readLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  const decoder = new TextDecoder("utf-8");
  const buffer = Buffer.alloc(1 << 23);
  let carry = "";
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      carry += decoder.decode(buffer.subarray(0, read), { stream: true });
      let from = 0;
      for (;;) {
        const at = carry.indexOf("\n", from);
        if (at < 0) break;
        const line = carry.slice(from, at);
        from = at + 1;
        if (line) yield line;
      }
      carry = carry.slice(from);
    }
    carry += decoder.decode();
    if (carry) yield carry;
  } finally {
    closeSync(fd);
  }
}

interface RawAssetRecord {
  t: "asset";
  asset: string;
  path: string;
  kind: AssetKind;
  entries?: StructureEntry[];
  error?: string;
}

interface RawSfRecord {
  t: "sf";
  i: number;
  name: string;
  unityVersion: string;
  headerVersion: number;
  typeTreeEnabled: boolean;
  objectCount: number;
  endian: Endian;
}

interface RawTypeRecord {
  t: "type";
  sf: number;
  typeId: number;
  classId: number;
  nodeCount: number;
  stringSize: number;
  blob: string;
}

interface RawObjectRecord {
  t: "obj";
  sf: number;
  typeId: number;
  classId: number;
  pathId: string;
  raw?: string;
  rs?: string[];
  dl?: Array<{ offset: number; speaker: string; text: string; rich_text: string }>;
  cpl?: Record<string, string>;
}

interface RawWarnRecord {
  t: "warn";
  texts: string[];
}

interface RawRunsRecord {
  t: "runs";
  texts: string[];
}

interface RawKeysRecord {
  t: "keys";
  keys: SettingsEntry[];
}

interface RawUsRecord {
  t: "us";
  heap: string;
}

type RawRecord =
  | RawAssetRecord
  | RawSfRecord
  | RawTypeRecord
  | RawObjectRecord
  | RawWarnRecord
  | RawRunsRecord
  | RawKeysRecord
  | RawUsRecord;

/** Разобранный SerializedFile из rd1 (type tree — по требованию). */
interface RawFileState {
  name: string;
  unityVersion: string;
  headerVersion: number;
  typeTreeEnabled: boolean;
  objectCount: number;
  endian: Endian;
  trees: Map<number, TypeTreeNode | null>;
}

interface RawContext {
  asset: RawAssetRecord;
  files: RawFileState[];
  classNames: string[];
  warnings: string[];
  settings: SettingsEntry[] | null;
  /** Печатные строки файла как есть (фильтр UI — на финализации). */
  runs: string[];
  globalStrings: string[] | null;
  dotnetSettings: SettingsEntry[] | null;
  writer: JsonlWriter | null;
  objects: number;
}

const EMPTY_BYTES = new Uint8Array(0);

/** Пути к промежуточному rd1 для режима `--decoder rust`. */
export function rawDumpPath(outDir: string): string {
  return join(REPO_ROOT, "tmp", "raw", `${basename(outDir)}.rd1.jsonl`);
}

/**
 * Собрать полный дамп (`summaries.jsonl` + `<asset>.jsonl`) из rd1.
 *
 * Это ЧИТАЮЩАЯ половина адаптера: вся семантика (какие поля попадут в JSONL,
 * фильтры UI-строк, порядок, дедуп, имена) выполняется здесь, теми же
 * функциями, что и в TS-пути. Rust поставляет только факты из байтов.
 */
export function dumpAssetsFromRaw(rawPath: string, outDir: string): DumpStats {
  mkdirSync(outDir, { recursive: true });
  const summariesPath = join(outDir, "summaries.jsonl");
  const summaries = new JsonlWriter(summariesPath);
  const stats: DumpStats = { assets: 0, objects: 0, failed: 0 };
  const index: Array<{ name: string; total: number }> = [];
  let context: RawContext | null = null;

  const finalize = (): void => {
    if (!context) return;
    const ctx = context;
    context = null;
    ctx.writer?.close();
    if (ctx.asset.error !== undefined) {
      console.error(`    ERROR: ${ctx.asset.asset}: ${ctx.asset.error}`);
      stats.failed += 1;
      return;
    }
    const row: Record<string, unknown> = {
      schema_version: "3",
      asset: ctx.asset.asset,
      total_objects: ctx.objects,
      object_types: counterMostCommon(ctx.classNames),
    };
    if (ctx.asset.kind === "dotnet") {
      row.format = "dotnet_us_heap";
      if (ctx.dotnetSettings && ctx.dotnetSettings.length > 0) {
        row.settings_keys = ctx.dotnetSettings;
      }
    } else {
      if (ctx.asset.kind === "raw") row.format = "raw_binary";
      if (ctx.settings && ctx.settings.length > 0) row.settings_keys = ctx.settings;
      // Как `scanFileStrings`: из global_strings выпадают ключи/подписи настроек.
      const found = new Set<string>();
      for (const item of ctx.settings ?? []) {
        found.add(item.key);
        found.add(item.display);
      }
      const globalStrings = selectGlobalStrings(ctx.runs).filter((text) => !found.has(text));
      if (globalStrings.length > 0) row.global_strings = globalStrings;
    }
    summaries.write(row);
    index.push({ name: ctx.asset.asset, total: ctx.objects });
    stats.assets += 1;
    stats.objects += ctx.objects;
    // Для dll/.resource строк объектов нет — как и в TS-пути.
    if (ctx.asset.kind !== "dotnet" && ctx.asset.kind !== "raw") {
      console.error(`  ${ctx.asset.asset}: ${ctx.objects} objects`);
    }
  };

  try {
    for (const line of readLines(rawPath)) {
      const record = JSON.parse(line) as RawRecord;
      if (record.t === "asset") {
        finalize();
        const writer =
          record.kind === "dotnet" || record.kind === "raw"
            ? null
            : new JsonlWriter(join(outDir, `${record.asset}.jsonl`));
        context = {
          asset: record,
          files: [],
          classNames: [],
          warnings: [],
          settings: null,
          runs: [],
          globalStrings: null,
          dotnetSettings: null,
          writer,
          objects: 0,
        };
        continue;
      }
      const ctx = context;
      if (!ctx) continue;
      switch (record.t) {
        case "sf": {
          ctx.files[record.i] = {
            name: record.name,
            unityVersion: record.unityVersion,
            headerVersion: record.headerVersion,
            typeTreeEnabled: record.typeTreeEnabled,
            objectCount: record.objectCount,
            endian: record.endian,
            trees: new Map(),
          };
          break;
        }
        case "type": {
          const file = ctx.files[record.sf];
          if (!file) break;
          const blob = Buffer.from(record.blob, "base64");
          let tree: TypeTreeNode | null = null;
          try {
            tree = parseTypeTree(
              new Uint8Array(blob),
              {
                nodeCount: record.nodeCount,
                stringBufferSize: record.stringSize,
                blobStart: 0,
                blobEnd: blob.length,
              },
              file.endian,
            );
          } catch {
            tree = null;
          }
          file.trees.set(record.typeId, tree);
          break;
        }
        case "obj": {
          const file = ctx.files[record.sf];
          if (!file || !ctx.writer) break;
          const raw = record.raw ? new Uint8Array(Buffer.from(record.raw, "base64")) : EMPTY_BYTES;
          const obj: SerializedObject = {
            pathId: BigInt(record.pathId),
            typeId: record.typeId,
            classId: record.classId,
            byteStart: 0,
            byteSize: raw.length,
          };
          const scans: RawScans = {
            rawTexts: record.rs ?? [],
            dialogues: record.dl ?? [],
            colors: record.cpl ?? null,
          };
          const tree = file.trees.get(record.typeId) ?? null;
          ctx.writer.write({
            asset: ctx.asset.asset,
            ...extractObject(obj, raw, tree, file.endian, scans),
          });
          ctx.classNames.push(unityClassName(record.classId));
          ctx.objects += 1;
          break;
        }
        case "warn":
          ctx.warnings.push(...record.texts);
          break;
        case "runs":
          ctx.runs = record.texts;
          break;
        case "keys":
          ctx.settings = record.keys;
          break;
        case "us": {
          const heap = new Uint8Array(Buffer.from(record.heap, "base64"));
          ctx.dotnetSettings = scanDotnetStrings(heap, [0, heap.length]);
          break;
        }
        default:
          break;
      }
    }
  } finally {
    finalize();
    summaries.close();
  }

  const indexLines = ["# Asset Dump Index (Unity)", "", "| File | Objects |", "|------|---------|"];
  for (const item of [...index].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    indexLines.push(`| [${item.name}](${item.name}.jsonl) | ${item.total} |`);
  }
  writeFileSync(join(outDir, "index.md"), `${indexLines.join("\n")}\n`, "utf8");
  return stats;
}

/**
 * Отбор `global_strings` из печатных строк файла (порт `scanGlobalStrings`
 * без сканирования байтов: строки уже дал декодер, уникальные по тексту).
 *
 * Правила «это UI-текст?» и приоритеты — здесь, в TS: декодер их не знает.
 */
export function selectGlobalStrings(texts: string[]): string[] {
  const candidates: string[] = [];
  for (const raw of texts) {
    const text = pyStrip(raw);
    const length = cpLen(text);
    if (length >= 3 && length <= 120 && isGlobalStringCandidate(text)) candidates.push(text);
  }
  return candidates
    .map((text, index) => ({ text, index, priority: uiPriority(text) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, 500)
    .map((item) => item.text);
}

/** Отчёты `structure` из rd1 (паритет стадий 1–2 без второго прохода по игре). */
export function structureFromRaw(rawPath: string, includeObjects = true): StructureReport[] {
  const reports: StructureReport[] = [];
  let current: StructureReport | null = null;
  const fileStates: Array<{ objects: StructureObject[] }> = [];
  for (const line of readLines(rawPath)) {
    const record = JSON.parse(line) as RawRecord;
    if (record.t === "asset") {
      current = {
        file: record.asset,
        path: record.path,
        kind: record.kind,
        entries: record.entries ?? [],
        files: [],
        ...(record.error !== undefined ? { error: record.error } : {}),
      };
      reports.push(current);
      fileStates.length = 0;
      continue;
    }
    if (!current) continue;
    switch (record.t) {
      case "sf":
        current.files[record.i] = {
          name: record.name,
          unityVersion: record.unityVersion,
          headerVersion: record.headerVersion,
          typeTreeEnabled: record.typeTreeEnabled,
          objectCount: record.objectCount,
          objects: [],
        };
        fileStates[record.i] = { objects: current.files[record.i].objects };
        break;
      case "obj": {
        if (!includeObjects) break;
        const bucket = fileStates[record.sf];
        bucket?.objects.push({
          pathId: record.pathId,
          typeId: record.typeId,
          classId: record.classId,
        });
        break;
      }
      case "warn":
        (current.warnings ??= []).push(...record.texts);
        break;
      default:
        break;
    }
  }
  return reports;
}

/** Куда писать rd1 в режиме `--decoder rust`: отдельно от каталога дампа. */
export function resolveRawPath(outDir: string, explicit: string | null): string {
  return resolve(explicit ?? rawDumpPath(outDir));
}

/** Прогон Rust-декодером: rd1 рядом в tmp, дальше — тот же сборщик, что и выше. */
export function runRustPass(targets: DiscoveredFile[], rawPath: string): void {
  mkdirSync(dirname(rawPath), { recursive: true });
  const rawTargets: RawTarget[] = targets.map((target) => ({
    name: target.name,
    path: target.path,
  }));
  runRustDecoder(REPO_ROOT, rawTargets, rawPath);
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
      "usage: dump_assets.mts <команда> [флаги]",
      "",
      "  structure [--all | --files <путь,...>] [--json] [--no-objects]",
      "      отчёт по контейнеру и таблице объектов (паритет стадий 1–2)",
      "",
      "  dump [--out <каталог>] [--all | --files <путь,...>]",
      "      полный JSONL-дамп (summaries.jsonl + <asset>.jsonl), как Python-эталон",
      "",
      "  --decoder ts|rust  кто разбирает байты: TS (по умолчанию) или Rust-декодер",
      "  --all          все Unity-файлы установленной игры (нужен TCNN_GAME_DIR)",
      "  --files a,b    конкретные файлы (пути или имена из установки)",
      "  --out <dir>    каталог дампа (по умолчанию tmp/dump в корне репозитория)",
      "  --raw <файл>   путь rd1-промежутка (по умолчанию tmp/raw/<dump>.rd1.jsonl)",
      "  --json         structure: машинный отчёт (один JSON на файл)",
      "  --no-objects   structure: без списка объектов (только счётчики)",
    ].join("\n"),
  );
}

/** Корень репозитория: scripts → dump-assets → skills → .opencode → корень. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

function argValue(argv: string[], name: string): string | null {
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
    if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
  }
  return null;
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
  if (command !== "structure" && command !== "dump") {
    usage();
    return 2;
  }
  const decoder = argValue(argv, "--decoder") ?? "ts";
  if (decoder !== "ts" && decoder !== "rust") {
    console.error(`--decoder: ожидалось ts или rust, получено "${decoder}"`);
    return 2;
  }
  const found = findGameDir();
  const game = checkGameDir(found);
  const hasFilesArg = argv.some((a) => a.startsWith("--files"));
  if (!game.ok && !hasFilesArg) {
    console.error("Игра не найдена или неполная. Проверьте TCNN_GAME_DIR:", found ?? "(нет)");
    return 2;
  }
  const targets = resolveFiles(argv, game.dir);
  if (targets.length === 0) return 2;

  if (command === "dump") {
    const outDir = resolve(argValue(argv, "--out") ?? join(REPO_ROOT, "tmp", "dump"));
    const started = Date.now();
    let stats: DumpStats;
    if (decoder === "rust") {
      const rawPath = resolveRawPath(outDir, argValue(argv, "--raw"));
      try {
        runRustPass(targets, rawPath);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 2;
      }
      console.error(`  байтовый уровень: rust → ${rawPath}`);
      stats = dumpAssetsFromRaw(rawPath, outDir);
    } else {
      stats = dumpAssets(targets, outDir);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.error(
      `\nГотово: ${stats.assets} ассетов, ${stats.objects} объектов → ${outDir} (${seconds} с)`,
    );
    return stats.failed === 0 ? 0 : 1;
  }

  const json = argv.includes("--json");
  const includeObjects = !argv.includes("--no-objects");

  let reports: StructureReport[];
  if (decoder === "rust") {
    const rawPath = resolveRawPath(join(REPO_ROOT, "tmp", "dump"), argValue(argv, "--raw"));
    try {
      runRustPass(targets, rawPath);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
    reports = structureFromRaw(rawPath, includeObjects);
  } else {
    reports = [];
    for (const target of targets) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(target.path));
      } catch (err) {
        console.error(`${target.name}: не читается: ${err instanceof Error ? err.message : err}`);
        reports.push({
          file: target.name,
          path: target.path,
          kind: "unknown",
          entries: [],
          files: [],
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      reports.push(describeAssetFile(target.name, target.path, bytes, includeObjects));
    }
  }

  let failed = 0;
  for (const report of reports) {
    if (report.kind === "unknown") failed += 1;
    if (json) console.log(JSON.stringify(report));
    else console.log(humanReport(report));
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
