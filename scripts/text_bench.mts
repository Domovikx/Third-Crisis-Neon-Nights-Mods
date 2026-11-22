/**
 * text_bench.mts — замер текстового пайплайна «TS-эталон против Rust».
 *
 * Точки: `potgen` и `po2dat`, объёмы 1× (реальные файлы) и 10× (синтетика в
 * `tmp/text-bench/`, уникальные ключи). Порог миграции — `AGENTS.md` («Языки»),
 * методика — `docs/rust-vs-ts.md`, запись — `docs/language-audit.md`.
 *
 * Замер: каждый инструмент — ОТДЕЛЬНЫМ процессом (иначе старт Node смешается с
 * работой), wall time вокруг `spawnSync`, два прогона на точку. МБ/с — входные
 * байты на время процесса (1 МБ = 2^20), второй прогон (прогретый кэш).
 *
 * Гейт: выходы TS и Rust на каждой точке сравниваются ПОБАЙТОВО (POT пишется с
 * фиксированной датой `--created`).
 *
 * CLI:
 *   node scripts/text_bench.mts [--scales 1,10] [--runs 2] [--regen]
 *        [--dump <dir>]
 *   node scripts/text_bench.mts --worker potgen --dump <dir> --out <pot>
 *   node scripts/text_bench.mts --worker po2dat --root <dir> --lang ru --out <dat>
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  parsePo,
  renderPo,
  type PoEntry,
} from "../.opencode/skills/extract-text/scripts/po_file.mts";
import { buildDat, writeDat } from "../.opencode/skills/extract-text/scripts/po2dat.mts";
import { runPotgen } from "../.opencode/skills/extract-text/scripts/potgen.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "..");
const BENCH_ROOT = join(REPO_ROOT, "tmp", "text-bench");
const CREATED = "2026-01-02 03:04+0000";
const RUST_BIN = join(
  REPO_ROOT,
  "tools",
  "rust-l10n",
  "target",
  "release",
  process.platform === "win32" ? "rust-l10n.exe" : "rust-l10n",
);

interface Measurement {
  point: string;
  scale: number;
  inputBytes: number;
  tsMs: number[];
  rustMs: number[];
  parity: boolean;
}

function argValue(argv: string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
    if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worker: одна операция TS-эталона в отдельном процессе (для честного замера).
// ---------------------------------------------------------------------------

async function worker(argv: string[]): Promise<number> {
  const mode = argValue(argv, "--worker");
  const out = argValue(argv, "--out");
  if (!out) throw new Error("--worker требует --out");
  if (mode === "potgen") {
    const dump = argValue(argv, "--dump");
    if (!dump) throw new Error("--worker potgen требует --dump");
    await runPotgen({ dumpDir: dump, outPath: out, created: CREATED });
    return 0;
  }
  if (mode === "po2dat") {
    const root = argValue(argv, "--root") ?? REPO_ROOT;
    const lang = argValue(argv, "--lang") ?? "ru";
    const { rows } = buildDat(lang, root);
    writeDat(rows, out);
    return 0;
  }
  throw new Error(`неизвестный worker: ${mode ?? "(пусто)"}`);
}

// ---------------------------------------------------------------------------
// Синтетика 10×: уникальные ключи, чтобы каталог и выход росли вместе с входом.
// ---------------------------------------------------------------------------

/** Текстовые поля строки дампа, в которые дописывается `~k`. */
function transformRow(row: Record<string, unknown>, suffix: string): void {
  const dialogues = row.dialogues;
  if (Array.isArray(dialogues)) {
    for (const d of dialogues) {
      if (!d || typeof d !== "object") continue;
      const entry = d as Record<string, unknown>;
      if (typeof entry.text === "string") entry.text += suffix;
      if (typeof entry.rich_text === "string" && entry.rich_text) entry.rich_text += suffix;
    }
  }
  for (const field of ["raw_strings", "fsm_strings"]) {
    const list = row[field];
    if (!Array.isArray(list)) continue;
    row[field] = list.map((s) => (typeof s === "string" ? s + suffix : s));
  }
  const settings = row.settings_keys;
  if (Array.isArray(settings)) {
    for (const sk of settings) {
      if (!sk || typeof sk !== "object") continue;
      const item = sk as Record<string, unknown>;
      if (typeof item.display === "string") item.display += suffix;
    }
  }
}

function transformLine(line: string, suffix: string): string | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  transformRow(row as Record<string, unknown>, suffix);
  return JSON.stringify(row);
}

/** 10 копий дампа: `<stem>~<k>.jsonl`; `summaries.jsonl` — один файл с 10× строк. */
function ensureDump10x(source: string): string {
  const dir = join(BENCH_ROOT, "potgen-10x");
  const marker = join(dir, ".ready");
  if (existsSync(marker)) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.error(`[bench] генерирую синтетику 10× дампа: ${dir}`);
  for (const name of readdirSync(source)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()) {
    const text = readFileSync(join(source, name), "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (name === "summaries.jsonl") {
      const appended: string[] = [];
      for (let k = 1; k <= 10; k++) {
        for (const line of lines) {
          const out = transformLine(line, `~${k}`);
          if (out) appended.push(out);
        }
      }
      writeFileSync(join(dir, name), appended.join("\n") + "\n", "utf8");
      continue;
    }
    const stem = name.slice(0, -".jsonl".length);
    for (let k = 1; k <= 10; k++) {
      const out: string[] = [];
      for (const line of lines) {
        const transformed = transformLine(line, `~${k}`);
        if (transformed) out.push(transformed);
      }
      writeFileSync(join(dir, `${stem}~${k}.jsonl`), out.join("\n") + "\n", "utf8");
    }
  }
  writeFileSync(marker, "10x\n", "utf8");
  return dir;
}

/** 10× POT + ru.po: суффикс `~k` в msgid/msgctxt, rich-комментарии сохраняются. */
function ensurePo2dat10x(): string {
  const root = join(BENCH_ROOT, "po2dat-10x");
  const marker = join(root, ".ready");
  if (existsSync(marker)) return root;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "po"), { recursive: true });
  console.error(`[bench] генерирую синтетику 10× PO: ${root}`);

  const scaled = (source: string): PoEntry[] => {
    const entries = parsePo(readFileSync(source, "utf8")).filter((e) => e.msgid);
    const out: PoEntry[] = [];
    for (let k = 1; k <= 10; k++) {
      const suffix = `~${k}`;
      for (const e of entries) {
        out.push({
          ...e,
          msgid: `${e.msgid}${suffix}`,
          msgctxt: e.msgctxt ? `${e.msgctxt}${suffix}` : "",
          comments: e.comments.map((c) => (c.startsWith("rich_text:") ? `${c}${suffix}` : c)),
        });
      }
    }
    return out;
  };

  writeFileSync(
    join(root, "po", "template.pot"),
    renderPo(scaled(join(REPO_ROOT, "po", "template.pot")), []),
    "utf8",
  );
  writeFileSync(
    join(root, "po", "ru.po"),
    renderPo(scaled(join(REPO_ROOT, "po", "ru.po")), []),
    "utf8",
  );
  writeFileSync(marker, "10x\n", "utf8");
  return root;
}

// ---------------------------------------------------------------------------
// Замер
// ---------------------------------------------------------------------------

function inputBytes(paths: string[]): number {
  return paths.reduce((sum, p) => sum + statSync(p).size, 0);
}

function dumpBytes(dir: string): number {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
}

function runOnce(cmd: string, args: string[]): number {
  const started = performance.now();
  const run = spawnSync(cmd, args, { stdio: "ignore" });
  const ms = performance.now() - started;
  if (run.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} упал (код ${run.status ?? "?"})`);
  }
  return ms;
}

function sameBytes(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

function measurePoint(
  point: string,
  scale: number,
  bytes: number,
  runs: number,
  ts: () => void,
  rust: () => void,
  parityOut: [string, string],
): Measurement {
  const tsMs: number[] = [];
  const rustMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    tsMs.push(timeIt(ts));
    rustMs.push(timeIt(rust));
  }
  return {
    point,
    scale,
    inputBytes: bytes,
    tsMs,
    rustMs,
    parity: sameBytes(parityOut[0], parityOut[1]),
  };
}

function timeIt(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

function mbps(bytes: number, ms: number): number {
  return bytes / (1024 * 1024) / (ms / 1000);
}

function table(rows: Measurement[]): string {
  const head =
    "| Точка | Вход, МБ | TS, мс (1/2) | Rust, мс (1/2) | × (1/2) | TS, МБ/с | Rust, МБ/с | Паритет |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map((r) => {
    const ratio = r.tsMs.map((ms, i) => ms / r.rustMs[i]);
    const fmt = (values: number[]): string => values.map((v) => v.toFixed(0)).join(" / ");
    const ratioText = ratio.map((v) => v.toFixed(2)).join(" / ");
    return (
      `| ${r.point} | ${(r.inputBytes / (1024 * 1024)).toFixed(1)} | ${fmt(r.tsMs)} | ` +
      `${fmt(r.rustMs)} | ${ratioText} | ${mbps(r.inputBytes, r.tsMs.at(-1) ?? 1).toFixed(1)} | ` +
      `${mbps(r.inputBytes, r.rustMs.at(-1) ?? 1).toFixed(1)} | ${r.parity ? "✓" : "РАСХОЖДЕНИЕ"} |`
    );
  });
  return [head, sep, ...body].join("\n");
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--worker")) {
    return worker(argv);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("node scripts/text_bench.mts [--scales 1,10] [--runs 2] [--regen] [--dump <dir>]");
    return 0;
  }
  if (!existsSync(RUST_BIN)) {
    console.error(`Нет бинаря ${RUST_BIN}. Соберите: npm run l10n:build`);
    return 2;
  }
  const scales = (argValue(argv, "--scales") ?? "1,10")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const runs = Number(argValue(argv, "--runs") ?? 2);
  const sourceDump = argValue(argv, "--dump") ?? join(REPO_ROOT, "tmp", "dump-new");
  if (argv.includes("--regen")) {
    rmSync(BENCH_ROOT, { recursive: true, force: true });
  }
  mkdirSync(join(BENCH_ROOT, "out"), { recursive: true });

  const self = join(REPO_ROOT, "scripts", "text_bench.mts");
  const tsPotgen = (dump: string, out: string): void => {
    runOnce(process.execPath, [self, "--worker", "potgen", "--dump", dump, "--out", out]);
  };
  const rustPotgen = (dump: string, out: string): void => {
    runOnce(RUST_BIN, [
      "potgen",
      "--root",
      REPO_ROOT,
      "--dump",
      dump,
      "--out",
      out,
      "--created",
      CREATED,
    ]);
  };
  const tsPo2dat = (root: string, out: string): void => {
    runOnce(process.execPath, [
      self,
      "--worker",
      "po2dat",
      "--root",
      root,
      "--lang",
      "ru",
      "--out",
      out,
    ]);
  };
  const rustPo2dat = (root: string, out: string): void => {
    runOnce(RUST_BIN, ["po2dat", "ru", "--root", root, "--out", out]);
  };

  const rows: Measurement[] = [];
  for (const scale of scales) {
    if (scale === 1) {
      if (!existsSync(sourceDump)) {
        console.error(`[bench] нет дампа ${sourceDump} — точка potgen 1× пропущена`);
      } else {
        const tsOut = join(BENCH_ROOT, "out", "potgen-1x-ts.pot");
        const rustOut = join(BENCH_ROOT, "out", "potgen-1x-rust.pot");
        rows.push(
          measurePoint(
            "potgen 1×",
            1,
            dumpBytes(sourceDump),
            runs,
            () => tsPotgen(sourceDump, tsOut),
            () => rustPotgen(sourceDump, rustOut),
            [tsOut, rustOut],
          ),
        );
      }
      const tsOut = join(BENCH_ROOT, "out", "po2dat-1x-ts.dat");
      const rustOut = join(BENCH_ROOT, "out", "po2dat-1x-rust.dat");
      rows.push(
        measurePoint(
          "po2dat 1× (ru)",
          1,
          inputBytes([join(REPO_ROOT, "po", "template.pot"), join(REPO_ROOT, "po", "ru.po")]),
          runs,
          () => tsPo2dat(REPO_ROOT, tsOut),
          () => rustPo2dat(REPO_ROOT, rustOut),
          [tsOut, rustOut],
        ),
      );
      continue;
    }

    const dump10 = ensureDump10x(sourceDump);
    const tsOut = join(BENCH_ROOT, "out", "potgen-10x-ts.pot");
    const rustOut = join(BENCH_ROOT, "out", "potgen-10x-rust.pot");
    rows.push(
      measurePoint(
        `potgen ${scale}×`,
        scale,
        dumpBytes(dump10),
        runs,
        () => tsPotgen(dump10, tsOut),
        () => rustPotgen(dump10, rustOut),
        [tsOut, rustOut],
      ),
    );

    const root10 = ensurePo2dat10x();
    const tsDat = join(BENCH_ROOT, "out", "po2dat-10x-ts.dat");
    const rustDat = join(BENCH_ROOT, "out", "po2dat-10x-rust.dat");
    rows.push(
      measurePoint(
        `po2dat ${scale}× (ru)`,
        scale,
        inputBytes([join(root10, "po", "template.pot"), join(root10, "po", "ru.po")]),
        runs,
        () => tsPo2dat(root10, tsDat),
        () => rustPo2dat(root10, rustDat),
        [tsDat, rustDat],
      ),
    );
  }

  const report = table(rows);
  console.log(report);
  const allParity = rows.every((r) => r.parity);
  const results = {
    date: new Date().toISOString(),
    machine: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model ?? "",
      totalMemGb: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
    },
    runs,
    rows,
    parity: allParity,
  };
  writeFileSync(join(BENCH_ROOT, "results.json"), JSON.stringify(results, null, 2), "utf8");
  console.log(`\nРезультаты: ${join(BENCH_ROOT, "results.json")}`);
  return allParity ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
