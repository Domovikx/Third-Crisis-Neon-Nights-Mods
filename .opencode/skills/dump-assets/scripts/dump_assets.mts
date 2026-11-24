/**
 * dump_assets.mts — CLI дампа Unity-ассетов Third Crisis: Neon Nights.
 *
 * Рабочая реализация — Rust (TS-декодер и TS-сборка удалены 2026-11-24):
 *   1. `tools/rust-decoder` читает байты игры → промежуточный `rd1`-JSONL;
 *   2. `rust-l10n dump_assemble` собирает из rd1 дамп
 *      (`summaries.jsonl` + `<asset>.jsonl` + `index.md`).
 *
 * Этот файл — только обёртка: найти игру, собрать список файлов, дёрнуть
 * бинари, показать пределы и итоги. Семантика (какие поля попадут в JSONL,
 * фильтры, порядок) живёт в `tools/rust-l10n/src/assemble.rs`; оракул —
 * золотые фикстуры в `test_data/` (`scripts/assemble_parity.test.mts`).
 *
 * CLI:
 *   node .opencode/skills/dump-assets/scripts/dump_assets.mts structure \
 *     [--all | --files <путь,путь,...>] [--json] [--no-objects]
 *   node .opencode/skills/dump-assets/scripts/dump_assets.mts dump \
 *     [--out <каталог>] [--all | --files <путь,...>]
 *
 * Путь к игре — только через `scripts/game_dir.mts` (env TCNN_GAME_DIR).
 */

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { checkGameDir, findGameDir, GAME_DATA_FOLDER } from "../../../../scripts/game_dir.mts";
import { l10nBinary } from "../../../../scripts/text_cli.mts";
import {
  formatLimits,
  hasTruncations,
  formatTruncations,
  parseLimit,
  createTruncationReport,
  type TruncationReport,
} from "./truncation.mts";
import { runRustDecoder, type RawTarget } from "./rawdump.mts";

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
  /** Отображаемое имя (как у дампа: level0, bundle_*, resource_*). */
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
 * остальное — как в прежнем эталоне (display-имена совпадают с тем, что
 * ожидает сборщик и POT-конвейер).
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
  // Обоим globalgamemanagers* исторически даётся одно display-имя, второй
  // файл пропускается (dedupe по display) — иначе в дампе было бы два.
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

/**
 * Ограничения дампа — все «крутилки» в одном месте.
 *
 * Смысл: дамп — ИСТОЧНИК данных, поэтому по умолчанию он ничего не режет
 * (`null` = без лимита). Лимит нужен только там, где данные заведомо мусорные
 * и не имеют потребителей (`global_strings`). Каждая обрезка обязана попасть
 * в `truncation` и быть напечатанной в конце прогона — тихая обрезка была
 * дефектом (аудит покрытия POT 2026-11-22: 100 raw_strings/объект и top-500
 * #US-кучи теряли видимый игроку текст).
 */
export interface DumpOptions {
  /** Лимит `raw_strings` на объект; `null` — без лимита (по умолчанию). */
  rawStringLimit: number | null;
  /** Лимит кандидатов `global_strings` на ассет. */
  globalStringLimit: number | null;
  /** Лимит UI-строк из кучи `#US` на сборку; `null` — без лимита. */
  dotnetUiLimit: number | null;
  /** Счётчик обрезок: наполняется по ходу прогона. */
  truncation: TruncationReport;
}

/** Дефолтный лимит `global_strings` на ассет (тот же, что у сборщика). */
export const GLOBAL_STRING_LIMIT = 500;

/** Пределы по умолчанию: ничего не режем, кроме `global_strings`. */
export function defaultDumpOptions(): DumpOptions {
  const truncation = createTruncationReport();
  truncation.globalStrings.limit = GLOBAL_STRING_LIMIT;
  return {
    rawStringLimit: null,
    globalStringLimit: GLOBAL_STRING_LIMIT,
    dotnetUiLimit: null,
    truncation,
  };
}

export interface DumpStats {
  assets: number;
  objects: number;
  /** Файлы, которые не удалось прочитать (бандл/ассет битый). */
  failed: number;
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

/** Записи rd1, нужные `structure` (остальные типы — данные сборки дампа). */
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
}

interface RawObjectRecord {
  t: "obj";
  sf: number;
  pathId: string;
  typeId: number;
  classId: number;
}

interface RawWarnRecord {
  t: "warn";
  texts: string[];
}

type RawRecord = RawAssetRecord | RawSfRecord | RawObjectRecord | RawWarnRecord | { t: string };

/** Пути к промежуточному rd1. */
export function rawDumpPath(outDir: string): string {
  return join(REPO_ROOT, "tmp", "raw", `${basename(outDir)}.rd1.jsonl`);
}

/**
 * Собрать дамп Rust-ассемблером (`rust-l10n dump_assemble`).
 *
 * Контракт: rd1 → `summaries.jsonl` + `<asset>.jsonl` + `index.md`. Поведение
 * сборки живёт в `tools/rust-l10n/src/assemble.rs`, оракул — золотые фикстуры.
 */
export function dumpAssetsRust(
  rawPath: string,
  outDir: string,
  options: DumpOptions = defaultDumpOptions(),
): DumpStats {
  const bin = l10nBinary();
  if (!bin) throw new Error("rust-l10n не собран: npm run l10n:build");
  const args = ["dump_assemble", rawPath, outDir, "--json"];
  if (options.rawStringLimit !== null) {
    args.push("--raw-string-limit", String(options.rawStringLimit));
  }
  if (options.globalStringLimit === null) args.push("--no-global-limit");
  else args.push("--global-string-limit", String(options.globalStringLimit));
  if (options.dotnetUiLimit !== null) {
    args.push("--dotnet-ui-limit", String(options.dotnetUiLimit));
  }
  const run = spawnSyncChecked(bin, args);
  const line = (run.stdout ?? "").trim().split("\n").pop() ?? "{}";
  const stats = JSON.parse(line) as DumpStats;
  return { assets: stats.assets, objects: stats.objects, failed: stats.failed };
}

/** Запуск бинаря с внятной ошибкой (stderr Rust пробрасывается как есть). */
function spawnSyncChecked(bin: string, args: string[]): { stdout: string } {
  const run = spawnSync(bin, args, { encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(run.stderr?.trim() || `dump_assemble: код ${run.status}`);
  }
  return { stdout: run.stdout ?? "" };
}

/** Отчёты `structure` из rd1 (стадии 1–2 без второго прохода по байтам игры). */
export function structureFromRaw(rawPath: string, includeObjects = true): StructureReport[] {
  const reports: StructureReport[] = [];
  let current: StructureReport | null = null;
  const fileStates: Array<{ objects: StructureObject[] }> = [];
  for (const line of readLines(rawPath)) {
    const record = JSON.parse(line) as RawRecord;
    if (record.t === "asset") {
      const asset = record as RawAssetRecord;
      current = {
        file: asset.asset,
        path: asset.path,
        kind: asset.kind,
        entries: asset.entries ?? [],
        files: [],
        ...(asset.error !== undefined ? { error: asset.error } : {}),
      };
      reports.push(current);
      fileStates.length = 0;
      continue;
    }
    if (!current) continue;
    switch (record.t) {
      case "sf": {
        const sf = record as RawSfRecord;
        current.files[sf.i] = {
          name: sf.name,
          unityVersion: sf.unityVersion,
          headerVersion: sf.headerVersion,
          typeTreeEnabled: sf.typeTreeEnabled,
          objectCount: sf.objectCount,
          objects: [],
        };
        fileStates[sf.i] = { objects: current.files[sf.i].objects };
        break;
      }
      case "obj": {
        if (!includeObjects) break;
        const obj = record as RawObjectRecord;
        fileStates[obj.sf]?.objects.push({
          pathId: obj.pathId,
          typeId: obj.typeId,
          classId: obj.classId,
        });
        break;
      }
      case "warn":
        (current.warnings ??= []).push(...(record as RawWarnRecord).texts);
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

/** Прогон Rust-декодером: rd1 рядом в tmp, дальше — сборка. */
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
      "      отчёт по контейнеру и таблице объектов (через rd1 Rust-декодера)",
      "",
      "  dump [--out <каталог>] [--all | --files <путь,...>]",
      "      полный JSONL-дамп (summaries.jsonl + <asset>.jsonl)",
      "",
      "  --all          все Unity-файлы установленной игры (нужен TCNN_GAME_DIR)",
      "  --files a,b    конкретные файлы (пути или имена из установки)",
      "  --out <dir>    каталог дампа (по умолчанию tmp/dump в корне репозитория)",
      "  --raw <файл>   путь rd1-промежутка (по умолчанию tmp/raw/<dump>.rd1.jsonl)",
      "  --raw-string-limit <N|all>  строк raw_strings на объект (по умолчанию all)",
      "  --global-string-limit <N|all>  кандидатов global_strings на ассет (по умолчанию 500)",
      "  --dotnet-ui-limit <N|all>   UI-строк из #US-кучи на сборку (по умолчанию all)",
      "  --json         structure: машинный отчёт (один JSON на файл)",
      "  --no-objects   structure: без списка объектов (только счётчики)",
    ].join("\n"),
  );
}

/**
 * Лимиты из флагов `--*limit`.
 *
 * Возвращает `DumpOptions` с общим отчётом об обрезках; при кривом значении —
 * сообщение об ошибке в stderr и `null` (прогон не начинается).
 */
const BUCKET_OF = {
  rawStringLimit: "rawStrings",
  globalStringLimit: "globalStrings",
  dotnetUiLimit: "dotnetUi",
} as const;

function dumpOptionsFromArgv(argv: string[]): DumpOptions | null {
  const options = defaultDumpOptions();
  const limits: Array<[string, "rawStringLimit" | "globalStringLimit" | "dotnetUiLimit", string]> =
    [
      ["--raw-string-limit", "rawStringLimit", "raw_strings"],
      ["--global-string-limit", "globalStringLimit", "global_strings"],
      ["--dotnet-ui-limit", "dotnetUiLimit", "UI-строки #US"],
    ];
  for (const [flag, key, label] of limits) {
    const value = argValue(argv, flag);
    if (value === null) continue;
    const parsed = parseLimit(value);
    if (parsed === undefined) {
      console.error(`${flag}: ожидалось число или all, получено "${value}" (${label})`);
      return null;
    }
    options[key] = parsed;
    options.truncation[BUCKET_OF[key]].limit = parsed;
  }
  return options;
}

/** Итоговый отчёт об обрезках: всегда в stderr, если резать пришлось. */
function reportTruncations(options: DumpOptions): void {
  if (!hasTruncations(options.truncation)) return;
  console.error("\nВНИМАНИЕ: при извлечении отброшены строки (это не тихо):");
  for (const line of formatTruncations(options.truncation)) console.error(line);
  console.error(
    "  поднять/снять лимит: --raw-string-limit / --global-string-limit / --dotnet-ui-limit",
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
  // Флаги прошлой двухпутевой схемы: принимаем только rust, чтобы старые
  // команды не «молча» переключались на другой исполнитель.
  const decoder = argValue(argv, "--decoder") ?? "rust";
  if (decoder !== "rust") {
    console.error(
      `--decoder: TS-декодер удалён 2026-11-24, единственный путь — rust (дано "${decoder}")`,
    );
    return 2;
  }
  const assembler = argValue(argv, "--assembler") ?? "rust";
  if (assembler !== "rust") {
    console.error(
      `--assembler: TS-сборка удалена 2026-11-24, единственный путь — rust (дано "${assembler}")`,
    );
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
    const options = dumpOptionsFromArgv(argv);
    if (options === null) return 2;
    const started = Date.now();
    console.error(`  пределы: ${formatLimits(options.truncation)}`);
    const rawPath = resolveRawPath(outDir, argValue(argv, "--raw"));
    let stats: DumpStats;
    try {
      runRustPass(targets, rawPath);
      console.error(`  байтовый уровень: rust → ${rawPath}`);
      console.error("  сборка: rust");
      stats = dumpAssetsRust(rawPath, outDir, options);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.error(
      `\nГотово: ${stats.assets} ассетов, ${stats.objects} объектов → ${outDir} (${seconds} с)`,
    );
    reportTruncations(options);
    return stats.failed === 0 ? 0 : 1;
  }

  const json = argv.includes("--json");
  const includeObjects = !argv.includes("--no-objects");

  const rawPath = resolveRawPath(join(REPO_ROOT, "tmp", "dump"), argValue(argv, "--raw"));
  let reports: StructureReport[];
  try {
    runRustPass(targets, rawPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  reports = structureFromRaw(rawPath, includeObjects);

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
