/**
 * prefill_po.mts — предзаполнение `po/<lang>.po` из YAML-корпуса переводов.
 *
 * Порт `extract-text/scripts/prefill_po.py` (поведение 1:1). Это НЕ перевод,
 * а измерение миграции: каждый msgstr берётся из существующего корпуса
 * `translations/` (историческое YAML-дерево, в новой репе отсутствует):
 *
 *   - coverage: у ключа POT есть точный (msgid, msgctxt) перевод;
 *   - fuzzy: ключ не совпал, но для голого текста есть РОВНО ОДИН вариант
 *     (дрейф контекста, например добавился спикер) — заполняется с флагом;
 *   - conflicts: один (text, ctxt) с РАЗНЫМИ переводами в разных файлах —
 *     решает человек, запись остаётся пустой;
 *   - missing: перевода нет нигде (очередь переводчика);
 *   - orphans: перевод без записи в POT (приёмка: 0 — ноль тихих потерь);
 *   - skipped_with_translation: skip-флаг + реальный перевод (ручной триаж).
 *
 * Подтверждённые человеком msgstr в существующем PO не пересчитываются:
 * состояние человека священно (как в оригинале).
 *
 * ВНИМАНИЕ: YAML-корпус — легаси-вход. В новой репе дерева `translations/`
 * нет, поэтому без `--corpus` инструмент только сохраняет текущие переводы
 * и печатает отчёт (все POT-строки без перевода попадут в `missing`).
 *
 * CLI: node .opencode/skills/extract-text/scripts/prefill_po.mts [lang]
 *        [--po-dir <dir>] [--corpus <dir>]
 * Out: po/<lang>.po (атомарная запись `.part` → rename).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

import { compareCodePoints } from "./inventory.mts";
import { newEntry, parsePo, renderPo, type PoEntry } from "./po_file.mts";
import { writeAtomic } from "./potgen.mts";

/** Корень репозитория: .../extract-text/scripts → вверх 4 уровня. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
export const DEFAULT_PO_DIR = join(REPO_ROOT, "po");

/** Строка YAML-корпуса, нормализованная под prefill. */
export interface CorpusEntry {
  text: string;
  translation: string;
  skipTranslation: boolean;
  speaker: string;
  /** Путь файла относительно родителя корпуса, как `as_posix()` в Python. */
  rel: string;
}

/** Один вариант перевода голого текста: значение + файл-источник. */
export interface RuVariant {
  translation: string;
  file: string;
}

export interface SkippedWithTranslation {
  text: string;
  ctxt: string;
  translation: string;
  file: string;
}

/** Ключ (msgid, msgctxt) в порядке Python-кортежа. */
export type PrefillKey = readonly [string, string];

function keyId(key: PrefillKey): string {
  return JSON.stringify(key);
}

function compareKeys(a: PrefillKey, b: PrefillKey): number {
  return compareCodePoints(a[0], b[0]) || compareCodePoints(a[1], b[1]);
}

// ---------------------------------------------------------------------------
// Мини-читатель YAML-корпуса
//
// Корпус — плоский список словарей (`- key: "value"` / `  key: "value"`),
// значения в двойных кавычках (эскейпы `\\`, `\"`, `\n`), `skip_translation`
// — голый `true`. Полный YAML не нужен (и не должен тянуть зависимость):
// поддерживается ровно тот подмножество, которое писал extractor.py.
// ---------------------------------------------------------------------------

const KEY_LINE_RX = /^\s*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;

const YAML_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

/** Раскодировать двойной скаляр YAML (включая \xXX / \uXXXX / \UXXXXXXXX). */
export function yamlUnescapeDouble(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== "\\" || i + 1 >= s.length) {
      out += c;
      i += 1;
      continue;
    }
    const n = s[i + 1];
    const hexLen = n === "x" ? 2 : n === "u" ? 4 : n === "U" ? 8 : 0;
    if (hexLen) {
      const hex = s.slice(i + 2, i + 2 + hexLen);
      if (hex.length === hexLen && /^[0-9a-fA-F]+$/.test(hex)) {
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 2 + hexLen;
        continue;
      }
    }
    out += YAML_ESCAPES[n] ?? n;
    i += 2;
  }
  return out;
}

/** Значение после `key:` → примитив (строка/булево/null). */
export function yamlScalar(raw: string): string | boolean | null {
  const s = raw.trim();
  if (s.startsWith('"') && s.length >= 2 && s.endsWith('"')) {
    return yamlUnescapeDouble(s.slice(1, -1));
  }
  if (s.startsWith("'") && s.length >= 2 && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === "true" || s === "True") return true;
  if (s === "false" || s === "False") return false;
  if (s === "" || s === "null" || s === "Null" || s === "~") return null;
  return s;
}

/**
 * Прочитать YAML-файл корпуса как список словарей.
 *
 * Пустой файл / файл-словарь (в корпусе есть `test.yaml`) → `[]`, как
 * `read_yaml()` в extractor.py (там не-список уходит в line-fallback).
 */
export function readYamlEntries(path: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: Array<Record<string, unknown>> = [];
  let cur: Record<string, unknown> | null = null;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      // Пустая строка/комментарий закрывают текущую запись (как fallback-парсер).
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    const m = KEY_LINE_RX.exec(line);
    if (!m) continue; // неизвестная строка — как fallback: молча пропускаем
    const key = m[1];
    const value = yamlScalar(m[2]);
    if (!cur || line.startsWith("- ")) {
      if (cur) entries.push(cur);
      cur = {};
    }
    cur[key] = value;
  }
  if (cur) entries.push(cur);
  return entries;
}

/**
 * Записи корпуса в детерминированном порядке `iter_source_entries()`.
 *
 * Порядок: dialogues → settings → raw (файлы внутри — code-point sort), затем
 * speakers.yaml. Он важен: от него зависит порядок вариантов в отчётах.
 */
export function iterSourceEntries(corpusRoot: string): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  const files: string[] = [];
  for (const sub of ["dialogues", "settings", "raw"]) {
    const dir = join(corpusRoot, sub);
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".yaml"))
      .map((d) => d.name)
      .sort(compareCodePoints);
    for (const name of names) files.push(join(dir, name));
  }
  const speakers = join(corpusRoot, "speakers.yaml");
  if (existsSync(speakers)) files.push(speakers);

  const parent = dirname(resolve(corpusRoot));
  for (const fp of files) {
    const rel = relative(parent, fp).split("\\").join("/");
    for (const e of readYamlEntries(fp)) {
      const text = e.text;
      if (typeof text !== "string" || !text) continue;
      entries.push({
        text,
        translation: typeof e.translation === "string" ? e.translation : "",
        skipTranslation: e.skip_translation === true,
        speaker: typeof e.speaker === "string" ? e.speaker : "",
        rel,
      });
    }
  }
  return entries;
}

/** Контекст записи — ДОЛЖЕН совпадать с potgen/prefill/po2yaml. */
export function entryContext(e: Pick<CorpusEntry, "speaker" | "rel">): string {
  const speaker = e.speaker.trim();
  if (e.rel === "translations/speakers.yaml") return "speaker-name";
  if (speaker) return `speaker:${speaker}`;
  return "ui";
}

/**
 * Агрессивная нормальная форма для twin-матчинга (прикрыта правилом
 * «ровно один вариант»). «004 Yeees yeees Ill be thereee 1» и «Yeees yeees,
 * I'll be thereee!» обе → «yes yes ill be there». Выкидываются маркеры,
 * пунктуация, апострофы и растяжения букв; разные слова остаются разными.
 */
export function normalizeText(input: string): string {
  let s = (input || "").toLowerCase().replace(/'/g, "").replace(/’/g, "");
  s = s.replace(/[^a-zа-яё ]/g, " ");
  s = s.replace(/(.)\1{2,}/gu, "$1");
  return s.replace(/\s+/g, " ").trim();
}

/** Заблокированные нормальные формы (человек уже отклонил автозаполнение). */
export function loadBlocklist(poDir: string): Set<string> {
  const path = join(poDir, "autofill_blocklist.txt");
  const blocked = new Set<string>();
  if (!existsSync(path)) return blocked;
  for (const rawLine of readFileSync(path, "utf8").split(/\r\n|\r|\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (line) blocked.add(line);
  }
  return blocked;
}

export interface RuCorpus {
  /** (text, ctxt) → варианты перевода в порядке файлов корпуса. */
  map: Map<string, { key: PrefillKey; variants: RuVariant[] }>;
  skippedWithTranslation: SkippedWithTranslation[];
}

/** Собрать корпус: (text, ctxt) → варианты + список «skip с переводом». */
export function buildRuCorpus(entries: CorpusEntry[]): RuCorpus {
  const map: RuCorpus["map"] = new Map();
  const skipped: SkippedWithTranslation[] = [];
  for (const e of entries) {
    if (!e.text) continue;
    const ctxt = entryContext(e);
    if (e.skipTranslation) {
      if (e.translation && e.translation !== e.text) {
        skipped.push({ text: e.text, ctxt, translation: e.translation, file: e.rel });
      }
      continue;
    }
    if (!e.translation) continue;
    const id = keyId([e.text, ctxt]);
    const slot = map.get(id);
    const variant = { translation: e.translation, file: e.rel };
    if (slot) slot.variants.push(variant);
    else map.set(id, { key: [e.text, ctxt], variants: [variant] });
  }
  return { map, skippedWithTranslation: skipped };
}

export interface PrefillReport {
  total: number;
  exact: number;
  fuzzy: Array<[PrefillKey, string]>;
  autoNormalized: Array<[PrefillKey, string]>;
  conflicts: Array<[PrefillKey, RuVariant[]]>;
  missing: PrefillKey[];
  orphans: Array<[PrefillKey, RuVariant[]]>;
  skippedWithTranslation: SkippedWithTranslation[];
}

export interface BuildRuPoInput {
  potText: string;
  /** Содержимое текущего `<lang>.po` (null — файла нет). */
  oldPoText?: string | null;
  corpus: CorpusEntry[];
  blocked: ReadonlySet<string>;
}

/**
 * Заполнить записи PO. Возвращает (записи, отчёт).
 *
 * Человеческое состояние священно: существующие комментарии переводчика
 * переносятся, а подтверждённые переводы (msgstr без флага `auto-normalized`)
 * никогда не пересчитываются заново.
 */
export function buildRuPo(input: BuildRuPoInput): { entries: PoEntry[]; report: PrefillReport } {
  const potEntries = parsePo(input.potText).filter((e) => e.msgid);

  const oldHuman = new Map<string, PoEntry>();
  for (const e of parsePo(input.oldPoText ?? "")) {
    if (e.msgid) oldHuman.set(keyId([e.msgid, e.msgctxt]), e);
  }

  const { map: ruMap, skippedWithTranslation } = buildRuCorpus(input.corpus);
  const blocked = input.blocked;

  const byText = new Map<string, Set<string>>();
  const byNorm = new Map<string, Set<string>>();
  for (const { key, variants } of ruMap.values()) {
    const [text] = key;
    const textSet = byText.get(text) ?? new Set<string>();
    byText.set(text, textSet);
    const norm = normalizeText(text);
    const normSet = byNorm.get(norm) ?? new Set<string>();
    byNorm.set(norm, normSet);
    for (const v of variants) {
      textSet.add(v.translation);
      normSet.add(v.translation);
    }
  }

  const report: PrefillReport = {
    total: 0,
    exact: 0,
    fuzzy: [],
    autoNormalized: [],
    conflicts: [],
    missing: [],
    orphans: [],
    skippedWithTranslation,
  };
  const potKeys = new Set<string>();
  const entries: PoEntry[] = [];

  for (const pe of potEntries) {
    const key: PrefillKey = [pe.msgid, pe.msgctxt];
    const id = keyId(key);
    potKeys.add(id);
    report.total += 1;

    const variants = ruMap.get(id)?.variants ?? [];
    const distinct = [...new Set(variants.map((v) => v.translation))].sort(compareCodePoints);
    const confirmed = oldHuman.get(id);
    const out = newEntry();
    out.msgid = pe.msgid;
    out.msgctxt = pe.msgctxt;
    out.refs = [...pe.refs];
    out.comments = [...pe.comments];
    out.translator = confirmed ? [...confirmed.translator] : [];

    if (confirmed && confirmed.msgstr && !confirmed.flags.includes("auto-normalized")) {
      // Человек подтвердил (или это точный перенос прошлого прогона) — как есть.
      out.msgstr = confirmed.msgstr;
      out.flags = confirmed.flags.filter((f) => f !== "auto-normalized");
      report.exact += 1;
    } else if (distinct.length > 1) {
      report.conflicts.push([key, variants.map((v) => ({ ...v }))]);
    } else if (distinct.length === 1) {
      out.msgstr = distinct[0];
      report.exact += 1;
    } else {
      // Fuzzy: ровно один перевод для голого текста (контекст уехал).
      const cands = [...(byText.get(pe.msgid) ?? new Set<string>())].sort(compareCodePoints);
      if (cands.length === 1) {
        out.msgstr = cands[0];
        out.flags = ["fuzzy"];
        report.fuzzy.push([key, cands[0]]);
      } else {
        // Нормализованный fallback: урезанные FSM-варианты («000 Aw ... 2»)
        // наследуют единственный перевод своего нормализованного близнеца —
        // если семейство не в blocklist (отклонённые человеком).
        const norm = normalizeText(pe.msgid);
        const normCands = [...(byNorm.get(norm) ?? new Set<string>())].sort(compareCodePoints);
        if (normCands.length === 1 && !blocked.has(norm)) {
          out.msgstr = normCands[0];
          out.flags = ["fuzzy", "auto-normalized"];
          report.autoNormalized.push([key, normCands[0]]);
        } else {
          report.missing.push(key);
        }
      }
    }
    entries.push(out);
  }

  for (const { key, variants } of [...ruMap.values()].sort((a, b) => compareKeys(a.key, b.key))) {
    if (!potKeys.has(keyId(key))) {
      report.orphans.push([key, variants.map((v) => ({ ...v }))]);
    }
  }

  return { entries, report };
}

/** Строки заголовка ru.po (побайтово как в Python-версии; Lang всегда ru). */
export function ruHeaderLines(now: Date = new Date()): string[] {
  const p = (n: number): string => String(n).padStart(2, "0");
  const date =
    `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())} ` +
    `${p(now.getUTCHours())}:${p(now.getUTCMinutes())}+0000`;
  return [
    "# Russian translation for NeonTranslator (migrated from YAML corpus).",
    'msgid ""',
    'msgstr ""',
    '"Project-Id-Version: NeonTranslator 1.0\\n"',
    `"PO-Revision-Date: ${date}\\n"`,
    '"Language: ru\\n"',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '"Content-Transfer-Encoding: 8bit\\n"',
    '"Plural-Forms: nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\\n"',
  ];
}

// ---------------------------------------------------------------------------
// Мелкие Python-совместимости для отчёта (stderr): repr, срез, формат .1f.
// ---------------------------------------------------------------------------

/** Срез по code points (Python `s[:n]`), не по UTF-16 units. */
export function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** `repr(str)` для отчёта: кавычка по содержимому, эскейпы управляющих символов. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp > 0x7e && !isPyPrintable(ch)) {
      if (cp <= 0xff) out += `\\x${cp.toString(16)}`;
      else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, "0")}`;
      else out += `\\U${cp.toString(16).padStart(8, "0")}`;
    } else out += ch;
  }
  return `${quote}${out}${quote}`;
}

/** `str.isprintable()`: не печатаются C*, Zl, Zp и все Zs кроме пробела. */
function isPyPrintable(ch: string): boolean {
  if (ch === " ") return true;
  return !/[\p{C}\p{Z}]/u.test(ch);
}

/** Python `format(x, ".1f")` — округление к ближайшему, полук чётному. */
export function pyFixed1(x: number): string {
  const scaled = x * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const n = diff > 0.5 || (diff === 0.5 && Math.abs(floor) % 2 === 1) ? floor + 1 : floor;
  return (n / 10).toFixed(1);
}

export interface PrefillOptions {
  lang?: string;
  poDir?: string;
  /** Корень YAML-корпуса; по умолчанию `../translations` от каталога po/. */
  corpusDir?: string;
  /** Фиксированная дата заголовка (паритет/тесты); по умолчанию — сейчас. */
  now?: Date;
}

export interface PrefillResult {
  poPath: string;
  report: PrefillReport;
}

/** Прогон: POT + корпус + текущий PO → новый PO. Ошибка, если POT нет. */
export function runPrefill(options: PrefillOptions = {}): PrefillResult {
  const lang = options.lang ?? "ru";
  const poDir = resolve(options.poDir ?? DEFAULT_PO_DIR);
  const potPath = join(poDir, "template.pot");
  if (!existsSync(potPath)) {
    throw new Error("run potgen.mts first (po/template.pot missing)");
  }
  const corpusDir = options.corpusDir ?? join(dirname(poDir), "translations");

  const poPath = join(poDir, `${lang}.po`);
  const oldPoText = existsSync(poPath) ? readFileSync(poPath, "utf8") : null;
  const { entries, report } = buildRuPo({
    potText: readFileSync(potPath, "utf8"),
    oldPoText,
    corpus: iterSourceEntries(corpusDir),
    blocked: loadBlocklist(poDir),
  });

  writeAtomic(poPath, renderPo(entries, ruHeaderLines(options.now)));
  return { poPath, report };
}

function printReport(lang: string, poPath: string, r: PrefillReport): void {
  const cov = pyFixed1((100.0 * r.exact) / Math.max(r.total, 1));
  console.error(`${lang}.po: ${r.exact}/${r.total} exact (${cov}%) -> ${poPath}`);
  console.error(`  fuzzy (context drift): ${r.fuzzy.length}`);
  console.error(`  auto-normalized (stripped variants inherit): ${r.autoNormalized.length}`);
  for (const [[text, ctxt], tr] of r.autoNormalized.slice(0, 10)) {
    console.error(`    AUTO ${ctxt} ${pyRepr(cpSlice(text, 60))} -> ${pyRepr(cpSlice(tr, 60))}`);
  }
  console.error(`  conflicts (same key, different RU): ${r.conflicts.length}`);
  for (const [[text, ctxt], variants] of r.conflicts.slice(0, 10)) {
    console.error(`    CONFLICT ${ctxt} ${pyRepr(text)}:`);
    for (const v of variants) console.error(`      ${pyRepr(v.translation)}  [${v.file}]`);
  }
  console.error(`  missing (no RU anywhere): ${r.missing.length}`);
  for (const [text, ctxt] of r.missing.slice(0, 10)) {
    console.error(`    MISSING ${ctxt} ${pyRepr(cpSlice(text, 70))}`);
  }
  console.error(`  orphans (RU with no POT entry): ${r.orphans.length}`);
  for (const [[text, ctxt], variants] of r.orphans.slice(0, 10)) {
    console.error(`    ORPHAN ${ctxt} ${pyRepr(cpSlice(text, 70))}: ${reprVariants(variants)}`);
  }
  console.error(`  skipped with real translation: ${r.skippedWithTranslation.length}`);
  for (const s of r.skippedWithTranslation.slice(0, 10)) {
    console.error(
      `    SKIPPED-TR ${s.ctxt} ${pyRepr(cpSlice(s.text, 50))} -> ` +
        `${pyRepr(cpSlice(s.translation, 50))} [${s.file}]`,
    );
  }
}

/** Python repr списка кортежей `[(tr, file), ...]` — как печатает f-string. */
function reprVariants(variants: RuVariant[]): string {
  const items = variants.map((v) => `(${pyRepr(v.translation)}, ${pyRepr(v.file)})`);
  return `[${items.join(", ")}]`;
}

const USAGE = `Usage: node prefill_po.mts [lang] [--po-dir <dir>] [--corpus <dir>]

  lang            язык перевода (по умолчанию ru)
  --po-dir <dir>  каталог с template.pot и <lang>.po (по умолчанию po/)
  --corpus <dir>  корень YAML-корпуса (по умолчанию ../translations от po/)
  -h, --help      эта справка`;

interface Cli {
  lang: string;
  poDir?: string;
  corpusDir?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { lang: "ru", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") cli.help = true;
    else if (arg === "--po-dir" || arg === "--corpus") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} требует путь`);
      i += 1;
      if (arg === "--po-dir") cli.poDir = value;
      else cli.corpusDir = value;
    } else if (arg.startsWith("--po-dir=")) cli.poDir = arg.slice("--po-dir=".length);
    else if (arg.startsWith("--corpus=")) cli.corpusDir = arg.slice("--corpus=".length);
    else if (arg.startsWith("-")) throw new Error(`неизвестный аргумент: ${arg}`);
    else cli.lang = arg;
  }
  return cli;
}

/** CLI: 0 — успех, 1 — ошибка обработки, 2 — ошибка аргументов. */
export function main(argv: string[]): number {
  let cli: Cli;
  try {
    cli = parseArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (cli.help) {
    console.error(USAGE);
    return 0;
  }
  try {
    const { poPath, report } = runPrefill(cli);
    printReport(cli.lang, poPath, report);
    return 0;
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
