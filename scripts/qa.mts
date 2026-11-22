/**
 * qa.mts — офлайн-QA перевода: **вычисления на Rust, отчёт на TS**.
 *
 * Решение 2026-11-22 (`docs/qa-scaling.md`): ядро проверок перенесено на Rust (2.6–3.7× быстрее
 * и без упора в heap на больших корпусах), а HTML-рендер остался в TS — разметка/CSS/фильтр
 * живут в одном месте и не дублируются.
 *
 * Контракт: `rust-qa` пишет JSON `{lang, summary, findings}`, где `findings` байт-совместимы
 * с TS-эталоном. Здесь JSON превращается в `Summary` + `Finding[]` и рендерится тем же
 * `renderHtml`, что и раньше.
 *
 * CLI: node scripts/qa.mts [--lang ru] [--out tmp/qa.html]
 *   Без собранного `rust-qa` — понятная ошибка и подсказка (код 2).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { REPO_ROOT } from "./languages.mts";
import {
  renderHtml,
  type Finding,
  type Stat,
  type Summary,
} from "../.opencode/skills/translate-qa/scripts/qa_translate.mts";

/** Путь к собранному бинарю (Windows — .exe). */
export function rustQaBinary(root: string = REPO_ROOT): string | null {
  const candidates = [
    join(root, "tools", "rust-qa", "target", "release", "rust-qa.exe"),
    join(root, "tools", "rust-qa", "target", "release", "rust-qa"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

interface RustReport {
  lang: string;
  summary: {
    total: number;
    filled: number;
    coverage: number;
    errors: number;
    warnings: number;
    by_speaker: Array<[string, Stat]>;
    by_dir: Array<[string, Stat]>;
  };
  findings: Finding[];
}

/** JSON от `rust-qa` → типы TS-эталона (карты вместо массивов пар). */
export function toSummary(report: RustReport): Summary {
  return {
    total: report.summary.total,
    filled: report.summary.filled,
    coverage: report.summary.coverage,
    errors: report.summary.errors,
    warnings: report.summary.warnings,
    bySpeaker: new Map(report.summary.by_speaker ?? []),
    byDir: new Map(report.summary.by_dir ?? []),
  };
}

function parseArgs(argv: string[]): { lang: string; out: string; help: boolean } {
  const out = { lang: "ru", out: join(REPO_ROOT, "tmp", "qa.html"), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lang") out.lang = argv[++i] ?? "ru";
    else if (a === "--out") out.out = resolve(argv[++i] ?? "tmp/qa.html");
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`неизвестная опция: ${a}`);
  }
  return out;
}

function main(argv: string[]): number {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  if (args.help) {
    console.log("node scripts/qa.mts [--lang <код>] [--out <html>]");
    return 0;
  }

  const bin = rustQaBinary();
  if (!bin) {
    console.error("rust-qa не собран. Соберите: npm run qa:build");
    console.error("(эталонная реализация без Rust: npm run qa:ts)");
    return 2;
  }

  mkdirSync(dirname(args.out), { recursive: true });
  const jsonPath = join(REPO_ROOT, "tmp", `qa-${args.lang}.json`);
  const run = spawnSync(
    bin,
    ["--root", REPO_ROOT, "--lang", args.lang, "--json", jsonPath, "--quiet"],
    {
      stdio: "inherit",
    },
  );
  if (run.status !== 0 && run.status !== 1) {
    console.error(`rust-qa завершился с ошибкой (код ${run.status ?? "?"})`);
    return 1;
  }
  if (!existsSync(jsonPath)) {
    console.error("rust-qa не создал JSON-отчёт");
    return 1;
  }

  const report = JSON.parse(readFileSync(jsonPath, "utf8")) as RustReport;
  const summary = toSummary(report);
  const html = renderHtml(summary, report.findings);
  writeFileSync(args.out, html, "utf8");

  const pct = summary.coverage.toFixed(1);
  const line =
    `QA[${args.lang}]: ${summary.filled}/${summary.total} (${pct}%), ` +
    `errors=${summary.errors}, warnings=${summary.warnings} -> ${args.out}`;
  console.log(line);
  return summary.errors > 0 ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
