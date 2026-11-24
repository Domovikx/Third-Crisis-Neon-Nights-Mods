/**
 * qa.mts — офлайн-QA перевода: **вычисления на Rust, отчёт на TS**.
 *
 * Решение 2026-11-22 (`docs/qa-scaling.md`): ядро проверок на Rust (2.6–3.7× быстрее
 * и без упора в heap на больших корпусах), HTML-рендер — на TS: разметка/CSS/фильтр
 * живут в одном месте и не дублируются.
 *
 * Решение 2026-11-24: TS-движок правил (`qa_translate.mts`) удалён — единственный
 * движок Rust (`tools/rust-qa`). Оракул — золотой отчёт
 * `.opencode/skills/translate-qa/test_data/qa-golden-<lang>.json`
 * (заморожен с TS-эталона до удаления, гейт — `tests/qa_golden.test.mts`).
 *
 * Контракт: `rust-qa` пишет JSON `{lang, summary, findings}`. Здесь JSON
 * превращается в `Summary` + `Finding[]` и рендерится `renderHtml`.
 *
 * CLI: node scripts/qa.mts [--lang ru] [--out tmp/qa.html]
 *   Без собранного `rust-qa` — понятная ошибка и подсказка (код 2).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { REPO_ROOT } from "./languages.mts";

export type Level = "error" | "warning";

export interface Finding {
  level: Level;
  rule: string;
  /** Файл/источник строки (для отчёта); при отсутствии refs — `po`. */
  rel: string;
  text: string;
  detail: string;
}

export interface Stat {
  filled: number;
  total: number;
}

export interface Summary {
  total: number;
  filled: number;
  coverage: number;
  errors: number;
  warnings: number;
  /** Спикер -> (заполнено, всего), отсортировано по убыванию всего. */
  bySpeaker: Map<string, Stat>;
  /** Папка/тип источника -> (заполнено, всего). */
  byDir: Map<string, Stat>;
}

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

/** JSON от `rust-qa` → `Summary` с картами (контракт рендера). */
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

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** HTML-дашборд: карточки, бары по персонажам, таблица находок с фильтром. */
export function renderHtml(summary: Summary, findings: Finding[]): string {
  const cards =
    `<div class="card"><div class="num">${summary.coverage.toFixed(1)}%</div><div class="lbl">покрытие</div></div>` +
    `<div class="card"><div class="num">${groupThousands(summary.filled)} / ${groupThousands(summary.total)}</div>` +
    `<div class="lbl">заполнено</div></div>` +
    `<div class="card bad"><div class="num">${summary.errors}</div><div class="lbl">errors</div></div>` +
    `<div class="card warn"><div class="num">${summary.warnings}</div><div class="lbl">warnings</div></div>`;

  const bars = [...summary.bySpeaker]
    .slice(0, 20)
    .map(
      ([s, st]) =>
        `<div class="row"><span class="name">${esc(s)}</span>` +
        `<div class="bar" style="width:${((st.filled / Math.max(st.total, 1)) * 100).toFixed(0)}%"></div>` +
        `<span class="cnt">${st.filled}/${st.total}</span></div>`,
    )
    .join("");

  const dirs = [...summary.byDir]
    .map(
      ([d, st]) =>
        `<tr><td>${esc(d)}</td><td>${st.filled}/${st.total}</td>` +
        `<td>${((100 * st.filled) / Math.max(st.total, 1)).toFixed(0)}%</td></tr>`,
    )
    .join("");

  const rows = findings
    .map(
      (f) =>
        `<tr class="${f.level}"><td>${f.level}</td><td>${esc(f.rule)}</td><td>${esc(f.rel)}</td>` +
        `<td>${esc(f.text.slice(0, 100))}</td><td>${esc(f.detail.slice(0, 120))}</td></tr>`,
    )
    .join("");

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<title>translate-qa — дашборд</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;max-width:1200px;margin:0 auto;padding:20px;background:#14141c;color:#e8e8ef}
h1,h2{color:#EB83FF} .cards{display:flex;gap:12px;flex-wrap:wrap}
.card{background:#1f1f2b;border-radius:10px;padding:14px 20px;min-width:130px}
.bad .num{color:#ff6b6b} .warn .num{color:#ffd166}
.num{font-size:26px;font-weight:700} .lbl{color:#999}
.row{display:flex;align-items:center;gap:8px;margin:3px 0} .name{width:110px}
.bar{height:14px;background:#EB83FF;border-radius:4px} .cnt{color:#999}
table{border-collapse:collapse;width:100%;font-size:13px} td,th{border:1px solid #333;padding:4px 8px;text-align:left}
tr.error td:first-child{color:#ff6b6b;font-weight:700} tr.warning td:first-child{color:#ffd166}
input{width:100%;padding:8px;margin:8px 0;background:#1f1f2b;border:1px solid #444;color:#fff;border-radius:6px}
.sec{margin-top:30px}
</style></head><body>
<h1>translate-qa — качество перевода без запуска игры</h1>
<div class="cards">${cards}</div>
<div class="sec"><h2>Покрытие по персонажам (топ-20)</h2>${bars}</div>
<div class="sec"><h2>Покрытие по папкам</h2>
<table><tr><th>папка</th><th>заполнено</th><th>%</th></tr>${dirs}</table></div>
<div class="sec"><h2>Находки (${findings.length})</h2>
<input id="q" placeholder="Фильтр…">
<table id="ft"><tr><th>уровень</th><th>правило</th><th>файл</th><th>текст</th><th>детали</th></tr>${rows}</table></div>
<script>
const Q=document.getElementById('q'),T=document.getElementById('ft');
const all=[...T.rows].slice(1);
Q.addEventListener('input',e=>{const f=e.target.value.toLowerCase();
for(const r of all){r.style.display=r.innerText.toLowerCase().includes(f)?'':'none';}});
</script></body></html>`;
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
