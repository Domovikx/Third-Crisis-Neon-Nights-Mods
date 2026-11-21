/**
 * build_site.mts — собирает статическую страницу сайта из шаблона + реальных данных.
 *
 * Зачем генератор, а не руками написанный HTML: список языков и покрытие перевода
 * обязаны совпадать с `config/language-priority.json` и `po/*.po`. Иначе сайт
 * начинает врать (DRY-дефект), поэтому цифры считаются из исходников при сборке.
 *
 * CLI: node scripts/build_site.mts [--out <файл>]
 *   по умолчанию -> site/index.html (в git не попадает, собирается в CI перед Pages)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { REPO_ROOT, loadLanguagePriority } from "./languages.mts";
import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";

export interface LangCoverage {
  code: string;
  language: string;
  share: number;
  filled: number;
  total: number;
  pct: number;
}

/** Заполненные/всего записей в `po/<code>.po` (заголовок не считается). */
export function coverageOf(
  code: string,
  root: string = REPO_ROOT,
): { filled: number; total: number } {
  const path = join(root, "po", `${code}.po`);
  if (!existsSync(path)) return { filled: 0, total: 0 };
  const entries = parsePo(readFileSync(path, "utf8")).filter((e) => e.msgid);
  const filled = entries.filter((e) => e.msgstr.trim() !== "").length;
  return { filled, total: entries.length };
}

/** Строки таблицы языков (в порядке приоритета). */
export function langRows(root: string = REPO_ROOT): LangCoverage[] {
  const priority = loadLanguagePriority(join(root, "config", "language-priority.json"));
  return [...priority.languages]
    .sort((a, b) => a.rank - b.rank)
    .map((l) => {
      const { filled, total } = coverageOf(l.code, root);
      return {
        code: l.code,
        language: l.language,
        share: l.share,
        filled,
        total,
        pct: total ? Math.round((100 * filled) / total) : 0,
      };
    });
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 12345 -> "12 345" (тонкие пробелы не используем: копипаст в терминал ломается). */
const groupDigits = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function rowHtml(r: LangCoverage): string {
  const label = r.code === "en" ? `${r.language} (оригинал)` : r.language;
  const counts =
    r.code === "en" ? "источник" : `${groupDigits(r.filled)} / ${groupDigits(r.total)}`;
  const pct = r.code === "en" ? 100 : r.pct;
  return [
    "              <tr>",
    `                <td>${escapeHtml(label)}</td>`,
    `                <td><code>${escapeHtml(r.code)}</code></td>`,
    `                <td>${counts}</td>`,
    `                <td><span class="bar"><span style="width:${pct}%"></span></span>${pct}%</td>`,
    "              </tr>",
  ].join("\n");
}

/** Собрать страницу и вернуть путь к результату. */
export function buildSite(root: string = REPO_ROOT, outPath?: string): string {
  const tplPath = join(root, "site", "template.html");
  if (!existsSync(tplPath)) throw new Error(`нет шаблона: ${tplPath}`);
  const rows = langRows(root);
  const html = readFileSync(tplPath, "utf8")
    .replace("{{LANG_ROWS}}", rows.map(rowHtml).join("\n"))
    .replace(/\{\{LANG_COUNT\}\}/g, String(rows.length))
    .replace(/\{\{GENERATED_AT\}\}/g, new Date().toISOString().slice(0, 10));
  const out = outPath ?? join(root, "site", "index.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");
  return out;
}

function main(argv: string[]): number {
  const i = argv.indexOf("--out");
  const out = i >= 0 ? argv[i + 1] : undefined;
  const path = buildSite(REPO_ROOT, out);
  const rows = langRows(REPO_ROOT);
  console.log(`site: ${path}`);
  for (const r of rows) {
    console.log(`  ${r.code}: ${r.filled}/${r.total} (${r.pct}%)`);
  }
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
