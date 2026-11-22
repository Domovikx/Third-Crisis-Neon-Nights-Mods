/**
 * pot_invariants.mts — контракт `po/template.pot` (14 инвариантов).
 *
 * POT — корень пайплайна: его ошибки попадают во все языки (`po/<lang>.po` →
 * `.dat` → игра). Поэтому проверки собраны в одну функцию
 * `checkPot(potPath, opts?)`, которую зовут и тесты, и CI, и человек из CLI.
 *
 * Что проверяется без дампа (структура и формат):
 *   5 уникальность `(msgid, msgctxt)`, 6 порядок, 7 rich-разметка (форма),
 *   8 экранирование/round-trip, 10 кодировка, 11 заголовок и шаблонность,
 *   14 провенанс (`#. src:` из фиксированного списка).
 *
 * Что включается, когда передан `dumpPath` (сверка с источником):
 *   1 детерминизм (порядок элементов не влияет), 2 идемпотентность
 *   (POT = перегенерация), 3 полнота, 4 «нет выдуманного», 7 rich-значения,
 *   9 сходимость счётчиков/триажа, 13 битые строки дампа, 14 src = источник.
 *
 * 12 (паритет TS↔Rust) — единственный инвариант, который НЕ реализован здесь:
 * он уже покрыт `scripts/text_parity.test.mts` (мини-дамп + реальный дамп).
 * Для разового прогона `checkPot` принимает `parityPot` (путь к POT второй
 * реализации) и сравнивает файлы побайтово, кроме `POT-Creation-Date`.
 *
 * Контракт и обоснование каждого инварианта — `docs/pot-contract.md`.
 */
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

import {
  isAssetName,
  isGarbageFragment,
} from "../.opencode/skills/pipeline-common/scripts/text_filters.mts";
import {
  compareCodePoints,
  isValidSrc,
  scanDump,
  type InventoryItem,
} from "../.opencode/skills/extract-text/scripts/inventory.mts";
import {
  buildCatalog,
  catalogSize,
  ctxtOf,
  POT_PATH,
  renderPot,
  srcOf,
  type PotCatalog,
  type PotStats,
} from "../.opencode/skills/extract-text/scripts/potgen.mts";
import {
  newEntry,
  poEscape,
  poUnescape,
  renderPo,
  type PoEntry,
} from "../.opencode/skills/extract-text/scripts/po_file.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "..");

/** Названия инвариантов (номер → короткая формулировка). */
export const INVARIANTS: Readonly<Record<number, string>> = {
  1: "детерминизм",
  2: "идемпотентность",
  3: "полнота",
  4: "нет выдуманного",
  5: "уникальность",
  6: "порядок",
  7: "rich_text",
  8: "экранирование",
  9: "триаж",
  10: "кодировка",
  11: "заголовок",
  12: "паритет реализаций",
  13: "устойчивость",
  14: "провенанс",
};

/** `error` — POT испорчен (пострадают все языки); `warn` — дефект генерации. */
export type ViolationSeverity = "error" | "warn";

export interface Violation {
  invariant: number;
  code: string;
  severity: ViolationSeverity;
  /** Адрес: файл:строка / msgid+msgctxt / файл дампа. */
  where: string;
  detail: string;
}

export interface PotCheckOptions {
  /** Каталог JSONL-дампа: включает сверку с источником (инварианты 1–4, 7, 9, 13). */
  dumpPath?: string;
  /** POT второй реализации (Rust) — инвариант 12, без запуска процессов. */
  parityPot?: string;
  /** Подпись источника для адресов (по умолчанию имя POT или `<text>`). */
  label?: string;
  /** Предел нарушений на один код (по умолчанию 20; 0 — без предела). */
  limit?: number;
  /** Дата для перегенерации при сверке (по умолчанию фиксированная). */
  created?: string;
  /**
   * Требовать `#. src:` у каждой записи (по умолчанию да).
   *
   * `false` — только для POT, сгенерированного ДО провенанса
   * (`po/template.pot` на 2026-11-22): перегенерация меняет файл, а это
   * отдельный шаг политики. Новый POT без `src` контракт не пропускает.
   */
  requireSrc?: boolean;
}

/** Дата, используемая во всех сверках: сам POT меняет только `POT-Creation-Date`. */
export const CHECK_DATE = "2000-01-01 00:00+0000";

// ---------------------------------------------------------------------------
// Структурный разбор POT
// ---------------------------------------------------------------------------

const FIELD_RX = /^(msgid|msgctxt|msgstr)\s+"((?:[^"\\]|\\.)*)"$/;
const CONT_RX = /^"((?:[^"\\]|\\.)*)"$/;
const FIELD_NAMES = ["msgid", "msgctxt", "msgstr"] as const;
type FieldName = (typeof FIELD_NAMES)[number];

interface RawField {
  /** Сырая (закодированная) часть без кавычек, склеенная по строкам. */
  raw: string;
  /** Декодированное значение. */
  value: string;
  line: number;
  /** Сколько физических строк заняло поле (>1 = неканонично). */
  lines: number;
}

interface RawEntry {
  line: number;
  fields: Partial<Record<FieldName, RawField>>;
  comments: Array<{ text: string; line: number }>;
  refs: string[];
  flags: string[];
  translator: string[];
}

export interface ParsedPot {
  text: string;
  bom: boolean;
  /** Номера строк с CR (CRLF или одиночный CR). */
  crLines: number[];
  entries: RawEntry[];
  /** Сырые строки шапки: всё до первого блока записей. */
  headerLines: string[];
  syntax: Array<{ line: number; text: string; reason: string }>;
}

function decodeField(raw: string): string {
  return poUnescape(raw);
}

/** Разобрать POT в блоки, сохранив номера строк и сырые значения. */
export function parsePotText(source: string): ParsedPot {
  const bom = source.startsWith("\uFEFF");
  const text = bom ? source.slice(1) : source;

  const crLines: number[] = [];
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    if (line.includes("\r")) crLines.push(idx + 1);
  });
  const clean = text.split(/\r\n|\r|\n/);

  const entries: RawEntry[] = [];
  const syntax: Array<{ line: number; text: string; reason: string }> = [];
  let cur: RawEntry | null = null;
  let field: FieldName | null = null;

  for (let i = 0; i < clean.length; i += 1) {
    const line = clean[i];
    const lineNo = i + 1;
    if (!line.trim()) {
      if (cur) entries.push(cur);
      cur = null;
      field = null;
      continue;
    }
    cur ??= { line: lineNo, fields: {}, comments: [], refs: [], flags: [], translator: [] };

    if (line.startsWith("#")) {
      const comment = /^#\. ?(.*)$/.exec(line);
      if (comment) cur.comments.push({ text: comment[1], line: lineNo });
      else if (line.startsWith("#: ")) cur.refs.push(line.slice(3).trim());
      else if (line.startsWith("#, ")) cur.flags.push(line.slice(3).trim());
      else if (line.startsWith("# ")) cur.translator.push(line.slice(2));
      field = null;
      continue;
    }

    const f = FIELD_RX.exec(line);
    if (f) {
      const name = f[1] as FieldName;
      if (cur.fields[name]) {
        syntax.push({ line: lineNo, text: line, reason: `повтор поля ${name}` });
      }
      cur.fields[name] = { raw: f[2], value: decodeField(f[2]), line: lineNo, lines: 1 };
      field = name;
      continue;
    }

    const cont = CONT_RX.exec(line);
    const prev = field ? cur.fields[field] : undefined;
    if (cont && prev) {
      prev.raw += cont[1];
      prev.value += decodeField(cont[1]);
      prev.lines += 1;
      continue;
    }

    syntax.push({
      line: lineNo,
      text: line,
      reason: cont ? "продолжение без поля" : "строка не по грамматике PO",
    });
    field = null;
  }
  if (cur) entries.push(cur);

  const firstBlank = clean.findIndex((l) => !l.trim());
  const headerLines = clean.slice(0, firstBlank < 0 ? clean.length : firstBlank);

  return { text, bom, crLines, entries, headerLines, syntax };
}

/** Ключ записи для сравнений: `[msgid, msgctxt]`. */
export function potKey(msgid: string, msgctxt: string): string {
  return JSON.stringify([msgid, msgctxt]);
}

function address(entry: RawEntry): string {
  const id = entry.fields.msgid?.value ?? "";
  const ctx = entry.fields.msgctxt?.value ?? "";
  return `${entry.line}: ${JSON.stringify(id)} / ${JSON.stringify(ctx)}`;
}

function toPoEntry(entry: RawEntry): PoEntry {
  const e = newEntry();
  e.msgid = entry.fields.msgid?.value ?? "";
  e.msgctxt = entry.fields.msgctxt?.value ?? "";
  e.msgstr = entry.fields.msgstr?.value ?? "";
  e.comments = entry.comments.map((c) => c.text);
  e.refs = [...entry.refs];
  e.flags = [...entry.flags];
  e.translator = [...entry.translator];
  return e;
}

// ---------------------------------------------------------------------------
// Источник: ожидаемые записи из дампа
// ---------------------------------------------------------------------------

interface Expected {
  items: InventoryItem[];
  /** Все ключи инвентаря (включая ui-двойников). */
  keys: Map<string, InventoryItem>;
  /** Каталог POT по правилам генератора (ui-двойники удалены). */
  catalog: PotCatalog["catalog"];
  stats: PotStats;
  /** Ключи, удалённые как ui-двойники. */
  twinKeys: Set<string>;
  /** Ожидаемый rich_text по ключу. */
  rich: Map<string, string>;
  /** Ожидаемый провенанс по ключу. */
  src: Map<string, string>;
  duplicates: number;
}

/** rich_text из каталога генератора: ключ → значение. */
function richOf(catalog: PotCatalog["catalog"]): Map<string, string> {
  const rich = new Map<string, string>();
  for (const [text, byCtxt] of catalog) {
    for (const [ctxt, slot] of byCtxt) {
      const comment = slot.comments.find((c) => c.startsWith("rich_text: "));
      if (comment) rich.set(potKey(text, ctxt), comment.slice("rich_text: ".length));
    }
  }
  return rich;
}

async function buildExpected(dumpPath: string, items?: InventoryItem[]): Promise<Expected> {
  const list = items ?? (await scanDump(dumpPath)).items;
  const keys = new Map<string, InventoryItem>();
  let duplicates = 0;
  for (const item of list) {
    const key = potKey(item.text, ctxtOf(item));
    if (keys.has(key)) duplicates += 1;
    else keys.set(key, item);
  }

  const { catalog, stats } = buildCatalog(list);
  const twinKeys = new Set<string>();
  for (const key of keys.keys()) {
    const [text, ctxt] = JSON.parse(key) as [string, string];
    if (ctxt !== "ui") continue;
    const byCtxt = catalog.get(text);
    if (!byCtxt || !byCtxt.has("ui")) twinKeys.add(key);
  }

  return {
    items: list,
    keys,
    catalog,
    stats,
    twinKeys,
    rich: richOf(catalog),
    src: srcOf(catalog),
    duplicates,
  };
}

/** Строки дампа, которые `readJsonl` молча пропускает (битые/не-объекты). */
async function countIgnoredDumpLines(
  dumpDir: string,
): Promise<{ total: number; ignored: number; samples: string[] }> {
  let total = 0;
  let ignored = 0;
  const samples: string[] = [];
  const names = readdirSync(dumpDir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort();
  for (const name of names) {
    const rl = createInterface({
      input: createReadStream(join(dumpDir, name), { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      total += 1;
      try {
        const obj: unknown = JSON.parse(line);
        if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
          ignored += 1;
          if (samples.length < 3) samples.push(`${name}: не объект`);
        }
      } catch {
        ignored += 1;
        if (samples.length < 3) samples.push(`${name}: ${line.slice(0, 60)}`);
      }
    }
  }
  return { total, ignored, samples };
}

// ---------------------------------------------------------------------------
// Инварианты 5, 6, 8, 10, 11 — без дампа
// ---------------------------------------------------------------------------

const REQUIRED_HEADER_FIELDS = [
  "Project-Id-Version",
  "POT-Creation-Date",
  "Content-Type",
  "Content-Transfer-Encoding",
] as const;

const POT_DATE_RX = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\+0000$/;

/** Формат и календарная корректность `POT-Creation-Date`. */
export function isValidPotDate(value: string): boolean {
  const m = POT_DATE_RX.exec(value);
  if (!m) return false;
  const [year, month, day, hour, min] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || min > 59) return false;
  const d = new Date(Date.UTC(year, month - 1, day, hour, min));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Разобрать поля заголовка (`Key: value` по строкам msgstr). */
export function headerFields(msgstr: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of msgstr.split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9-]*): ?(.*)$/.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const CONTROL_RX = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // eslint-disable-line no-control-regex -- дефект кодировки
const INVISIBLE_RX =
  /[\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufffd]/;

function invisibleChars(s: string): string[] {
  const found: string[] = [];
  for (const ch of s) {
    if (INVISIBLE_RX.test(ch) || CONTROL_RX.test(ch)) found.push(ch);
  }
  return found;
}

function checkHeader(
  parsed: ParsedPot,
  add: (
    invariant: number,
    code: string,
    severity: ViolationSeverity,
    where: string,
    detail: string,
  ) => void,
): boolean {
  const entries = parsed.entries;
  const first = entries[0];
  if (!first) {
    add(11, "empty-file", "error", "файл", "POT пуст: нет ни шапки, ни записей");
    return false;
  }
  if (first.fields.msgid?.value !== "") {
    add(
      11,
      "header-not-first",
      "error",
      "начало файла",
      'первый блок обязан быть шапкой `msgid ""`',
    );
    return false;
  }
  if (first.fields.msgctxt) {
    add(11, "header-has-msgctxt", "error", `строка ${first.line}`, "у шапки не бывает msgctxt");
  }
  const duplicates = entries.filter((e, i) => i > 0 && e.fields.msgid?.value === "");
  for (const dup of duplicates) {
    add(11, "header-duplicate", "error", `строка ${dup.line}`, 'второй `msgid ""` в файле');
  }

  const msgstr = first.fields.msgstr?.value;
  if (msgstr === undefined) {
    add(11, "header-no-msgstr", "error", `строка ${first.line}`, "у шапки нет msgstr");
    return false;
  }
  const fields = headerFields(msgstr);
  for (const name of REQUIRED_HEADER_FIELDS) {
    if (!fields.has(name)) {
      add(11, "header-field-missing", "error", `строка ${first.line}`, `нет поля ${name}`);
    }
  }
  const contentType = fields.get("Content-Type") ?? "";
  if (!/charset=UTF-8\b/.test(contentType)) {
    add(
      11,
      "header-charset",
      "error",
      `строка ${first.line}`,
      `Content-Type без charset=UTF-8: ${contentType}`,
    );
  }
  const encoding = fields.get("Content-Transfer-Encoding") ?? "";
  if (encoding !== "8bit") {
    add(
      11,
      "header-encoding",
      "error",
      `строка ${first.line}`,
      `ожидалось 8bit, получено ${encoding}`,
    );
  }
  const created = fields.get("POT-Creation-Date");
  if (created === undefined) {
    add(11, "header-date-missing", "error", `строка ${first.line}`, "нет POT-Creation-Date");
  } else if (!isValidPotDate(created)) {
    add(
      11,
      "header-date-invalid",
      "error",
      `строка ${first.line}`,
      `дата не по формату: ${created}`,
    );
  }
  if (!msgstr.endsWith("\n")) {
    add(
      11,
      "header-no-final-newline",
      "error",
      `строка ${first.line}`,
      "поля шапки не завершены \\n",
    );
  }
  return true;
}

function checkTemplateEntries(
  entries: RawEntry[],
  add: (
    invariant: number,
    code: string,
    severity: ViolationSeverity,
    where: string,
    detail: string,
  ) => void,
): void {
  for (const entry of entries) {
    if (entry.fields.msgid?.value === "") continue; // шапка проверяется отдельно
    if (entry.fields.msgstr === undefined) {
      add(8, "msgstr-missing", "error", address(entry), "у записи нет msgstr");
    } else if (entry.fields.msgstr.value !== "") {
      add(
        11,
        "template-msgstr-filled",
        "error",
        address(entry),
        `в шаблоне непустой msgstr: ${JSON.stringify(entry.fields.msgstr.value.slice(0, 60))}`,
      );
    }
  }
}

function checkEscaping(
  parsed: ParsedPot,
  headerOk: boolean,
  add: (
    invariant: number,
    code: string,
    severity: ViolationSeverity,
    where: string,
    detail: string,
  ) => void,
): void {
  for (const bad of parsed.syntax) {
    add(
      8,
      "syntax",
      "error",
      `строка ${bad.line}`,
      `${bad.reason}: ${JSON.stringify(bad.text.slice(0, 80))}`,
    );
  }

  for (const entry of parsed.entries) {
    // Шапка — единственное законное место многострочного поля и `# ` комментариев.
    const isHeader = entry.fields.msgid?.value === "";
    for (const name of FIELD_NAMES) {
      const f = entry.fields[name];
      if (!f) continue;
      if (f.lines > 1 && !isHeader) {
        add(
          8,
          "field-multiline",
          "error",
          `строка ${f.line}`,
          `${name} разбит на ${f.lines} строки — генератор пишет одной`,
        );
      }
      if (poEscape(f.value) !== f.raw && !(isHeader && name === "msgstr")) {
        add(
          8,
          "escape-noncanonical",
          "error",
          `строка ${f.line}`,
          `${name}: сырое ${JSON.stringify(f.raw.slice(0, 60))} ≠ канон ${JSON.stringify(poEscape(f.value).slice(0, 60))}`,
        );
      }
    }
    if (isHeader) continue;
    for (const ref of entry.refs)
      add(8, "refs", "error", address(entry), `#: refs не пишутся контрактом: ${ref.slice(0, 40)}`);
    if (entry.flags.length)
      add(8, "flags", "error", address(entry), `#, флаги не пишутся: ${entry.flags.join(", ")}`);
    if (entry.translator.length)
      add(8, "translator", "error", address(entry), "# комментарии переводчика не пишутся");
  }

  if (!headerOk || parsed.syntax.length) return;
  const body = parsed.entries.slice(1).map(toPoEntry);
  const normalized = parsed.text.replace(/\r\n|\r/g, "\n");
  const rendered = renderPo(body, parsed.headerLines);
  if (rendered !== normalized) {
    const a = normalized.split("\n");
    const b = rendered.split("\n");
    let line = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        line = i + 1;
        break;
      }
    }
    add(
      8,
      "roundtrip",
      "error",
      `строка ${line}`,
      `parse→render не восстанавливает файл: ${JSON.stringify(a[line - 1] ?? "")} ≠ ${JSON.stringify(b[line - 1] ?? "")}`,
    );
  }
  if (normalized.endsWith("\n\n") || !normalized.endsWith("\n")) {
    add(8, "trailing-newline", "error", "конец файла", "файл обязан кончаться ровно одним \\n");
  }
}

function checkUniqueness(
  entries: RawEntry[],
  add: (
    invariant: number,
    code: string,
    severity: ViolationSeverity,
    where: string,
    detail: string,
  ) => void,
): void {
  const seen = new Map<string, RawEntry>();
  for (const entry of entries) {
    const id = entry.fields.msgid?.value;
    if (id === undefined) continue;
    const key = potKey(id, entry.fields.msgctxt?.value ?? "");
    const prev = seen.get(key);
    if (prev) {
      add(5, "duplicate-key", "error", address(entry), `дубль пары с строкой ${prev.line}`);
    } else {
      seen.set(key, entry);
    }
  }
}

function checkOrder(
  entries: RawEntry[],
  add: (
    invariant: number,
    code: string,
    severity: ViolationSeverity,
    where: string,
    detail: string,
  ) => void,
): void {
  let prev: { id: string; ctxt: string } | null = null;
  for (const entry of entries) {
    const id = entry.fields.msgid?.value;
    if (id === undefined) continue;
    const cur = { id, ctxt: entry.fields.msgctxt?.value ?? "" };
    if (prev) {
      const cmp = compareCodePoints(prev.id, cur.id) || compareCodePoints(prev.ctxt, cur.ctxt);
      if (cmp > 0) {
        add(
          6,
          "unsorted",
          "error",
          address(entry),
          `порядок (msgid, msgctxt) нарушен: ${JSON.stringify([prev.id, prev.ctxt])} > ${JSON.stringify([cur.id, cur.ctxt])}`,
        );
      }
    }
    prev = cur;
  }
}

/**
 * Проверка вложенности TMP-тегов в `rich_text`.
 *
 * Зачем отдельно от подсчёта: `<i>…<color>…</color> </i></color>` даёт равное число
 * открытий и закрытий, но теги перекрещены — TMP рисует это непредсказуемо.
 * Проверено 2026-11-22: такой случай прошёл мимо проверки баланса, а линтер его нашёл.
 */
export function richNestingProblems(value: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  const rx = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g;
  const SELF_CLOSING = new Set(["br", "sprite", "quad", "page"]);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(value)) !== null) {
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (m[4] === "/" || SELF_CLOSING.has(name)) continue;
    if (!closing) {
      stack.push(name);
      continue;
    }
    if (stack.length === 0) {
      problems.push(`закрывающий </${name}> без открывающего`);
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== name) {
      problems.push(`перекрещенные теги: </${name}> закрывает <${top}>`);
      const idx = stack.lastIndexOf(name);
      if (idx >= 0) stack.length = idx;
      continue;
    }
    stack.pop();
  }
  if (stack.length) problems.push(`незакрытые теги: ${stack.map((n) => `<${n}>`).join(", ")}`);
  return problems;
}

function checkRichFormat(
  entries: RawEntry[],
  add: (
    invariant: number,
    code: string,
    severity: ViolationSeverity,
    where: string,
    detail: string,
  ) => void,
): Map<string, string> {
  const actual = new Map<string, string>();
  for (const entry of entries) {
    const id = entry.fields.msgid?.value;
    if (id === undefined) continue;
    const comments = entry.comments.filter((c) => c.text.startsWith("rich_text"));
    if (comments.length > 1) {
      add(7, "rich-duplicate", "error", address(entry), `несколько rich_text: ${comments.length}`);
    }
    for (const c of comments) {
      if (!c.text.startsWith("rich_text: ")) {
        add(
          7,
          "rich-syntax",
          "error",
          `строка ${c.line}`,
          `ожидалось "#. rich_text: …", получено ${JSON.stringify(c.text.slice(0, 60))}`,
        );
        continue;
      }
      const value = c.text.slice("rich_text: ".length);
      const key = potKey(id, entry.fields.msgctxt?.value ?? "");
      actual.set(key, value);
      if (!value.trim()) {
        add(7, "rich-empty", "error", `строка ${c.line}`, "rich_text пустой");
      }
      for (const problem of richNestingProblems(value)) {
        add(7, "rich-nesting", "error", `строка ${c.line}`, problem);
      }
      if (/<\/?(?:font|material)\b/i.test(value)) {
        add(
          7,
          "rich-font-tag",
          "error",
          `строка ${c.line}`,
          "<font>/<material> обязаны быть вырезаны",
        );
      }
      if (value === id) {
        add(
          7,
          "rich-equals-msgid",
          "error",
          `строка ${c.line}`,
          "rich_text совпадает с msgid — писать не нужно",
        );
      }
    }
  }
  return actual;
}

/**
 * Провенанс записи (`#. src: <метка>`) — инвариант 14.
 *
 * Метка обязательна и должна быть из фиксированного списка: `dialog`,
 * `bundle`, `settings`, `us`, `global`, `field:<ИмяПоля>`, `raw:<TypeName>`.
 * Список и смысл — `docs/pot-provenance.md`; произвольная метка запрещена,
 * иначе отчёт по провенансу перестаёт быть машинно-однозначным.
 */
function checkSrc(
  entries: RawEntry[],
  requireSrc: boolean,
  add: (
    invariant: number,
    code: string,
    severity: ViolationSeverity,
    where: string,
    detail: string,
  ) => void,
): Map<string, string> {
  const actual = new Map<string, string>();
  for (const entry of entries) {
    const id = entry.fields.msgid?.value;
    if (id === undefined) continue;
    const comments = entry.comments.filter((c) => c.text.startsWith("src"));
    const key = potKey(id, entry.fields.msgctxt?.value ?? "");
    if (comments.length > 1) {
      add(14, "src-duplicate", "error", address(entry), `несколько src: ${comments.length}`);
    }
    const found = comments.length > 0;
    if (!found) {
      if (requireSrc) {
        add(14, "src-missing", "error", address(entry), "нет `#. src:` (провенанс обязателен)");
      }
      continue;
    }
    const c = comments[0];
    if (!c.text.startsWith("src: ")) {
      add(
        14,
        "src-syntax",
        "error",
        `строка ${c.line}`,
        `ожидалось "#. src: …", получено ${JSON.stringify(c.text.slice(0, 60))}`,
      );
      continue;
    }
    const value = c.text.slice("src: ".length);
    if (!isValidSrc(value)) {
      add(
        14,
        "src-unknown",
        "error",
        `строка ${c.line}`,
        `метка вне фиксированного списка: ${JSON.stringify(value.slice(0, 60))}`,
      );
      continue;
    }
    actual.set(key, value);
  }
  return actual;
}

function checkEncoding(
  parsed: ParsedPot,
  sourceChars: Set<string> | null,
  add: (
    invariant: number,
    code: string,
    severity: ViolationSeverity,
    where: string,
    detail: string,
  ) => void,
): void {
  if (parsed.bom) add(10, "bom", "error", "начало файла", "UTF-8 BOM запрещён");
  if (parsed.crLines.length) {
    add(
      10,
      "crlf",
      "error",
      `строка ${parsed.crLines[0]}`,
      `CR/CRLF в ${parsed.crLines.length} строках — нужен LF`,
    );
  }

  const checkText = (value: string, where: string): void => {
    const bad = invisibleChars(value);
    if (!bad.length) return;
    const introduced = sourceChars ? bad.filter((ch) => !sourceChars.has(ch)) : bad;
    if (!introduced.length) return;
    const codes = [...new Set(introduced)].map(
      (ch) => `U+${ch.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`,
    );
    add(10, "invisible", "error", where, `невидимые/управляющие символы: ${codes.join(", ")}`);
  };

  for (const entry of parsed.entries) {
    for (const name of FIELD_NAMES) {
      const f = entry.fields[name];
      if (f) checkText(f.value, `строка ${f.line}`);
    }
    for (const c of entry.comments) checkText(c.text, `строка ${c.line}`);
  }
}

// ---------------------------------------------------------------------------
// Инварианты 1–4, 7, 9, 13 — сверка с дампом
// ---------------------------------------------------------------------------

const dateNormalize = (s: string): string =>
  s.replace(/^"POT-Creation-Date: .*$/m, '"POT-Creation-Date: <date>\\n"');

function keySet(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of parsePotText(text).entries) {
    const id = entry.fields.msgid?.value;
    if (id === undefined) continue;
    const key = potKey(id, entry.fields.msgctxt?.value ?? "");
    if (!out.has(key)) out.set(key, entry.line);
  }
  return out;
}

function checkAgainstDump(
  parsed: ParsedPot,
  potEntries: RawEntry[],
  actualRich: Map<string, string>,
  actualSrc: Map<string, string>,
  expected: Expected,
  opts: PotCheckOptions,
  add: (
    invariant: number,
    code: string,
    severity: ViolationSeverity,
    where: string,
    detail: string,
  ) => void,
): void {
  const potKeys = new Map<string, RawEntry>();
  for (const entry of potEntries) {
    const id = entry.fields.msgid?.value;
    if (id === undefined) continue;
    const key = potKey(id, entry.fields.msgctxt?.value ?? "");
    if (!potKeys.has(key)) potKeys.set(key, entry);
  }

  // 1. Детерминизм: порядок элементов дампа (порядок ФС) не меняет POT.
  // Единственное, что от него зависит, — выбор rich_text при конфликте
  // вариантов у одного ключа («первое вхождение побеждает»).
  const created = opts.created ?? CHECK_DATE;
  const includeSrc = opts.requireSrc !== false;
  const forward = renderPot(expected.catalog, created, { includeSrc });
  const { catalog: reversedCatalog } = buildCatalog([...expected.items].reverse());
  const backward = renderPot(reversedCatalog, created, { includeSrc });
  if (forward !== backward) {
    const reversedRich = richOf(reversedCatalog);
    const richDiff = [...expected.rich.keys()].filter(
      (k) => reversedRich.get(k) !== expected.rich.get(k),
    );
    // Метка `src` тоже «первое вхождение побеждает»: у строк, пришедших из
    // двух источников (dialog и bundle/raw), обратный порядок меняет метку.
    const reversedSrc = srcOf(reversedCatalog);
    const srcDiff = [...expected.src.keys()].filter(
      (k) => reversedSrc.get(k) !== expected.src.get(k),
    );
    const sample = richDiff
      .concat(srcDiff)
      .slice(0, 3)
      .map((k) => JSON.parse(k)[0]);
    add(
      1,
      "order-dependent",
      "warn",
      "дамп",
      `POT зависит от порядка элементов (rich ${richDiff.length}, src ${srcDiff.length}): ${sample
        .map((s) => JSON.stringify(s))
        .join(", ")}`,
    );
  }

  // 2. Идемпотентность: файл = перегенерация из этого дампа (кроме даты).
  const fileNorm = dateNormalize(parsed.text);
  const genNorm = dateNormalize(forward);
  if (fileNorm !== genNorm) {
    const fileKeys = keySet(parsed.text);
    const genKeys = keySet(forward);
    const missing = [...genKeys.keys()].filter((k) => !fileKeys.has(k));
    const extra = [...fileKeys.keys()].filter((k) => !genKeys.has(k));
    add(
      2,
      "stale",
      "error",
      "файл",
      `POT ≠ перегенерация: нет в файле ${missing.length}, лишних ${extra.length}` +
        `${missing.length ? `, пример ${JSON.stringify(JSON.parse(missing[0])[0])}` : ""}`,
    );
  }

  // 3. Полнота: каждая переводимая строка дампа есть в POT (или это ui-двойник).
  const missingItems: InventoryItem[] = [];
  for (const [key, item] of expected.keys) {
    if (potKeys.has(key) || expected.twinKeys.has(key)) continue;
    missingItems.push(item);
  }
  if (missingItems.length) {
    const sample = missingItems
      .slice(0, 3)
      .map((i) => `${i.kind}/${i.source}: ${JSON.stringify(i.text.slice(0, 40))}`);
    add(
      3,
      "missing-entry",
      "error",
      "дамп",
      `строк дампа нет в POT: ${missingItems.length}; ${sample.join("; ")}`,
    );
  }

  // 4. Нет выдуманного: каждый ключ POT выводится из дампа.
  const invented = [...potKeys.keys()].filter((k) => !expected.keys.has(k));
  if (invented.length) {
    const sample = invented.slice(0, 3).map((k) => JSON.stringify(JSON.parse(k)[0]));
    add(
      4,
      "invented-entry",
      "error",
      "POT",
      `ключей нет в дампе: ${invented.length}; ${sample.join(", ")}`,
    );
  }

  // 7. Rich: значение побайтово равно источнику (без <font>/<material>).
  for (const [key, want] of expected.rich) {
    const have = actualRich.get(key);
    if (have === undefined) {
      add(
        7,
        "rich-missing",
        "error",
        addressOf(potKeys.get(key)),
        `нет rich_text: ${JSON.stringify(want.slice(0, 60))}`,
      );
    } else if (have !== want) {
      add(
        7,
        "rich-mismatch",
        "error",
        addressOf(potKeys.get(key)),
        `rich_text ${JSON.stringify(have.slice(0, 60))} ≠ источник ${JSON.stringify(want.slice(0, 60))}`,
      );
    }
  }
  for (const [key, value] of actualRich) {
    if (!expected.rich.has(key)) {
      add(
        7,
        "rich-extra",
        "error",
        addressOf(potKeys.get(key)),
        `rich_text без источника: ${JSON.stringify(value.slice(0, 60))}`,
      );
    }
  }

  // 14. Провенанс: метка в POT равна метке генератора (путь доставки строки).
  for (const [key, want] of expected.src) {
    const have = actualSrc.get(key);
    if (have !== undefined && have !== want) {
      add(
        14,
        "src-mismatch",
        "error",
        addressOf(potKeys.get(key)),
        `src ${JSON.stringify(have)} ≠ источник ${JSON.stringify(want)}`,
      );
    }
  }

  // 9. Триаж: счётчики и учёт отброшенных строк.
  const expectedEntries = catalogSize(expected.catalog);
  if (potKeys.size !== expectedEntries) {
    add(
      9,
      "entry-count",
      "error",
      "POT",
      `записей ${potKeys.size}, по каталогу ${expectedEntries}`,
    );
  }
  for (const key of expected.twinKeys) {
    if (!potKeys.has(key)) continue;
    add(
      9,
      "ui-twin-leaked",
      "error",
      addressOf(potKeys.get(key)),
      "ui-двойник не удалён (двойной перевод)",
    );
  }
  const twinCount = [...expected.keys.keys()].filter((k) => expected.twinKeys.has(k)).length;
  if (expected.stats.mergedTwins !== twinCount) {
    add(
      9,
      "merged-twins-counter",
      "warn",
      "дамп",
      `счётчик mergedTwins=${expected.stats.mergedTwins}, фактически двойников ${twinCount}`,
    );
  }
  if (expected.stats.rich !== actualRich.size) {
    add(
      9,
      "rich-counter",
      "warn",
      "дамп",
      `счётчик rich=${expected.stats.rich}, в POT rich_text ${actualRich.size} (разница — rich у отброшенных двойников)`,
    );
  }
  const noise = [...potKeys.keys()].filter((k) => {
    const text = (JSON.parse(k) as [string, string])[0];
    return isAssetName(text) || isGarbageFragment(text);
  }).length;
  if (noise > 0) {
    add(
      9,
      "noise-entries",
      "warn",
      "POT",
      `шумовых записей ${noise} (имена ассетов/бинарные фрагменты) — см. задачи pot-noise-cleanup`,
    );
  }
  if (expected.duplicates !== expected.items.length - expected.keys.size) {
    add(
      9,
      "duplicate-accounting",
      "error",
      "дамп",
      `повторов ${expected.duplicates}, а разница items-unique = ${expected.items.length - expected.keys.size}`,
    );
  }
}

function addressOf(entry: RawEntry | undefined): string {
  return entry ? address(entry) : "нет записи";
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/** Проверить текст POT. См. `CheckPot` — то же, но с чтением файла. */
export async function checkPotText(text: string, opts: PotCheckOptions = {}): Promise<Violation[]> {
  const label = opts.label ?? "<text>";
  const parsed = parsePotText(text);
  const raw: Violation[] = [];
  const push = (
    invariant: number,
    code: string,
    severity: ViolationSeverity,
    where: string,
    detail: string,
  ): void => {
    raw.push({ invariant, code, severity, where: `${label}:${where}`, detail });
  };

  const headerOk = checkHeader(parsed, push);
  const entries = headerOk ? parsed.entries.slice(1) : parsed.entries;
  checkEscaping(parsed, headerOk, push);
  checkTemplateEntries(entries, push);
  checkUniqueness(entries, push);
  checkOrder(entries, push);
  const actualRich = checkRichFormat(entries, push);
  const actualSrc = checkSrc(entries, opts.requireSrc !== false, push);

  let sourceChars: Set<string> | null = null;
  if (opts.dumpPath) {
    if (!existsSync(opts.dumpPath)) {
      throw new Error(`dump not found: ${opts.dumpPath}`);
    }
    const expected = await buildExpected(opts.dumpPath);
    sourceChars = new Set<string>();
    for (const item of expected.items) {
      for (const ch of item.text + item.richText) {
        if (invisibleChars(ch).length) (sourceChars as Set<string>).add(ch);
      }
    }
    checkEncoding(parsed, sourceChars, push);
    checkAgainstDump(parsed, entries, actualRich, actualSrc, expected, opts, push);

    const ignored = await countIgnoredDumpLines(opts.dumpPath);
    if (ignored.ignored) {
      push(
        13,
        "dump-ignored-lines",
        "warn",
        opts.dumpPath,
        `датчик дампа: ${ignored.ignored} из ${ignored.total} строк не разобраны (молча пропущены); ${ignored.samples.join("; ")}`,
      );
    }
  } else {
    checkEncoding(parsed, null, push);
  }

  if (opts.parityPot) {
    if (!existsSync(opts.parityPot)) {
      push(12, "parity-missing", "error", opts.parityPot, "POT второй реализации не найден");
    } else {
      const other = readFileSync(opts.parityPot, "utf8");
      if (dateNormalize(other) !== dateNormalize(parsed.text)) {
        const a = keySet(parsed.text);
        const b = keySet(other);
        const onlyOther = [...b.keys()].filter((k) => !a.has(k)).length;
        const onlyThis = [...a.keys()].filter((k) => !b.has(k)).length;
        push(
          12,
          "parity-diff",
          "error",
          opts.parityPot,
          `POT реализаций различаются: только здесь ${onlyThis}, только там ${onlyOther} (длина ${parsed.text.length} vs ${other.length})`,
        );
      }
    }
  }

  return truncate(raw, opts.limit ?? 20);
}

/** Проверить POT-файл: 13 инвариантов контракта; `[]` = нарушений нет. */
export async function checkPot(potPath: string, opts: PotCheckOptions = {}): Promise<Violation[]> {
  if (!existsSync(potPath)) throw new Error(`POT not found: ${potPath}`);
  return checkPotText(readFileSync(potPath, "utf8"), { ...opts, label: opts.label ?? potPath });
}

/** Ограничить число нарушений на код, сохранив честное «+N ещё». */
function truncate(violations: Violation[], limit: number): Violation[] {
  if (limit <= 0) return violations;
  const totals = new Map<string, number>();
  for (const v of violations) {
    const key = `${v.invariant}/${v.code}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const shown = new Map<string, number>();
  const out: Violation[] = [];
  for (const v of violations) {
    const key = `${v.invariant}/${v.code}`;
    const n = shown.get(key) ?? 0;
    if (n < limit) {
      out.push(v);
      shown.set(key, n + 1);
    }
  }
  for (const [key, total] of totals) {
    if (total <= limit) continue;
    const [invariant, code] = key.split("/");
    const base = violations.find(
      (v) => v.invariant === Number(invariant) && v.code === code,
    ) as Violation;
    out.push({
      ...base,
      detail: `${base.detail} (+ещё ${total - limit} нарушений этого кода скрыто)`,
    });
  }
  return out;
}

export interface PotSummary {
  entries: number;
  rich: number;
  byCtxt: { ui: number; speaker: number; speakerName: number; other: number };
  headerDate: string | null;
}

/** Сводка по POT для отчёта (без интерпретаций). */
export function summarizePot(text: string): PotSummary {
  const parsed = parsePotText(text);
  const hasHeader = parsed.entries[0]?.fields.msgid?.value === "";
  const body = hasHeader ? parsed.entries.slice(1) : parsed.entries;
  const byCtxt = { ui: 0, speaker: 0, speakerName: 0, other: 0 };
  let rich = 0;
  for (const entry of body) {
    const ctxt = entry.fields.msgctxt?.value ?? "";
    if (ctxt === "ui") byCtxt.ui += 1;
    else if (ctxt === "speaker-name") byCtxt.speakerName += 1;
    else if (ctxt.startsWith("speaker:")) byCtxt.speaker += 1;
    else byCtxt.other += 1;
    rich += entry.comments.filter((c) => c.text.startsWith("rich_text: ")).length;
  }
  const header = parsed.entries[0]?.fields.msgstr?.value ?? "";
  return {
    entries: body.length,
    rich,
    byCtxt,
    headerDate: headerFields(header).get("POT-Creation-Date") ?? null,
  };
}

/** Человекочитаемый отчёт для CLI. */
export function formatViolations(violations: Violation[]): string {
  const errors = violations.filter((v) => v.severity === "error").length;
  const warns = violations.length - errors;
  const lines = [`нарушений: ${errors} ошибок, ${warns} предупреждений`];
  for (const v of violations) {
    lines.push(
      `  [${v.invariant} ${INVARIANTS[v.invariant] ?? "?"}][${v.severity}] ${v.code}: ${v.where}`,
    );
    lines.push(`      ${v.detail}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node pot_invariants.mts [pot] [--dump <dir>] [--parity <pot>] [--strict] [--json]

  pot             путь к POT (по умолчанию po/template.pot)
  --dump <dir>    сверять с дампом (полнота, выдуманное, rich, счётчики)
  --parity <pot>  POT второй реализации — инвариант 12 (побайтово, кроме даты)
  --strict        ненулевой код и на предупреждениях
  --json          машинный вывод
  -h, --help      справка`;

interface Cli {
  pot: string;
  dumpPath?: string;
  parityPot?: string;
  strict: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { pot: POT_PATH, strict: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dump" || arg === "--parity") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} требует путь`);
      i += 1;
      if (arg === "--dump") cli.dumpPath = value;
      else cli.parityPot = value;
    } else if (arg.startsWith("--dump=")) cli.dumpPath = arg.slice("--dump=".length);
    else if (arg.startsWith("--parity=")) cli.parityPot = arg.slice("--parity=".length);
    else if (arg === "--strict") cli.strict = true;
    else if (arg === "--json") cli.json = true;
    else if (arg === "--help" || arg === "-h") cli.help = true;
    else if (arg.startsWith("-")) throw new Error(`неизвестный флаг: ${arg}`);
    else cli.pot = arg;
  }
  return cli;
}

export async function main(argv: string[]): Promise<number> {
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
    const violations = await checkPot(cli.pot, cli);
    const summary = summarizePot(readFileSync(cli.pot, "utf8"));
    if (cli.json) {
      console.log(JSON.stringify({ pot: cli.pot, summary, violations }, null, 2));
    } else {
      const c = summary.byCtxt;
      console.log(`POT: ${cli.pot}`);
      console.log(
        `  записей: ${summary.entries} (rich: ${summary.rich}); контексты: ui ${c.ui}, ` +
          `speaker:* ${c.speaker}, speaker-name ${c.speakerName}, прочие ${c.other}`,
      );
      if (cli.dumpPath) console.log(`  дамп: ${cli.dumpPath}`);
      console.log(`  ${formatViolations(violations)}`);
    }
    const errors = violations.filter((v) => v.severity === "error").length;
    return errors || (cli.strict && violations.length) ? 1 : 0;
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 2;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
