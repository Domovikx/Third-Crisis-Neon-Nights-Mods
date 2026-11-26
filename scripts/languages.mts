/**
 * languages.mts — языки перевода и их порядок (единый источник — конфиг).
 *
 * Мод ТЕКСТОВЫЙ: озвучки нет и не будет. Язык-источник — английский (`en`),
 * он живёт в `po/template.pot`; остальные языки — `po/<code>.po`.
 *
 * Порядок и состав языков берутся из `config/language-priority.mts` — модуль, источник
 * истины (копия приоритета из TSSR: языковая статистика Steam, окт. 2026). JSON
 * рядом (`config/language-priority.json`) — генерируемый артефакт для Rust.
 * Любой список языков в UI/доках/скриптах выводится В ЭТОМ ПОРЯДКЕ —
 * руками порядок не переставлять, новый язык = строка в JSON.
 *
 * CLI: node scripts/languages.mts [--check]
 *   --check — сверить конфиг с фактическими файлами `po/*.po` (код 1 при расхождении).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

export const REPO_ROOT = resolve(import.meta.dirname, "..");
export const PRIORITY_PATH = join(REPO_ROOT, "config", "language-priority.json");

/** Язык оригинала: его текст лежит в `po/template.pot`, отдельного `en.po` нет. */
export const SOURCE_LANG = "en";

export interface LanguageEntry {
  rank: number;
  code: string;
  language: string;
  share: number;
}

export interface LanguagePriority {
  source: string;
  updated: string;
  languages: LanguageEntry[];
}

/** Прочитать конфиг приоритета языков. */
export function loadLanguagePriority(path: string = PRIORITY_PATH): LanguagePriority {
  const raw = JSON.parse(readFileSync(path, "utf8")) as LanguagePriority;
  if (!Array.isArray(raw.languages) || raw.languages.length === 0) {
    throw new Error(`${path}: пустой список languages`);
  }
  const codes = raw.languages.map((l) => l.code);
  for (const c of codes) {
    if (!/^[a-z]{2}$/.test(c)) throw new Error(`${path}: странный код языка "${c}"`);
  }
  if (new Set(codes).size !== codes.length) throw new Error(`${path}: дубликаты кодов языков`);
  return raw;
}

/** Коды языков В ПОРЯДКЕ ПРИОРИТЕТА (включая источник). */
export function allLangs(p: LanguagePriority = loadLanguagePriority()): string[] {
  return [...p.languages].sort((a, b) => a.rank - b.rank).map((l) => l.code);
}

/** Языки перевода (всё, кроме источника), в порядке приоритета. */
export function translateLangs(p: LanguagePriority = loadLanguagePriority()): string[] {
  return allLangs(p).filter((c) => c !== SOURCE_LANG);
}

export interface LangCheck {
  ok: boolean;
  missing: string[];
  extra: string[];
  ordered: string[];
}

/** Сверить конфиг с фактическими `po/<code>.po`. */
export function checkPoFiles(root: string = REPO_ROOT): LangCheck {
  const expected = translateLangs();
  const poDir = join(root, "po");
  const actual = existsSync(poDir)
    ? readdirSync(poDir)
        .filter((f) => f.endsWith(".po"))
        .map((f) => f.replace(/\.po$/, ""))
    : [];
  const missing = expected.filter((c) => !actual.includes(c));
  const extra = actual.filter((c) => !expected.includes(c));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra, ordered: expected };
}

function main(argv: string[]): number {
  const p = loadLanguagePriority();
  const langs = translateLangs(p);
  console.log(`Источник: ${SOURCE_LANG} (po/template.pot)`);
  console.log(`Языки перевода (${langs.length}, порядок из конфига): ${langs.join(", ")}`);
  if (!argv.includes("--check")) return 0;
  const chk = checkPoFiles();
  if (chk.ok) {
    console.log("OK: po/*.po совпадает с приоритетом.");
    return 0;
  }
  if (chk.missing.length) console.error(`нет переводов: ${chk.missing.join(", ")}`);
  if (chk.extra.length)
    console.error(`лишние po-файлы (нет в приоритете): ${chk.extra.join(", ")}`);
  return 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
