/**
 * inventory.mts — инвентарь переводимых строк из дампа Unity-ассетов.
 *
 * Порт «читающей» половины `extract-text/scripts/extractor.py` (поведение 1:1):
 * JSONL-дамп → плоский список строк с контекстом. YAML-писатель `extractor.py`
 * НЕ портируется (дерево `translations/` удалено), поэтому `_auto_triage` тоже
 * не нужен: он влиял только на YAML и статистику, а не на состав POT.
 *
 * Контракт элемента повторяет `scan_dump()` из `potgen.py`:
 *   {text, speaker, richText, kind, source, idx}
 * kind: dlg (ANToolkit dialogues), bundle (PlayMaker line_X),
 *       spk (имя персонажа), set (settings_keys.display),
 *       raw (UI-строки raw_strings), fsm (FSM-переменные).
 *
 * Дамп читается потоково (createReadStream + readline): 319 МБ в память
 * не грузятся. Разбор строки — `JSON.parse`, битые строки пропускаются
 * (как `iter_jsonl_objects`).
 *
 * Особенность: `path_id` — 64-битный Unity-хэш. `JSON.parse` округляет
 * числа > 2^53, поэтому идентификатор берётся из сырой строки регуляркой
 * и сравнивается как BigInt (в дампе есть 22 таких pid с диалогами).
 */
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  KNOWN_NON_SPEAKERS,
  isSkipPrefix,
  stripRich,
} from "../../pipeline-common/scripts/text_filters.mts";

/** Виды источника строки (совпадают с kind из potgen.py). */
export type ItemKind = "dlg" | "bundle" | "spk" | "set" | "raw" | "fsm";

/** Одна строка инвентаря: ровно то, что читает `ctxt_of`/`render` в potgen. */
export interface InventoryItem {
  text: string;
  speaker: string;
  richText: string;
  kind: ItemKind;
  source: string;
  idx: number | null;
}

export interface InventoryStats {
  chunkFiles: number;
  summaryFiles: number;
}

export interface Inventory {
  items: InventoryItem[];
  stats: InventoryStats;
}

/** Строка дампа: объект JSONL (полей много, читаем только нужные). */
export type DumpRow = Record<string, unknown>;

interface DialogueEntry {
  text: string;
  speaker: string;
  richText: string;
}

interface PidGroup {
  pid: bigint;
  entries: DialogueEntry[];
}

// ---------------------------------------------------------------------------
// Python-совместимые строковые примитивы.
//
// Это не педантизм: POT сверяется байт-в-байт, а `str.strip()`/`isupper()`/
// `isalpha()` в CPython работают по Unicode-свойствам, которые JS-trim и
// JS-регистр покрывают не полностью (BOM, NEL, астральные символы).
// ---------------------------------------------------------------------------

/** Пробелы Python `str.strip()` (Unicode White_Space; BOM сюда НЕ входит). */
const PY_WS_RX =
  // eslint-disable-next-line no-control-regex -- \u001c-\u001f/\u0085 — пробелы в Python
  /^[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** `str.strip()` без аргументов. */
export function pyStrip(s: string): string {
  return s.replace(PY_WS_RX, "");
}

/** Длина в code points (Python `len`), а не в UTF-16 units. */
function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** Python `str.isalpha()` — свойство Alphabetic. */
function pyIsAlpha(s: string): boolean {
  return /^\p{Alphabetic}+$/u.test(s);
}

/** Python `str.isupper()` для одного символа. */
function pyIsUpperChar(ch: string): boolean {
  return /\p{Uppercase}/u.test(ch);
}

/** Python `str.islower()` для одного символа. */
function pyIsLowerChar(ch: string): boolean {
  return /\p{Lowercase}/u.test(ch);
}

/** Python `str.isupper()` для строки: есть заглавные, строчных нет. */
function pyIsUpper(s: string): boolean {
  let hasUpper = false;
  for (const ch of s) {
    if (pyIsLowerChar(ch)) return false;
    if (pyIsUpperChar(ch)) hasUpper = true;
  }
  return hasUpper;
}

/** Сравнение строк по code points (порядок Python `str`, не UTF-16). */
export function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): DumpRow | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as DumpRow) : null;
}

// ---------------------------------------------------------------------------
// Фильтры extractor.py
// ---------------------------------------------------------------------------

/** `_BUNDLE_HASH_RX`: убирает переменный хвост имени бандла. */
const BUNDLE_HASH_RX = /_(?:assets|scenes)_all_[a-f0-9]+$/;

/** Короткое стабильное имя бандла (без хэша). */
export function bundleShortName(assetName: string): string {
  return assetName.replace(BUNDLE_HASH_RX, "");
}

/** `_NAMED_COLOR_RX`: `<color=perversion>` (Python `\w` — Unicode). */
const NAMED_COLOR_RX = /<color=([\p{L}\p{N}_]+)>/gu;

/** `_resolve_named_colors`: имена цветов → hex из `color_parser_list`. */
export function resolveNamedColors(s: string, colors: ReadonlyMap<string, string>): string {
  return s.replace(NAMED_COLOR_RX, (m, name: string) => {
    const hex = colors.get(name);
    return hex === undefined ? m : `<color=${hex}>`;
  });
}

/** Паттерны отладочного/технического текста из `_is_ui_string`. */
const CODE_PATTERNS = [
  "must be",
  "is out of",
  "is not ",
  "cannot ",
  "doesn't",
  "don't ",
  "not found",
  "not initialized",
  "not null",
  "is null",
  "is empty",
  "must not",
  "is bigger",
  "is smaller",
  "is invalid",
  "is unknown",
  "size of",
  "count is",
  "range of",
  "index ",
  "array",
  "function ",
  "parameter",
  "argument",
  "exception",
  "error:",
  "warning:",
  "origins",
  "handles",
  "properties",
  "serializ",
  "deserializ",
  "callback",
  "steam",
  "unity ",
] as const;

const ASSET_STATES = new Set([
  "Normal",
  "Highlighted",
  "Pressed",
  "Selected",
  "Disabled",
  "Active",
]);
const UI_REJECT_NAMES = new Set(["FSM", "FSMs", "GUID", "Data"]);

/**
 * Похоже ли `raw_string` на UI-лейбл (`_is_ui_string`, 1:1).
 *
 * Строгий фильтр от Steamworks/Unity-шума; киберпанк-текст (█ ▓ ▒ ░)
 * остаётся, если проходит шаблоны.
 */
export function isUiString(s: string): boolean {
  const len = cpLen(s);
  // Границы UI-лейбла: 2..50 code points. Верхняя граница — историческая
  // защита от Steamworks/Unity-шума; цена фиксирована осознанно: описания
  // предметов и квестов длиннее 50 символов в POT не попадают.
  // Список пробелов и приёмка — tasks/2026-11-21-pot-coverage-gaps.md.
  if (!s || len < 2 || len > 50) return false;

  const chars = [...s];
  // Свойства шейдеров/Unity: подчёркивание + заглавная.
  if (s.startsWith("_") && len > 2 && pyIsUpperChar(chars[1])) return false;
  // GUID и чистый hex.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(s)) return false;
  if (/^[0-9a-fA-F]+$/.test(s) && len > 6) return false;
  // Отладочные сообщения.
  const lower = s.toLowerCase();
  for (const pat of CODE_PATTERNS) {
    if (lower.includes(pat)) return false;
  }
  // C#-имена полей с точками (Namespace.Field, Base Layer.Idle).
  // ВНИМАНИЕ: эвристика срабатывает на ЛЮБУЮ строку с точкой, где среди
  // первых 5 code points есть заглавная, — то есть и на обычное предложение
  // («Yeah. Looks like it.»). Диалоги это не задевает (они приходят из
  // dialogues/fsm_strings), но raw-строки сцен с точками теряются:
  // ~459 предложений, tasks/2026-11-21-pot-coverage-gaps.md.
  if (s.includes(".") && [...s.split(".")[0]].slice(0, 5).some(pyIsUpperChar)) return false;
  if (s.includes("<") || s.includes(">")) return false;
  if (s.includes("{") || s.includes("}")) return false;
  if (s.includes("(") && s.includes(")")) return false;
  // Пути и файлы.
  if (s.startsWith("actions/") || s.startsWith("expressions/") || s.startsWith("Textures/")) {
    return false;
  }
  if (s.includes("/") && s.includes("\\")) return false;
  if (s.endsWith(".cs") || s.endsWith(".dll") || s.endsWith(".json")) return false;
  // Имена состояний анимаций/ассетов.
  if (ASSET_STATES.has(s)) return false;

  // ALL CAPS с гласными = кнопка (BACK, HIDE, SKIP, LOG, OPTIONS).
  if (pyIsUpper(s) && len >= 2 && len <= 25) return [..."AEIOU"].some((v) => s.includes(v));
  // Многословный лейбл (New Game, Dialogue Log, LOAD GAME).
  if (s.includes(" ")) return true;
  // Короткий PascalCase без пробела (Back, Continue, Skip, Resume).
  if (pyIsUpperChar(chars[0]) && chars.slice(1).some(pyIsLowerChar) && len >= 2 && len <= 15) {
    return !UI_REJECT_NAMES.has(s);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Аккумулятор: один проход по дампу собирает всё, что нужно potgen.
// ---------------------------------------------------------------------------

/** Верхнеуровневый `path_id` из сырой строки (BigInt-точность). */
const PID_RX = /(?<!\\)"path_id"\s*:\s*(-?\d+)/;

function pathIdOf(rawLine: string, obj: DumpRow): { raw: string; value: bigint } | null {
  if (!("path_id" in obj)) return null;
  const m = PID_RX.exec(rawLine);
  if (m) {
    const value = BigInt(m[1]);
    return { raw: value.toString(), value };
  }
  const v = obj.path_id;
  if (typeof v === "number" && Number.isFinite(v)) return { raw: String(v), value: BigInt(v) };
  return null;
}

function dedupeKey(text: string, speaker: string): string {
  return JSON.stringify([text, speaker]);
}

/** Накопитель строк дампа. Тесты кормят его объектами напрямую. */
export class DumpScanner {
  private readonly dialogues = new Map<string, PidGroup>();
  private readonly bundles = new Map<string, DialogueEntry[]>();
  private readonly bundleSeen = new Set<string>();
  private readonly settings = new Map<string, string[]>();
  private readonly chunkUi = new Map<string, string[]>();
  private readonly uiLocalSeen = new Map<string, Set<string>>();
  private readonly uiGlobalSeen = new Set<string>();
  private readonly fsm = new Map<string, string[]>();
  private readonly fsmLocalSeen = new Map<string, Set<string>>();
  private readonly fsmGlobalSeen = new Set<string>();
  private readonly colors = new Map<string, string>();

  /** Одна строка чанка (`level*.jsonl`, `bundle_*.jsonl`, `resources.jsonl`). */
  addChunkRow(obj: DumpRow, rawLine: string): void {
    this.collectColors(obj);
    this.collectDialogues(obj, rawLine);
    this.collectBundle(obj);
    this.collectChunkUi(obj);
    this.collectFsm(obj);
  }

  /** Одна строка `summaries.jsonl` (`stem` — имя ассета из строки). */
  addSummaryRow(obj: DumpRow, stem: string): void {
    const seen = new Set<string>();
    const entries: string[] = [];
    for (const raw of asArray(obj.settings_keys)) {
      const sk = asRecord(raw);
      if (!sk) continue;
      // Python: display.strip().strip("\x00") — сначала пробелы, затем NUL.
      // eslint-disable-next-line no-control-regex -- NUL-обрезка как в extractor.py
      const text = pyStrip(asString(sk.display)).replace(/^\u0000+|\u0000+$/g, "");
      if (!text || seen.has(text) || text.includes("\u0000")) continue;
      seen.add(text);
      entries.push(text);
    }
    if (entries.length) this.settings.set(stem, entries);
  }

  /** Собрать итоговый инвентарь в порядке `scan_dump()` из potgen.py.
   *
   * `stats` здесь — заглушка: реальные счётчики файлов проставляет `scanDump`
   * после обхода (тесты кормят сканер объектами напрямую и статистика им
   * не нужна). Не читать `stats` у результата `finish()` без `scanDump`.
   */
  finish(): Inventory {
    const items: InventoryItem[] = [];

    const pidGroups = [...this.dialogues.values()].sort((a, b) =>
      a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0,
    );
    for (const group of pidGroups) {
      group.entries.forEach((e, idx) => {
        items.push({
          text: e.text,
          speaker: e.speaker,
          richText: resolveNamedColors(e.richText, this.colors),
          kind: "dlg",
          source: group.pid.toString(),
          idx,
        });
      });
    }

    for (const asset of [...this.bundles.keys()].sort(compareCodePoints)) {
      const entries = this.bundles.get(asset) as DialogueEntry[];
      entries.forEach((e, idx) => {
        items.push({
          text: e.text,
          speaker: e.speaker,
          richText: resolveNamedColors(e.richText, this.colors),
          kind: "bundle",
          source: bundleShortName(asset),
          idx,
        });
      });
    }

    // Спикеры: порядок первого появления среди диалогов, затем бандлов.
    const seenSpeakers = new Set<string>();
    const speakers: string[] = [];
    const groups: DialogueEntry[][] = [...this.dialogues.values()].map((g) => g.entries);
    for (const group of [...groups, ...this.bundles.values()]) {
      for (const e of group) {
        const sp = pyStrip(e.speaker);
        if (sp && !seenSpeakers.has(sp)) {
          seenSpeakers.add(sp);
          speakers.push(sp);
        }
      }
    }
    for (const sp of speakers) {
      items.push({
        text: sp,
        speaker: "",
        richText: "",
        kind: "spk",
        source: sp,
        idx: null,
      });
    }

    for (const source of [...this.settings.keys()].sort(compareCodePoints)) {
      (this.settings.get(source) as string[]).forEach((text, idx) => {
        items.push({ text, speaker: "", richText: "", kind: "set", source, idx });
      });
    }

    for (const asset of [...this.chunkUi.keys()].sort(compareCodePoints)) {
      const entries = this.chunkUi.get(asset) as string[];
      entries.forEach((text, idx) => {
        items.push({ text, speaker: "", richText: "", kind: "raw", source: asset, idx });
      });
    }

    for (const asset of [...this.fsm.keys()].sort(compareCodePoints)) {
      const entries = this.fsm.get(asset) as string[];
      entries.forEach((text, idx) => {
        items.push({ text, speaker: "", richText: "", kind: "fsm", source: asset, idx });
      });
    }

    return { items, stats: { chunkFiles: 0, summaryFiles: 0 } };
  }

  private collectColors(obj: DumpRow): void {
    const cpl = asRecord(obj.color_parser_list);
    if (!cpl) return;
    for (const [name, hex] of Object.entries(cpl)) {
      if (typeof hex === "string") this.colors.set(name, hex);
    }
  }

  private collectDialogues(obj: DumpRow, rawLine: string): void {
    const raw = asArray(obj.dialogues);
    if (!raw.length) return;
    const pid = pathIdOf(rawLine, obj);
    if (!pid) return;

    let group = this.dialogues.get(pid.raw);
    if (!group) {
      group = { pid: pid.value, entries: [] };
      this.dialogues.set(pid.raw, group);
    }

    // `seen` в extractor.py живёт в пределах ОДНОГО объекта дампа:
    // одинаковые (text, speaker) в разных строках одного path_id не дедупятся.
    const seen = new Set<string>();
    for (const rawEntry of raw) {
      const d = asRecord(rawEntry);
      if (!d) continue;
      const text = pyStrip(asString(d.text));
      if (!text) continue;
      const speaker = pyStrip(asString(d.speaker));
      const key = dedupeKey(text, speaker);
      if (seen.has(key)) continue;
      seen.add(key);
      group.entries.push({ text, speaker, richText: pyStrip(asString(d.rich_text)) });
    }
  }

  private collectBundle(obj: DumpRow): void {
    const asset = asString(obj.asset);
    if (!asset.startsWith("bundle_")) return;
    let entries = this.bundles.get(asset);
    if (!entries) {
      entries = [];
      this.bundles.set(asset, entries);
    }

    const all = asArray(obj.raw_strings);
    if (!all.length) return;
    const rs = all.filter((s): s is string => typeof s === "string");
    // Признак PlayMaker-бандла: в raw есть ключи line_X. Арт/аудио-бандлы
    // отсекаются здесь, иначе их имена попали бы в POT как диалоги.
    if (!rs.some((s) => s.startsWith("line_"))) return;

    const strings = asRecord(obj.strings);
    const objName = strings ? asString(strings.m_Name) : "";

    let i = 0;
    while (i < rs.length) {
      const s = pyStrip(rs[i]);

      if (isSkipPrefix(s) || s === objName) {
        i += 1;
        continue;
      }
      if (cpLen(s) <= 3 || !s.includes(" ")) {
        i += 1;
        continue;
      }
      if (s.startsWith("{") || s.startsWith("[")) {
        i += 1;
        continue;
      }

      const clean = stripRich(s);
      if (!clean || cpLen(clean) < 4) {
        i += 1;
        continue;
      }

      // rich_text — исходная строка с тегами (в potgen.py — если s != clean).
      const richText = s !== clean ? s : "";

      let speaker = "";
      if (i + 1 < rs.length) {
        const ns = pyStrip(rs[i + 1]);
        const first = [...ns][0] ?? "";
        if (
          ns &&
          !isSkipPrefix(ns) &&
          !ns.startsWith("line_") &&
          ns !== objName &&
          !ns.includes(" ") &&
          pyIsUpperChar(first) &&
          pyIsAlpha(ns) &&
          !KNOWN_NON_SPEAKERS.has(ns)
        ) {
          speaker = ns;
          i += 1;
        }
      }

      const key = dedupeKey(clean, speaker);
      if (!this.bundleSeen.has(key)) {
        this.bundleSeen.add(key);
        entries.push({ text: clean, speaker, richText });
      }
      i += 1;
    }
  }

  private collectChunkUi(obj: DumpRow): void {
    const asset = asString(obj.asset) || "unknown";
    let local = this.uiLocalSeen.get(asset);
    if (!local) {
      local = new Set();
      this.uiLocalSeen.set(asset, local);
    }
    let entries = this.chunkUi.get(asset);
    if (!entries) {
      entries = [];
      this.chunkUi.set(asset, entries);
    }

    // Дедуп глобальный (на весь дамп): один и тот же лейбл из разных сцен
    // даёт одну запись. Для перевода это верно (текст один), но `source`
    // останется первым ассетом, где строка встретилась.
    for (const raw of asArray(obj.raw_strings)) {
      if (typeof raw !== "string") continue;
      const s = pyStrip(raw);
      if (!s || local.has(s) || this.uiGlobalSeen.has(s) || s.includes("\u0000")) continue;
      if (!isUiString(s)) continue;
      local.add(s);
      this.uiGlobalSeen.add(s);
      entries.push(s);
    }
  }

  private collectFsm(obj: DumpRow): void {
    const asset = asString(obj.asset) || "unknown";
    let local = this.fsmLocalSeen.get(asset);
    if (!local) {
      local = new Set();
      this.fsmLocalSeen.set(asset, local);
    }
    let entries = this.fsm.get(asset);
    if (!entries) {
      entries = [];
      this.fsm.set(asset, entries);
    }

    for (const raw of asArray(obj.fsm_strings)) {
      const s = typeof raw === "string" ? pyStrip(raw) : "";
      if (!s || local.has(s) || this.fsmGlobalSeen.has(s) || s.includes("\u0000")) continue;
      local.add(s);
      this.fsmGlobalSeen.add(s);
      entries.push(s);
    }
  }
}

// ---------------------------------------------------------------------------
// Файловый слой
// ---------------------------------------------------------------------------

/** Имена файлов в порядке обхода: без регистра (Windows), ничьи — по code points.
 *
 * Это НЕ `sorted()` Python для смешанного регистра (`B.jsonl` < `a.jsonl`
 * в Python), а порядок как у файловой системы Windows. Важно только для
 * «первое вхождение побеждает» (дедуп бандлов, порядок спикеров); на реальном
 * дампе POT совпадает с Python-версией байт-в-байт (проверено 2026-11-21).
 */
function compareFileNames(a: string, b: string): number {
  const na = a.toLowerCase();
  const nb = b.toLowerCase();
  if (na !== nb) return na < nb ? -1 : 1;
  return compareCodePoints(a, b);
}

/** Все JSONL-чанки: `<dump>/*.jsonl` без `summaries.jsonl`. */
export function findChunks(dumpDir: string): string[] {
  const names = readdirSync(dumpDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".jsonl") && d.name !== "summaries.jsonl")
    .map((d) => d.name)
    .sort(compareFileNames);
  return names.map((n) => join(dumpDir, n));
}

/** `summaries.jsonl`, если есть. */
export function findSummaries(dumpDir: string): string[] {
  const path = join(dumpDir, "summaries.jsonl");
  return existsSync(path) ? [path] : [];
}

/** Потоковый итератор объектов JSONL (битые строки молча пропускаются). */
export async function* readJsonl(fp: string): AsyncGenerator<{ obj: DumpRow; line: string }> {
  const input = createReadStream(fp, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        const obj = asRecord(parsed);
        if (obj) yield { obj, line };
      } catch {
        // Как iter_jsonl_objects: обрезанную/битую строку пропускаем.
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }
}

/** Прочитать дамп целиком (потоково) и собрать инвентарь. */
export async function scanDump(dumpDir: string): Promise<Inventory> {
  if (!existsSync(dumpDir)) {
    throw new Error(`dump not found: ${dumpDir} (сначала запусти dump-assets)`);
  }

  const chunks = findChunks(dumpDir);
  const summaries = findSummaries(dumpDir);
  const scanner = new DumpScanner();

  for (const fp of chunks) {
    for await (const { obj, line } of readJsonl(fp)) scanner.addChunkRow(obj, line);
  }
  for (const fp of summaries) {
    for await (const { obj } of readJsonl(fp)) {
      const asset = obj.asset;
      scanner.addSummaryRow(obj, typeof asset === "string" ? asset : "summaries");
    }
  }

  const inventory = scanner.finish();
  inventory.stats = { chunkFiles: chunks.length, summaryFiles: summaries.length };
  return inventory;
}
