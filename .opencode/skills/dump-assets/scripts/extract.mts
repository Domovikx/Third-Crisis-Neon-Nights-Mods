/**
 * extract.mts — один объект Unity → строка JSONL (контракт Python-эталона).
 *
 * Логика повторяет `extract_object` из `dump_assets.py`:
 *   1. raw-сканы (dialogues, raw_strings, color_parser_list) — работают всегда;
 *   2. типизированные поля (`strings`, `fields`, `fsm_strings`) — только если
 *      в файле есть type tree. В бандлах он есть (107/107), в `*.assets` — нет,
 *      и там эталон тоже спотыкается на MonoBehaviour (`read_failed`; UnityPy
 *      вытягивает встроенные классы из своей базы typetree, мы этого не
 *      повторяем — для POT это не важно, см. MAP.md).
 *
 * Порядок ключей строки: `path_id, type[, error][, color_parser_list][, strings]
 * [, fields][, dialogues][, fsm_strings][, raw_strings]` — как в эталоне.
 */

import type { Endian } from "./binary.mts";
import { PyFloat, readObjectTypetree, type TypeTreeNode } from "./typetree.mts";
import { unityClassName } from "./unity_classes.mts";
import { cpLen, pySlice, pyStrip } from "./pystr.mts";
import {
  parseColorParserList,
  parseDialogueFromRaw,
  parsePlaymakerDialogues,
  type PlaymakerDialogue,
  type RawDialogue,
  scanRawStrings,
} from "./rawscan.mts";
import type { SerializedObject } from "./serialized.mts";
import { capList, type TruncationBucket, type TruncationReport } from "./truncation.mts";

/** Поля обёрток UnityPy, которые эталон пропускает (`SKIP_ATTRS`). */
const SKIP_ATTRS = new Set([
  "assets_file",
  "object_reader",
  "container",
  "files",
  "objects",
  "resources",
  "m_GameObject",
  "m_Script",
  "m_Mesh",
  "m_Material",
  "m_Texture",
]);

const MAX_STRING_LEN = 500;

/** Бакет-заглушка: прямой вызов `extractObject` без общего отчёта прогона. */
const THROWAWAY_BUCKET: TruncationBucket = { units: 0, dropped: 0, limit: null };

/**
 * Ограничения извлечения.
 *
 * `rawStringLimit` — необязательный лимит строк `raw_strings` на объект.
 * По умолчанию `null` (без лимита): хвост raw-скана нужен инвентарю, иначе
 * текст теряется ДО фильтров (аудит POT 2026-11-22 — 2.94 млн отброшенных
 * строк у 1 768 объектов). Если лимит задан, обрезка считается в
 * `truncation.rawStrings` и печатается в конце прогона.
 */
export interface ExtractOptions {
  rawStringLimit?: number | null;
  /** Общий счётчик прогона (нужен, только если задан лимит). */
  truncation?: TruncationReport;
}

/**
 * Готовые сырые сканы объекта (от другого исполнителя, например Rust).
 *
 * Ровно то, что даёт байтовый уровень: тексты raw-строк, пары Speaker/Text и
 * ColorParserList. PlayMaker-часть (`line_X`) сюда НЕ входит — это правило
 * извлечения, оно остаётся в `extractObject`.
 */
export interface RawScans {
  rawTexts: string[];
  dialogues: RawDialogue[];
  colors: Record<string, string> | null;
}

/** Строка дампа: поля появляются по мере разбора (как в эталоне). */
export interface DumpObjectRow {
  path_id: bigint;
  type: string;
  error?: string;
  color_parser_list?: Record<string, string>;
  strings?: Record<string, string>;
  fields?: Record<string, unknown>;
  dialogues?: Array<RawDialogue | PlaymakerDialogue>;
  fsm_strings?: string[];
  raw_strings?: string[];
}

/** PPtr в JSONL: `file_id`/`path_id` (как `pptr_to_dict`). */
interface PPtrJson {
  file_id: number;
  path_id: bigint;
}

function isPptrDict(value: unknown): value is { m_FileID: unknown; m_PathID: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 2) return false;
  return keys.includes("m_FileID") && keys.includes("m_PathID");
}

function pptrToJson(value: { m_FileID: unknown; m_PathID: unknown }): PPtrJson {
  return {
    file_id: typeof value.m_FileID === "number" ? value.m_FileID : Number(value.m_FileID ?? 0),
    path_id:
      typeof value.m_PathID === "bigint" ? value.m_PathID : BigInt(Number(value.m_PathID ?? 0)),
  };
}

/** Элемент массива пригоден для `fields`? (порт `_serialize_list`). */
function serializeList(value: unknown[]): unknown[] | null {
  if (value.length === 0) return [];
  const first = value[0];
  const firstKind = typeof first;
  if (firstKind === "string" || firstKind === "number" || firstKind === "boolean") return value;
  if (typeof first === "bigint") return value;
  if (first instanceof PyFloat) return value;
  if (isPptrDict(first)) return value.map((item) => (isPptrDict(item) ? pptrToJson(item) : item));
  return null;
}

/** Разложить типизированный объект на `strings`/`fields` (+ признак FSM). */
export function collectTypedFields(typed: Record<string, unknown>): {
  strings: Record<string, string>;
  fields: Record<string, unknown>;
  isFsm: boolean;
  /** Сколько строковых значений срезано по `MAX_STRING_LEN` (для отчёта). */
  cutValues: number;
} {
  const strings: Record<string, string> = {};
  const fields: Record<string, unknown> = {};
  let cutValues = 0;

  const keys = Object.keys(typed).sort();
  for (const key of keys) {
    if (key.startsWith("_") || SKIP_ATTRS.has(key)) continue;
    const value = typed[key];
    if (value === undefined || value === null) continue;

    if (typeof value === "string") {
      if (!value) continue;
      if (cpLen(value) > MAX_STRING_LEN) cutValues += 1;
      strings[key] = pySlice(value, MAX_STRING_LEN);
      continue;
    }
    if (isPptrDict(value)) {
      fields[key] = pptrToJson(value);
      continue;
    }
    if (Array.isArray(value)) {
      const items = serializeList(value);
      if (items !== null) fields[key] = items;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      fields[key] = value;
      continue;
    }
    if (value instanceof PyFloat) {
      fields[key] = value;
      continue;
    }
    // Вложенные структуры и сырые байты эталон в JSONL не пишет.
  }

  return { strings, fields, isFsm: Object.hasOwn(typed, "fsm"), cutValues };
}

/**
 * Видимые UI-строки PlayMaker FSM (порт `parse_fsm_strings`).
 *
 * Ходим по всему дереву объекта: берём строки из `value` (если у узла нет
 * `useVariable`) и из `stringParams`. Имена стейтов, slash-пути переменных
 * и `line_*` отбрасываются — это идентификаторы, а не текст.
 *
 * Лимита на количество нет: по корпусу максимум — 11 строк на объект, а
 * исторический обрез `[:500]` был ещё одним тихим местом потери.
 */
export function parseFsmStrings(typed: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const s = pyStrip(raw);
    if (cpLen(s) < 2 || seen.has(s)) return;
    if (/[\p{L}\p{N}_]\/[\p{L}\p{N}_]/u.test(s)) return;
    if (s.startsWith("line_")) return;
    seen.add(s);
    out.push(s);
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const value = record.value;
    if (typeof value === "string" && !record.useVariable) add(value);
    const params = record.stringParams;
    if (Array.isArray(params)) for (const param of params) add(param);
    for (const child of Object.values(record)) walk(child);
  };

  walk(typed);
  return out;
}

/**
 * Извлечь одну строку JSONL из объекта.
 *
 * `tree` — разобранный type tree для типа объекта (или null, если тип
 * без дерева: тогда типизированная часть помечается `read_failed`).
 *
 * `scans` — готовые сырые сканы от другого исполнителя (Rust-декодер):
 * тогда повторный проход по байтам не нужен. Правила отбора (что попадает
 * в строку, ключи, порядок) — по-прежнему здесь, в TS.
 */
export function extractObject(
  obj: SerializedObject,
  raw: Uint8Array,
  tree: TypeTreeNode | null,
  endian: Endian = "le",
  scans?: RawScans,
  options: ExtractOptions = {},
): DumpObjectRow {
  const row: DumpObjectRow = {
    path_id: obj.pathId,
    type: unityClassName(obj.classId),
  };

  const allTexts = scans ? scans.rawTexts : scanRawStrings(raw).map((item) => item.text);

  let isFsm = false;
  const typed = tree ? readObjectTypetree(tree, raw, endian) : null;
  if (typed === null) {
    row.error = "read_failed";
    if (allTexts.includes("ColorParserList")) {
      const colors = scans ? scans.colors : parseColorParserList(raw);
      if (colors) {
        row.color_parser_list = colors;
        delete row.error;
      }
    }
  } else {
    const { strings, fields, isFsm: fsmFlag, cutValues } = collectTypedFields(typed);
    if (Object.keys(strings).length > 0) row.strings = strings;
    if (Object.keys(fields).length > 0) row.fields = fields;
    if (cutValues > 0 && options.truncation) {
      options.truncation.stringLength.units += 1;
      options.truncation.stringLength.dropped += cutValues;
    }
    isFsm = fsmFlag;
  }

  const dialogues: Array<RawDialogue | PlaymakerDialogue> = scans
    ? [...scans.dialogues]
    : parseDialogueFromRaw(raw);
  const playmaker = parsePlaymakerDialogues(allTexts);
  if (playmaker.length > 0) dialogues.push(...playmaker);
  if (dialogues.length > 0) row.dialogues = dialogues;

  if (isFsm && typed) {
    const fsmStrings = parseFsmStrings(typed);
    if (fsmStrings.length > 0) row.fsm_strings = fsmStrings;
  }

  if (allTexts.length > 0) {
    // Счётчик обрезки: без отчёта (прямые вызовы в тестах) — во временный бакет.
    const target = options.truncation?.rawStrings ?? THROWAWAY_BUCKET;
    row.raw_strings = capList(allTexts, options.rawStringLimit ?? null, target);
  }

  return row;
}
