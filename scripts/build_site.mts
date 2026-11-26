/**
 * build_site.mts — собирает статические страницы сайта из шаблона + реальных данных.
 *
 * Зачем генератор, а не руками написанный HTML: список языков, покрытие и счётчики
 * обязаны совпадать с `config/language-priority.mts` (JSON рядом — артефакт), `po/*.po`
 * и `po/template.pot`.
 * Иначе сайт начинает врать (DRY-дефект), поэтому цифры считаются при сборке.
 *
 * Две страницы из одного шаблона: `site/index.html` (ru) и `site/en.html` (en).
 * Тексты — `site/i18n.mts`; скриншоты — `site/shots/`.
 *
 * CLI: node scripts/build_site.mts [--out <файл>]
 *   без --out пишет обе страницы; с --out — только русскую в указанный файл.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { REPO_ROOT, loadLanguagePriority } from "./languages.mts";
import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import { NATIVE_NAMES, SITE_TEXT, type SiteLang } from "../site/i18n.mts";

/** Версия страницы = версия релиза. Обновляется вместе с `npm run release -- --version`. */
export const SITE_VERSION = "2026.11.25";

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

/** Сколько строк в POT несут TMP-разметку (`#. rich_text:`). */
export function richCount(root: string = REPO_ROOT): number {
  const pot = join(root, "po", "template.pot");
  if (!existsSync(pot)) return 0;
  return (readFileSync(pot, "utf8").match(/^#\. rich_text:/gm) ?? []).length;
}

/** Сводные цифры страницы — из данных, не из рук. */
export interface SiteStats {
  lines: number;
  rich: number;
  langs: number;
  missing: number;
}

export function siteStats(rows: LangCoverage[], root: string = REPO_ROOT): SiteStats {
  const langs = rows.filter((r) => r.code !== "en");
  const lines = Math.max(0, ...langs.map((r) => r.total));
  const missing = langs.reduce((sum, r) => sum + Math.max(0, r.total - r.filled), 0);
  return { lines, rich: richCount(root), langs: langs.length, missing };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 12345 -> "12 345" (тонкие пробелы не используем: копипаст в терминал ломается). */
const groupDigits = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function langCard(row: LangCoverage, messages: Record<string, string>): string {
  const name = NATIVE_NAMES[row.code] ?? row.language;
  const meta = messages["languages.cell"]
    .replaceAll("{lines}", groupDigits(row.total))
    .replaceAll("{pct}", String(row.pct));
  const primary = row.code === "ru";
  return [
    `            <li class="lang-card"${primary ? ' data-primary="true"' : ""}>`,
    ...(primary
      ? [`              <span class="lang-primary-tag">${messages["languages.primary"]}</span>`]
      : []),
    `              <span class="lang-native" lang="${row.code}">${escapeHtml(name)}</span>`,
    `              <span class="lang-meta"><span class="lang-code">${row.code.toUpperCase()}</span> · ${escapeHtml(meta)}</span>`,
    `              <span class="bar"><span style="width:${row.pct}%"></span></span>`,
    "            </li>",
  ].join("\n");
}

/** Подставить тексты словаря и цифры в шаблон одной страницы. */
export function renderSite(lang: SiteLang, root: string = REPO_ROOT): string {
  const tplPath = join(root, "site", "template.html");
  if (!existsSync(tplPath)) throw new Error(`нет шаблона: ${tplPath}`);
  const rows = langRows(root);
  const stats = siteStats(rows, root);
  const messages = SITE_TEXT[lang];

  const tokens: Record<string, string> = {
    lines: groupDigits(stats.lines),
    rich: groupDigits(stats.rich),
    langs: String(stats.langs),
    missing: String(stats.missing),
    version: SITE_VERSION,
    date: new Date().toISOString().slice(0, 10),
  };

  const values: Record<string, string> = {
    LANG: lang,
    ALT_LANG: lang === "ru" ? "en" : "ru",
    ALT_HREF: lang === "ru" ? "en.html" : "index.html",
    LINES: tokens.lines,
    RICH: tokens.rich,
    LANGS: tokens.langs,
    MISSING: tokens.missing,
    GENERATED_AT: tokens.date,
    LANG_ROWS: rows
      .filter((r) => r.code !== "en")
      .map((r) => langCard(r, messages))
      .join("\n"),
  };

  for (const [key, value] of Object.entries(messages)) {
    const formatted = value.replace(/\{(\w+)\}/g, (whole, token: string) =>
      token in tokens ? tokens[token] : whole,
    );
    values[key] = escapeHtml(formatted);
  }

  const html = readFileSync(tplPath, "utf8").replace(
    /\{\{([\w.]+)\}\}/g,
    (_match, key: string) => values[key] ?? `{{${key}}}`,
  );
  const leftover = html.match(/\{\{[\w.]+\}\}/);
  if (leftover) throw new Error(`в шаблоне не подставлен плейсхолдер: ${leftover[0]}`);
  return html;
}

/** Собрать обе страницы; вернуть пути (ru первой). */
export function buildSite(root: string = REPO_ROOT, outPath?: string): string[] {
  const out = outPath ?? join(root, "site", "index.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderSite("ru", root), "utf8");
  if (outPath) return [out];

  const enOut = join(root, "site", "en.html");
  writeFileSync(enOut, renderSite("en", root), "utf8");
  return [out, enOut];
}

function main(argv: string[]): number {
  const i = argv.indexOf("--out");
  const out = i >= 0 ? argv[i + 1] : undefined;
  const paths = buildSite(REPO_ROOT, out);
  const rows = langRows(REPO_ROOT);
  const stats = siteStats(rows);
  console.log(`site: ${paths.join(", ")}`);
  console.log(
    `  строк: ${stats.lines}, rich: ${stats.rich}, языков: ${stats.langs}, непереведённых: ${stats.missing}`,
  );
  for (const r of rows) {
    if (r.code === "en") console.log("  en: источник (po/template.pot)");
    else console.log(`  ${r.code}: ${r.filled}/${r.total} (${r.pct}%)`);
  }
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
