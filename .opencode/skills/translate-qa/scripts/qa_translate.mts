/**
 * qa_translate.mts — офлайн-QA перевода без запуска игры.
 *
 * Порт `translate-qa/scripts/qa_translate.py` (поведение 1:1 по числам).
 * Читает `po/template.pot` (очередь работ) и `runtime/patch_<lang>.dat`
 * (истина «что реально уехало в игру»):
 *
 *   1. покрытие — всего / по папкам / по персонажам (msgctxt `speaker:X`);
 *   2. copy-through в диалогах (`x === t`, не legacy)     -> error;
 *   3. дисбаланс rich-тегов (`r` против `rt`)             -> error;
 *   4. латиница в RU-переводе (кириллицы < 30 %, len > 10) -> warning;
 *   5. дубли `(msgid, msgctxt)` с разным `msgstr` в `po/<lang>.po` -> error;
 *   6. пустой `x` для диалоговой записи из POT            -> error.
 *
 * Legacy-строки триажа (флаг `sk` из `#, legacy`) исключены из 2/4/6.
 *
 * ВАЖНО: длина перевода НЕ критерий (правило AGENTS.md). `len(tr) > 10` в
 * правиле 4 — порог поиска непереведённой латиницы, а не оценка длины.
 *
 * Запуск: node .opencode/skills/translate-qa/scripts/qa_translate.mts [--out tmp/qa.html] [--lang ru]
 * Код выхода 1 при наличии error (CI-ready).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { parsePo, type PoEntry } from "../../extract-text/scripts/po_file.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

const CYR_RX = /[А-Яа-яЁё]/u;
const LAT_RX = /[A-Za-z]/;
const TAG_RX = /<[^>]+>/g;
const LETTER_RX = /\p{L}/u;

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

/** Строка `runtime/patch_<lang>.dat` (один JSON-объект на строку). */
export interface DatRow {
  t?: string;
  x?: string;
  r?: string;
  rt?: string;
  sk?: boolean;
}

/** Записи POT с непустым msgid (заголовок каталога отбрасывается). */
export function loadPot(root: string = REPO_ROOT): PoEntry[] {
  const path = join(root, "po", "template.pot");
  return parsePo(readFileSync(path, "utf8")).filter((e) => e.msgid);
}

/** `{text: row}`, первая строка побеждает — как в C#-загрузчике. */
export function loadDat(lang: string, root: string = REPO_ROOT): Map<string, DatRow> {
  const path = join(root, "runtime", `patch_${lang}.dat`);
  const rows = new Map<string, DatRow>();
  if (!existsSync(path)) return rows;
  for (const line of readFileSync(path, "utf8").split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue;
    let row: DatRow;
    try {
      row = JSON.parse(line) as DatRow;
    } catch {
      continue; // битая строка — как в Python-версии, пропускаем
    }
    if (row.t && !rows.has(row.t)) rows.set(row.t, row);
  }
  return rows;
}

/** Спикер из msgctxt `speaker:X` (иначе пустая строка). */
export function speakerOf(ctxt: string): string {
  return ctxt.startsWith("speaker:") ? ctxt.slice("speaker:".length) : "";
}

/**
 * Папка-источник по ссылкам `#:`.
 *
 * POT больше не пишет refs (potgen), поэтому на текущих данных результат
 * всегда `ui`; правило сохранено для паритета с Python и будущих refs.
 */
export function sourcedirOf(refs: string[]): string {
  for (const r of refs) {
    if (r.startsWith("translations/")) {
      const parts = r.split("/");
      return parts.length > 1 ? parts[1] : r;
    }
  }
  for (const r of refs) {
    // Новые стабильные refs: [dlg:..], [bundle:..], [set:..], [fsm:..], [spk:..].
    if (r.startsWith("[") && r.endsWith("]")) {
      const kind = r.slice(1, -1).split(":")[0];
      if (["dlg", "bundle", "set", "fsm", "spk", "raw"].includes(kind)) return kind;
    }
  }
  return refs.length ? "?" : "ui";
}

/** Доля кириллицы среди букв (1.0, если букв нет). */
export function cyrRatio(s: string): number {
  let letters = 0;
  let cyr = 0;
  for (const c of s) {
    if (!LETTER_RX.test(c)) continue;
    letters += 1;
    if (CYR_RX.test(c)) cyr += 1;
  }
  return letters ? cyr / letters : 1;
}

function inc(map: Map<string, Stat>, key: string, filled: boolean): void {
  const stat = map.get(key) ?? { filled: 0, total: 0 };
  stat.total += 1;
  if (filled) stat.filled += 1;
  map.set(key, stat);
}

function firstTagNames(tags: string[]): string[] {
  return tags.map((t) => t.split(/\s+/)[0]);
}

/**
 * Прогнать все проверки. `root` — папка репозитория с `po/` и `runtime/`
 * (вынесено параметром, чтобы тесты работали на временной раскладке).
 */
export function check(
  lang = "ru",
  root: string = REPO_ROOT,
): { summary: Summary; findings: Finding[] } {
  const findings: Finding[] = [];
  const pot = loadPot(root);
  const dat = loadDat(lang, root);

  const total = pot.length;
  let filled = 0;
  const bySpeaker = new Map<string, Stat>();
  const byDir = new Map<string, Stat>();

  for (const e of pot) {
    const text = e.msgid;
    const ctxt = e.msgctxt;
    const rel =
      e.refs.find((r) => r.startsWith("translations/") || (r.startsWith("[") && r.endsWith("]"))) ??
      "po";
    const row = dat.get(text);
    const tr = row?.x ?? "";
    const sk = Boolean(row?.sk);
    if (tr) filled += 1;
    const d = sourcedirOf(e.refs);
    inc(byDir, d, Boolean(tr));
    const sp = speakerOf(ctxt);
    if (sp) inc(bySpeaker, sp, Boolean(tr));

    const dlg = Boolean(sp) || d === "dialogues";
    if (sk || e.flags.includes("no-translate")) continue;

    if (dlg && !tr) {
      findings.push({
        level: "error",
        rule: "empty-dialogue",
        rel,
        text,
        detail: "пустой перевод в диалоге",
      });
    }
    if (dlg && tr && tr === text) {
      findings.push({
        level: "error",
        rule: "copy-through",
        rel,
        text,
        detail: "перевод совпадает с оригиналом",
      });
    }
    const r = row?.r ?? "";
    const rt = row?.rt ?? "";
    if (r && rt) {
      const tags = r.match(TAG_RX) ?? [];
      const ttags = rt.match(TAG_RX) ?? [];
      if (firstTagNames(tags).join("\u0000") !== firstTagNames(ttags).join("\u0000")) {
        findings.push({
          level: "error",
          rule: "tag-imbalance",
          rel,
          text,
          detail: `${[...tags]} vs ${[...ttags]}`,
        });
      }
    }
    // Латиница-остаток — проверка конкретной письменности (ru; расширять по семьям).
    if (lang === "ru" && tr && [...tr].length > 10 && cyrRatio(tr) < 0.3 && LAT_RX.test(tr)) {
      findings.push({
        level: "warning",
        rule: "latin-leftover",
        rel,
        text,
        detail: tr.slice(0, 80),
      });
    }
  }

  // Дубли в самом po: один (msgid, msgctxt) с РАЗНЫМИ переводами — ошибка.
  // (Python-версия читала POT, где msgstr всегда пуст, поэтому правило было
  // мёртвым; здесь источник — `po/<lang>.po`, как и задумано в описании.)
  const poPath = join(root, "po", `${lang}.po`);
  if (existsSync(poPath)) {
    const variants = new Map<string, Set<string>>();
    for (const e of parsePo(readFileSync(poPath, "utf8"))) {
      if (!e.msgid) continue;
      const key = `${e.msgctxt}\u0000${e.msgid}`;
      const set = variants.get(key) ?? new Set<string>();
      set.add(e.msgstr);
      variants.set(key, set);
    }
    for (const [key, set] of variants) {
      if (set.size <= 1) continue;
      const [ctxt, text] = key.split("\u0000");
      findings.push({
        level: "error",
        rule: "duplicate-po",
        rel: `po/${lang}.po`,
        text,
        detail: `${ctxt}: ${JSON.stringify([...set].sort())}`,
      });
    }
  }

  const summary: Summary = {
    total,
    filled,
    coverage: (100 * filled) / Math.max(total, 1),
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
    bySpeaker: new Map([...bySpeaker].sort((a, b) => b[1].total - a[1].total)),
    byDir: new Map([...byDir].sort((a, b) => a[0].localeCompare(b[0]))),
  };
  return { summary, findings };
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

/** Аргумент `--флаг значение` (undefined, если флага нет). */
function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv: string[]): number {
  const lang = arg(argv, "--lang") ?? "ru";
  const out = resolve(arg(argv, "--out") ?? join(REPO_ROOT, "tmp", "qa.html"));
  const { summary, findings } = check(lang);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderHtml(summary, findings), "utf8");
  console.error(
    `QA[${lang}]: ${summary.filled}/${summary.total} (${summary.coverage.toFixed(1)}%), ` +
      `errors=${summary.errors}, warnings=${summary.warnings} -> ${out}`,
  );
  for (const f of findings) {
    if (f.level !== "error") continue;
    console.error(
      `  ERROR [${f.rule}] ${f.rel} :: ${JSON.stringify(f.text.slice(0, 70))} :: ${f.detail.slice(0, 70)}`,
    );
  }
  return summary.errors ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
