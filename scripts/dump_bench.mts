/**
 * dump_bench.mts — честный бенчмарк байтового уровня: TS против Rust.
 *
 * Что сравнивается (один и тот же набор файлов игры):
 *
 *   ts        — полный TS-дампер (dumpAssets): байты + семантика + JSONL
 *   rust      — Rust-декодер (байты → rd1) + тот же TS-сборщик дампа
 *   ts-core   — только байтовый уровень на TS (пишет тот же rd1)
 *   rust-core — только Rust-декодер (пишет тот же rd1)
 *
 * `ts` ≈ `ts-core` + `assemble`, поэтому фазы TS-пути видны из `ts-core`
 * (read/decode/scan/runs) и `assemble` (сборка итогового JSONL из rd1).
 *
 * Замеры на вариант:
 *   - wall time всего процесса варианта;
 *   - пиковая память: собственный maxRSS процесса Node (process.resourceUsage)
 *     плюс — для вариантов с Rust — пик дочернего процесса из его отчёта
 *     (`--report`: PeakWorkingSetSize); в таблицу идёт максимум;
 *   - размер выхода (каталог дампа или rd1).
 *
 * Два прогона каждого варианта: первый — «холодный» (файловый кэш частично),
 * второй — прогретый; в отчёте приводятся оба, сравнение — по медиане.
 *
 * Каждый вариант запускается ДОЧЕРНИМ процессом: иначе maxRSS суммарный по
 * всем вариантам и цифры бесполезны.
 *
 * CLI:
 *   node scripts/dump_bench.mts [--runs 2] [--out tmp/bench.json] [--files a,b]
 *   node scripts/dump_bench.mts --worker --variant ts-core --out tmp/bench
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { checkGameDir, findGameDir } from "./game_dir.mts";
import {
  discoverGameFiles,
  dumpAssets,
  dumpAssetsFromRaw,
  type DiscoveredFile,
  type DumpStats,
} from "../.opencode/skills/dump-assets/scripts/dump_assets.mts";
import {
  runRustDecoder,
  writeRawDumpTs,
  type RawTimings,
} from "../.opencode/skills/dump-assets/scripts/rawdump.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "..");

type Variant = "ts" | "rust" | "ts-core" | "rust-core";

const VARIANTS: Variant[] = ["ts", "rust", "ts-core", "rust-core"];

interface VariantResult {
  variant: Variant;
  wallMs: number;
  /** Пик памяти процесса Node (RSS, байты). */
  nodePeakRss: number;
  /** Пик памяти дочернего Rust-процесса (если он был). */
  rustPeakRss: number | null;
  outBytes: number;
  objects: number;
  assets: number;
  /**
   * Фазы bytes-уровня. `null` — у варианта `ts` (там байты и семантика
   * внутри одного `dumpAssets`, раздельно не меряются; его разложение дают
   * `ts-core` + `assemble` из варианта `rust`).
   */
  phases: {
    readMs: number;
    decodeMs: number;
    scanMs: number;
    runsMs: number;
    /** Сериализация rd1 — остаток внутри байтового ядра. */
    serializeMs: number;
    /** Сборка итогового дампа из rd1 (TS-семантика). */
    assembleMs: number;
  } | null;
}

function argValue(argv: string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
    if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
  }
  return null;
}

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // файл мог исчезнуть — не наша забота в замере
    }
  }
  return total;
}

function resolveTargets(filesArg: string | null): DiscoveredFile[] {
  const game = checkGameDir(findGameDir());
  if (!game.ok) {
    throw new Error("игра не найдена: задайте TCNN_GAME_DIR (см. scripts/game_dir.mts)");
  }
  const discovered = discoverGameFiles(game.dir as string);
  if (!filesArg) return discovered;
  const names = filesArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return discovered.filter((item) => names.includes(item.name));
}

/** Один вариант в СВОЁМ процессе: иначе maxRSS суммируется по всем замерам. */
function runWorker(argv: string[]): number {
  const variant = argValue(argv, "--variant") as Variant | null;
  const outRoot = resolve(argValue(argv, "--out") ?? join(REPO_ROOT, "tmp", "bench"));
  if (!variant || !VARIANTS.includes(variant)) {
    console.error(`--variant: ожидалось одно из ${VARIANTS.join(", ")}`);
    return 2;
  }
  const targets = resolveTargets(argValue(argv, "--files"));
  mkdirSync(outRoot, { recursive: true });

  const timings: RawTimings = { readMs: 0, decodeMs: 0, scanMs: 0, runsMs: 0 };
  const started = performance.now();
  let outBytes = 0;
  let objects = 0;
  let assets = 0;
  let rustPeakRss: number | null = null;
  let assembleMs = 0;
  let rustReport: RustReport | null = null;
  let splitPhases = true;

  if (variant === "ts") {
    const dumpDir = join(outRoot, "dump-ts");
    rmSync(dumpDir, { recursive: true, force: true });
    const stats: DumpStats = dumpAssets(targets, dumpDir);
    outBytes = dirBytes(dumpDir);
    objects = stats.objects;
    assets = stats.assets;
    splitPhases = false;
  } else if (variant === "rust") {
    const dumpDir = join(outRoot, "dump-rust");
    const rawPath = join(outRoot, "raw-rust.rd1.jsonl");
    const reportPath = join(outRoot, "raw-rust.report.json");
    rmSync(dumpDir, { recursive: true, force: true });
    const rustStats = runRustDecoder(REPO_ROOT, targets, rawPath, reportPath);
    rustReport = readRustReport(reportPath);
    rustPeakRss = rustReport?.peakRss ?? null;
    // Фазы байтового уровня — из отчёта Rust-процесса (как у rust-core).
    timings.readMs = rustReport?.readMs ?? 0;
    timings.decodeMs = rustReport?.decodeMs ?? 0;
    timings.scanMs = rustReport?.scanMs ?? 0;
    timings.runsMs = rustReport?.runsMs ?? 0;
    const assembleStarted = performance.now();
    const stats = dumpAssetsFromRaw(rawPath, dumpDir);
    assembleMs = performance.now() - assembleStarted;
    outBytes = dirBytes(dumpDir);
    objects = stats.objects;
    assets = stats.assets;
    if (rustStats.objects > 0 && rustStats.objects !== stats.objects) {
      console.error(`  WARN: Rust насчитал ${rustStats.objects}, дамп собрал ${stats.objects}`);
    }
  } else if (variant === "ts-core") {
    const rawPath = join(outRoot, "raw-ts.rd1.jsonl");
    const stats = writeRawDumpTs(targets, rawPath, timings);
    outBytes = statSync(rawPath).size;
    objects = stats.objects;
    assets = stats.files;
  } else {
    const rawPath = join(outRoot, "raw-rust-core.rd1.jsonl");
    const reportPath = join(outRoot, "raw-rust-core.report.json");
    const stats = runRustDecoder(REPO_ROOT, targets, rawPath, reportPath);
    const report = readRustReport(reportPath);
    rustPeakRss = report?.peakRss ?? null;
    outBytes = statSync(rawPath).size;
    objects = stats.objects;
    assets = stats.files;
    timings.readMs = report?.readMs ?? 0;
    timings.decodeMs = report?.decodeMs ?? 0;
    timings.scanMs = report?.scanMs ?? 0;
    timings.runsMs = report?.runsMs ?? 0;
    rustReport = report;
  }

  const wallMs = performance.now() - started;
  const measured = timings.readMs + timings.decodeMs + timings.scanMs + timings.runsMs;
  const coreMs = variant === "rust" ? (rustReport?.totalMs ?? 0) : wallMs - assembleMs;
  const result: VariantResult = {
    variant,
    wallMs,
    nodePeakRss: process.resourceUsage().maxRSS * 1024,
    rustPeakRss,
    outBytes,
    objects,
    assets,
    phases: splitPhases
      ? {
          readMs: timings.readMs,
          decodeMs: timings.decodeMs,
          scanMs: timings.scanMs,
          runsMs: timings.runsMs,
          serializeMs:
            variant === "rust" ? (rustReport?.writeMs ?? 0) : Math.max(0, coreMs - measured),
          assembleMs,
        }
      : null,
  };
  console.log(`BENCH ${JSON.stringify(result)}`);
  return 0;
}

interface RustReport {
  peakRss: number | null;
  readMs: number;
  decodeMs: number;
  scanMs: number;
  runsMs: number;
  writeMs: number;
  totalMs: number;
  objects: number;
}

function readRustReport(path: string): RustReport | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      peakRss: typeof raw.peak_rss === "number" ? raw.peak_rss : null,
      readMs: Number(raw.read_ms ?? 0),
      decodeMs: Number(raw.decode_ms ?? 0),
      scanMs: Number(raw.scan_ms ?? 0),
      runsMs: Number(raw.runs_ms ?? 0),
      writeMs: Number(raw.write_ms ?? 0),
      totalMs: Number(raw.total_ms ?? 0),
      objects: Number(raw.objects ?? 0),
    };
  } catch {
    return null;
  }
}

/** Сравнение двух каталогов дампа побайтово (паритет ts ↔ rust). */
function compareDumps(left: string, right: string): { same: boolean; detail: string } {
  if (!existsSync(left) || !existsSync(right)) {
    return { same: false, detail: "каталог дампа отсутствует" };
  }
  const names = readdirSync(left).sort();
  const other = readdirSync(right).sort();
  if (names.join("\n") !== other.join("\n")) {
    return { same: false, detail: `разный состав файлов: ${names.length} vs ${other.length}` };
  }
  for (const name of names) {
    const a = readFileSync(join(left, name));
    const b = readFileSync(join(right, name));
    if (!a.equals(b)) {
      return { same: false, detail: `разошёлся файл ${name}` };
    }
  }
  return { same: true, detail: `${names.length} файлов побайтово равны` };
}

function compareRawFiles(left: string, right: string): { same: boolean; detail: string } {
  for (const path of [left, right]) {
    if (!existsSync(path)) return { same: false, detail: `нет файла ${path}` };
  }
  const a = statSync(left).size;
  const b = statSync(right).size;
  if (a !== b) return { same: false, detail: `разный размер: ${a} vs ${b}` };
  const leftBytes = readFileSync(left);
  const rightBytes = readFileSync(right);
  if (!leftBytes.equals(rightBytes)) {
    // Ищем первую различающуюся строку — иначе «не совпало» бесполезно.
    const leftLines = leftBytes.toString("utf8").split("\n");
    const rightLines = rightBytes.toString("utf8").split("\n");
    for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
      if (leftLines[i] !== rightLines[i]) {
        return {
          same: false,
          detail: `строка ${i + 1}: TS=${String(leftLines[i]).slice(0, 120)} RUST=${String(rightLines[i]).slice(0, 120)}`,
        };
      }
    }
    return { same: false, detail: "содержимое различается" };
  }
  return { same: true, detail: `${a} байт побайтово равны` };
}

function main(argv: string[]): number {
  if (argv.includes("--worker")) return runWorker(argv);

  const runs = Number(argValue(argv, "--runs") ?? 2);
  const outPath = resolve(argValue(argv, "--out") ?? join(REPO_ROOT, "tmp", "bench.json"));
  const outRoot = join(REPO_ROOT, "tmp", "bench");
  const filesArg = argValue(argv, "--files");
  const variants = (argValue(argv, "--variants") ?? VARIANTS.join(","))
    .split(",")
    .map((s) => s.trim()) as Variant[];

  // Прошлые артефакты не должны попасть в сверку «как будто свежие».
  for (const name of ["raw-ts.rd1.jsonl", "raw-rust-core.rd1.jsonl", "dump-ts", "dump-rust"]) {
    rmSync(join(outRoot, name), { recursive: true, force: true });
  }

  const results: VariantResult[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const variant of variants) {
      const args = [
        import.meta.filename,
        "--worker",
        "--variant",
        variant,
        "--out",
        outRoot,
        ...(filesArg ? ["--files", filesArg] : []),
      ];
      const child = spawnSync(process.execPath, args, { encoding: "utf8" });
      if (child.status !== 0) {
        console.error(`вариант ${variant} (прогон ${run}) упал:`, child.stderr ?? child.stdout);
        return 2;
      }
      if (child.stderr) process.stderr.write(child.stderr);
      const line = (child.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("BENCH "));
      if (!line) {
        console.error(`вариант ${variant}: нет строки BENCH в выводе`);
        return 2;
      }
      const result = JSON.parse(line.slice("BENCH ".length)) as VariantResult;
      results.push({ ...result, run } as VariantResult & { run: number });
      const peak = Math.max(result.nodePeakRss, result.rustPeakRss ?? 0);
      console.log(
        `run ${run} ${variant.padEnd(9)} ${(result.wallMs / 1000).toFixed(1).padStart(6)} с  ` +
          `peak ${(peak / 1024 / 1024).toFixed(0).padStart(5)} МБ  out ${(result.outBytes / 1024 / 1024).toFixed(1)} МБ`,
      );
    }
  }

  const tsDump = join(outRoot, "dump-ts");
  const rustDump = join(outRoot, "dump-rust");
  const rawTs = join(outRoot, "raw-ts.rd1.jsonl");
  const rawRust = join(outRoot, "raw-rust-core.rd1.jsonl");
  const rawParity =
    variants.includes("ts-core") && variants.includes("rust-core")
      ? compareRawFiles(rawTs, rawRust)
      : null;
  const dumpsParity =
    variants.includes("ts") &&
    variants.includes("rust") &&
    existsSync(tsDump) &&
    existsSync(rustDump)
      ? compareDumps(tsDump, rustDump)
      : null;
  const parity = { dumps: dumpsParity, raw: rawParity };
  if (rawParity) {
    console.log(`паритет rd1:      ${rawParity.same ? "OK" : "РАСХОЖДЕНИЕ"} — ${rawParity.detail}`);
  }
  if (dumpsParity) {
    console.log(
      `паритет дампа:    ${dumpsParity.same ? "OK" : "РАСХОЖДЕНИЕ"} — ${dumpsParity.detail}`,
    );
  } else {
    console.log("паритет дампа:    не проверялся (нужны варианты ts и rust)");
  }

  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        generated: new Date().toISOString(),
        files: resolveTargets(filesArg).length,
        runs,
        variants,
        results,
        parity,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\nрезультат: ${outPath}`);
  const dumpsFailed = dumpsParity !== null && !dumpsParity.same;
  const rawFailed = rawParity !== null && !rawParity.same;
  return dumpsFailed || rawFailed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
