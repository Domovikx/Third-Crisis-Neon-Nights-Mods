/**
 * rawscan.mts — сканеры «сырых» байтов Unity-объектов и файлов.
 *
 * Порт raw-половины `dump_assets.py` (эталон паритета): строки ищутся прямо
 * в байтах объекта, без разбора типов. Именно этот путь даёт почти весь текст
 * POT (dialogues + raw_strings), поэтому поведение скопировано поштучно:
 * те же границы, тот же порядок, те же причуды (например, `\n` внутри
 * JSON-строки в диалоге становится буквой `n` — так делает эталон).
 *
 * Общие фильтры (SKIP-префиксы, rich-теги) — из `pipeline-common`, не дублируем.
 */

import {
  isSkipPrefix,
  KNOWN_NON_SPEAKERS,
  stripRich,
} from "../../pipeline-common/scripts/text_filters.mts";
import {
  cpLen,
  pyIsAlnum,
  pyIsAlpha,
  pyIsLowerChar,
  pyIsUpper,
  pyIsUpperChar,
  pyRound,
  pySlice,
  pyStrip,
} from "./pystr.mts";

export const MAX_STRING_LEN = 500;
export const MIN_RAW_LEN = 3;

const UTF8 = new TextDecoder("utf-8");
const UTF16LE = new TextDecoder("utf-16le");
const ASCII = new TextDecoder("ascii");

// ---------------------------------------------------------------- байтовые утилиты

/** `bytes.find(needle, from)` — индекс или -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  const last = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    if (haystack[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/** Байты строки в UTF-16LE (маркеры .NET #US heap). */
export function utf16leBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = code >> 8;
  }
  return out;
}

/** `bytes.decode("ascii", errors="replace")` — байты >127 становятся U+FFFD. */
function decodeAsciiReplace(bytes: Uint8Array): string {
  const chars: string[] = [];
  for (const b of bytes) chars.push(b <= 0x7f ? String.fromCharCode(b) : "\uFFFD");
  return chars.join("");
}

/** `int(x, 16)` из Python для 4 байт: допускает пробелы/знак/подчёркивания. */
function pyIntHex(bytes: Uint8Array): number | null {
  const text = decodeAsciiReplace(bytes).trim().replace(/_/g, "");
  if (!/^[+-]?[0-9a-fA-F]+$/.test(text)) return null;
  const value = Number.parseInt(text, 16);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------- scan_raw_strings

/** Одна найденная строка: как в эталоне (`offset/text/flags/letters`). */
export interface RawString {
  offset: number;
  text: string;
  flags: "null_term";
  letters: number;
}

/** Сколько ASCII-букв в строке (Python `sum(c.isalpha())`). */
function asciiLetters(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) n += 1;
  }
  return n;
}

/**
 * Сканировать сырые байты на печатные ASCII-строки.
 *
 * Порог: ≥3 символа и ≥2 буквы. `strip()` эталона здесь не режет ничего:
 * сканер собирает только байты 32..126, пробелов в выборке нет.
 */
export function scanRawStrings(raw: Uint8Array, baseOffset = 0): RawString[] {
  const results: RawString[] = [];
  const seen = new Set<string>();
  const n = raw.length;
  let i = 0;
  while (i < n) {
    if (raw[i] >= 32 && raw[i] <= 126) {
      const start = i;
      while (i < n && raw[i] >= 32 && raw[i] <= 126) i += 1;
      const s = pyStrip(ASCII.decode(raw.subarray(start, i)));
      if (s.length >= MIN_RAW_LEN) {
        const letters = asciiLetters(s);
        if (letters >= 2) {
          const key = `${start}\u0000${s}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              offset: baseOffset + start,
              text: pySlice(s, MAX_STRING_LEN),
              flags: "null_term",
              letters,
            });
          }
        }
      }
    } else {
      i += 1;
    }
  }
  return results;
}

// ---------------------------------------------------------------- JSON-диалоги в raw

/**
 * Прочитать JSON-строку начиная сразу после открывающей кавычки.
 *
 * Возвращает `[текст|null, следующий_индекс]`. Экранирование повторяет
 * эталон: `\"`/`\\`/`\n`/`\r`/`\t` дают САМ байт после слэша (то есть `\n`
 * превращается в букву `n`), `\uXXXX` — символ с кодом.
 */
export function extractJsonString(data: Uint8Array, start: number): [string | null, number] {
  let i = start;
  const out: number[] = [];
  while (i < data.length) {
    const b = data[i];
    if (b === 0x22) return [UTF8.decode(new Uint8Array(out)), i + 1];
    if (b === 0x5c) {
      if (i + 1 < data.length) {
        const nxt = data[i + 1];
        if (nxt === 0x22 || nxt === 0x5c || nxt === 0x6e || nxt === 0x72 || nxt === 0x74) {
          out.push(nxt);
          i += 2;
        } else if (nxt === 0x75) {
          if (i + 5 < data.length) {
            const code = pyIntHex(data.subarray(i + 2, i + 6));
            // Суррогаты Python не может закодировать в UTF-8 → слот пропускается.
            if (code === null || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
              i += 2;
            } else {
              out.push(...utf8OfCodePoint(code));
              i += 6;
            }
          } else {
            i += 2;
          }
        } else {
          out.push(nxt);
          i += 2;
        }
      } else {
        break;
      }
    } else {
      out.push(b);
      i += 1;
    }
  }
  return [null, i];
}

function utf8OfCodePoint(code: number): number[] {
  return [...new TextEncoder().encode(String.fromCodePoint(code))];
}

/** Одна пара диалога из raw-скан (`Speaker`/`Text` в JSON-подобном блобе). */
export interface RawDialogue {
  offset: number;
  speaker: string;
  text: string;
  rich_text: string;
}

/** Реплика PlayMaker: у эталона в этом объекте НЕТ поля `offset`. */
export interface PlaymakerDialogue {
  speaker: string;
  text: string;
  rich_text: string;
}

const SPEAKER_MARKER = new TextEncoder().encode('"Speaker":"');
const TEXT_MARKER = new TextEncoder().encode(',"Text":"');
const RICH_TAG_RX = /<[^>]+>/g;

/** Вытащить пары `Speaker`/`Text` из сырых байтов объекта. */
export function parseDialogueFromRaw(raw: Uint8Array, baseOffset = 0): RawDialogue[] {
  const results: RawDialogue[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < raw.length) {
    const pos = indexOfBytes(raw, SPEAKER_MARKER, i);
    if (pos < 0) break;

    const [speaker, speakerEnd] = extractJsonString(raw, pos + SPEAKER_MARKER.length);
    if (speaker === null) {
      i = pos + 1;
      continue;
    }

    const textPos = indexOfBytes(raw, TEXT_MARKER, speakerEnd);
    if (textPos < 0) {
      i = speakerEnd;
      continue;
    }

    const [text, textEnd] = extractJsonString(raw, textPos + TEXT_MARKER.length);
    if (text === null) {
      i = textPos + 1;
      continue;
    }

    const clean = pyStrip(text.replace(RICH_TAG_RX, ""));
    const key = `${speaker}|${clean}`;
    if (clean && !seen.has(key)) {
      seen.add(key);
      results.push({
        offset: baseOffset + pos,
        speaker,
        text: pySlice(clean, MAX_STRING_LEN),
        rich_text: pySlice(text, MAX_STRING_LEN),
      });
    }

    i = textEnd;
  }
  return results;
}

// ---------------------------------------------------------------- PlayMaker line_X

/** Извлечь реплики из `raw_strings` PlayMaker-бандла (паттерн `line_X`). */
export function parsePlaymakerDialogues(rawStrings: string[]): PlaymakerDialogue[] {
  const results: PlaymakerDialogue[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < rawStrings.length) {
    const s = pyStrip(rawStrings[i]);
    if (!s.startsWith("line_")) {
      i += 1;
      continue;
    }

    // Пропустить маркер line_X и его необязательный дубль.
    i += 1;
    if (i < rawStrings.length && pyStrip(rawStrings[i]) === s) i += 1;

    // Текст диалога — следующая не-skip строка с пробелом длиннее 3 символов.
    let text = "";
    while (i < rawStrings.length) {
      const ns = pyStrip(rawStrings[i]);
      if (isSkipPrefix(ns) || ns === "") {
        i += 1;
        continue;
      }
      if (cpLen(ns) <= 3 || !ns.includes(" ")) {
        i += 1;
        continue;
      }
      if (ns.startsWith("{") || ns.startsWith("[")) {
        i += 1;
        continue;
      }
      text = ns;
      i += 1;
      break;
    }

    if (!text) continue;

    const clean = stripRich(text);
    const richText = text !== clean ? text : "";

    // Спикер — следующая строка без пробела, с заглавной буквы, Alpha.
    let speaker = "";
    if (i < rawStrings.length) {
      const ns = pyStrip(rawStrings[i]);
      const first = [...ns][0] ?? "";
      if (
        ns &&
        !isSkipPrefix(ns) &&
        !ns.startsWith("line_") &&
        !ns.includes(" ") &&
        pyIsUpperChar(first) &&
        pyIsAlpha(ns) &&
        !KNOWN_NON_SPEAKERS.has(ns)
      ) {
        speaker = ns;
        i += 1;
      }
    }

    const key = `${speaker}|${clean}`;
    if (clean && !seen.has(key)) {
      seen.add(key);
      results.push({ speaker, text: clean, rich_text: richText });
    }
  }
  return results;
}

// ---------------------------------------------------------------- ColorParserList

/**
 * Разобрать `ColorParserList` MonoBehaviour (`{имя: #RRGGBB}`).
 *
 * Скан, не разбор по смещению: в raw ищем 4-выровненный `int32 count`,
 * затем `count` записей `int32 len, char[len], pad, float[4]`. Возвращает
 * null, если валидного списка нет (эталон ведёт себя так же).
 */
export function parseColorParserList(raw: Uint8Array): Record<string, string> | null {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const len = raw.length;

  const readEntry = (
    offset: number,
  ): { name: string; r: number; g: number; b: number; a: number; next: number } | null => {
    if (offset + 4 > len) return null;
    const sl = view.getInt32(offset, true);
    if (sl <= 0 || sl > 100 || offset + 4 + sl > len) return null;
    const name = decodeAsciiReplace(raw.subarray(offset + 4, offset + 4 + sl));
    if (!pyIsAlnum(name.replace(/_/g, ""))) return null;
    let off2 = offset + 4 + sl;
    if (off2 % 4 !== 0) off2 += 4 - (off2 % 4);
    if (off2 + 24 > len) return null;
    const r = view.getFloat32(off2, true);
    const g = view.getFloat32(off2 + 4, true);
    const b = view.getFloat32(off2 + 8, true);
    const a = view.getFloat32(off2 + 12, true);
    if ([r, g, b, a].some((v) => !(v >= 0 && v <= 1))) return null;
    return { name, r, g, b, a, next: off2 + 24 };
  };

  for (let off = 0; off < len - 24; off += 4) {
    const count = view.getInt32(off, true);
    if (count <= 0 || count > 50) continue;

    const res: Record<string, string> = {};
    let ok = true;
    let o = off + 4;
    for (let i = 0; i < count; i++) {
      const entry = readEntry(o);
      if (!entry) {
        ok = false;
        break;
      }
      const ri = Math.min(255, Math.max(0, pyRound(entry.r * 255)));
      const gi = Math.min(255, Math.max(0, pyRound(entry.g * 255)));
      const bi = Math.min(255, Math.max(0, pyRound(entry.b * 255)));
      res[entry.name] = `#${hex2(ri)}${hex2(gi)}${hex2(bi)}`;
      o = entry.next;
    }

    if (ok && Object.keys(res).length === count) return res;
  }
  return null;
}

function hex2(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, "0");
}

// ---------------------------------------------------------------- Settings.* в raw

/** Пара «ключ настройки → подпись» из raw-байтов ассета. */
export interface SettingKey {
  key: string;
  display: string;
}

const SETTINGS_MARKER = new TextEncoder().encode("Settings.");

/** Найти пары `Settings.X` + UTF-8 подпись в сырых байтах файла. */
export function scanSettingsKeys(data: Uint8Array): SettingKey[] {
  const results: SettingKey[] = [];
  const seen = new Set<string>();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let i = 0;
  while (i < data.length) {
    const pos = indexOfBytes(data, SETTINGS_MARKER, i);
    if (pos < 0) break;
    if (pos < 4) {
      i = pos + 1;
      continue;
    }
    const keyLen = view.getUint32(pos - 4, true);
    if (keyLen >= 9 && keyLen <= 60) {
      const key = decodeAsciiReplace(data.subarray(pos, pos + keyLen));
      if (key.startsWith("Settings.") && key.length > 9) {
        let afterKey = pos + keyLen;
        while (afterKey < data.length && data[afterKey] === 0) afterKey += 1;
        if (afterKey + 4 < data.length) {
          const dispLen = view.getUint32(afterKey, true);
          if (dispLen >= 1 && dispLen <= 100) {
            const disp = UTF8.decode(data.subarray(afterKey + 4, afterKey + 4 + dispLen));
            if (disp && !seen.has(key)) {
              seen.add(key);
              results.push({ key, display: pySlice(disp, MAX_STRING_LEN) });
            }
          }
        }
      }
    }
    i = pos + 1;
  }
  return results;
}

// ---------------------------------------------------------------- global strings

/**
 * Похоже ли строка из не-объектных байтов на UI-текст
 * (порт `_is_global_string_candidate`).
 */
export function isGlobalStringCandidate(s: string): boolean {
  if (asciiLetters(s) < 3) return false;
  if (/[#$%@&*{}()<>|^~`=]/.test(s) || s.includes("[") || s.includes("]")) return false;
  const second = [...s][1] ?? "";
  if (s.startsWith("_") && pyIsAlpha(second) && pyIsUpperChar(second)) return false;
  if (s.includes("/") && !s.startsWith("http")) return false;
  if ([...s].every((c) => pyIsUpper(c) || /^\p{Nd}$/u.test(c) || c === " ")) {
    const upper = s.toUpperCase();
    if (cpLen(s) >= 3 && ![..."AEIOUY "].some((c) => upper.includes(c))) return false;
  }
  if (s.includes(" ")) {
    if (!/[/\\.()[\]]/.test(s)) return true;
  }
  if (pyIsUpper(s)) return [..."AEIOU"].some((v) => s.includes(v));
  const chars = [...s];
  if (pyIsUpperChar(chars[0]) && chars.slice(1).some(pyIsLowerChar)) return asciiLetters(s) >= 4;
  if (asciiLetters(s) >= 6) return true;
  return false;
}

/** Оценка «насколько это UI-текст» — сортировка global_strings (порт `_ui_priority`). */
export function uiPriority(s: string): number {
  if (s.includes(" ")) {
    if (s.includes("/") || s.includes("\\")) return -10;
    return 100;
  }
  if (pyIsUpper(s)) {
    const hasVowel = [..."AEIOU"].some((v) => s.includes(v));
    const hasUnderscore = s.includes("_");
    if (hasVowel && !hasUnderscore && cpLen(s) >= 2 && cpLen(s) <= 20) return 80;
  }
  const chars = [...s];
  if (pyIsUpperChar(chars[0]) && chars.slice(1).some(pyIsLowerChar)) return 50;
  if (s.startsWith("_")) return -50;
  if (pyIsLowerChar(chars[0]) && chars.slice(1).some(pyIsUpperChar)) return 20;
  return 0;
}

const GLOBAL_STRING_LIMIT = 500;

/** Кандидаты в UI-строки из не-объектных байтов (сортировка по приоритету). */
export function scanGlobalStrings(data: Uint8Array): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const n = data.length;
  let i = 0;
  while (i < n) {
    if (data[i] >= 32 && data[i] <= 126) {
      const start = i;
      while (i < n && data[i] >= 32 && data[i] <= 126) i += 1;
      const s = pyStrip(ASCII.decode(data.subarray(start, i)));
      const length = cpLen(s);
      if (length >= 3 && length <= 120 && !seen.has(s) && isGlobalStringCandidate(s)) {
        seen.add(s);
        candidates.push(s);
      }
    } else {
      i += 1;
    }
  }
  // Сортировка стабильная: как `sort(key=..., reverse=True)` в Python.
  return candidates
    .map((text, index) => ({ text, index, priority: uiPriority(text) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, GLOBAL_STRING_LIMIT)
    .map((c) => c.text);
}

/** Декодировать UTF-16LE (для .NET-сканов). */
export function decodeUtf16le(bytes: Uint8Array): string {
  return UTF16LE.decode(bytes);
}
