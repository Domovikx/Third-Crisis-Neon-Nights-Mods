/**
 * dotnet.mts — сканер .NET-сборки (`Assembly-CSharp.dll`): куча `#US`.
 *
 * Порт dll-половины `dump_assets.py`. Из DLL берутся два потока строк:
 *   - ключи `Settings.*` (подпись генерируется из имени ключа);
 *   - автономные UI-строки из кучи пользовательских строк.
 * Оба попадают в `summaries.jsonl` как `settings_keys` (потребитель не
 * различает «настоящую» настройку и UI-строку — это решение эталона).
 */

import {
  cpLen,
  pyIsLower,
  pyIsLowerChar,
  pyIsUpper,
  pyIsUpperChar,
  pySlice,
  pyStrip,
} from "./pystr.mts";
import { decodeUtf16le, type SettingKey, utf16leBytes } from "./rawscan.mts";
import { capList, type TruncationBucket } from "./truncation.mts";

/** Бакет-заглушка: прямой вызов без общего отчёта прогона. */
const THROWAWAY_BUCKET: TruncationBucket = { units: 0, dropped: 0, limit: null };

/** Прочитать .NET compressed integer (1, 2 или 4 байта). */
export function readCompressedInt(data: Uint8Array, offset: number): [number, number] {
  if (offset >= data.length) return [-1, offset];
  const b0 = data[offset];
  if (b0 < 0x80) return [b0, offset + 1];
  if (b0 < 0xc0) {
    if (offset + 1 >= data.length) return [-1, offset];
    return [((b0 & 0x3f) << 8) | data[offset + 1], offset + 2];
  }
  if (b0 < 0xe0) {
    if (offset + 3 >= data.length) return [-1, offset];
    return [
      ((b0 & 0x1f) << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3],
      offset + 4,
    ];
  }
  return [-1, offset];
}

/** Найти кучу `#US`: возвращает `[offset, size]` или null. */
export function findDotnetUsHeap(data: Uint8Array): [number, number] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Сигнатура метаданных .NET: "BSJB".
  const sig = new Uint8Array([0x42, 0x53, 0x4a, 0x42]);
  let sigOffset = -1;
  for (let i = 0; i + 4 <= data.length; i++) {
    if (
      data[i] === sig[0] &&
      data[i + 1] === sig[1] &&
      data[i + 2] === sig[2] &&
      data[i + 3] === sig[3]
    ) {
      sigOffset = i;
      break;
    }
  }
  if (sigOffset < 0) return null;

  let pos = sigOffset + 12;
  if (pos + 4 > data.length) return null;
  const verLen = view.getUint32(pos, true);
  pos += 4 + verLen;
  if (pos % 4 !== 0) pos += 4 - (pos % 4);
  if (pos + 4 > data.length) return null;
  const streamsCount = view.getUint16(pos + 2, true);
  pos += 4;

  for (let i = 0; i < streamsCount; i++) {
    if (pos + 8 > data.length) return null;
    const streamOffset = view.getUint32(pos, true);
    const streamSize = view.getUint32(pos + 4, true);
    pos += 8;
    let nameEnd = pos;
    while (nameEnd < data.length && data[nameEnd] !== 0) nameEnd += 1;
    if (nameEnd >= data.length) return null;
    let name = "";
    for (let k = pos; k < nameEnd; k++)
      name += String.fromCharCode(data[k] <= 0x7f ? data[k] : 0xfffd);
    pos = nameEnd + 1;
    if (pos % 4 !== 0) pos += 4 - (pos % 4);
    if (name === "#US") return [sigOffset + streamOffset, streamSize];
  }
  return null;
}

/** `Settings.EnableVSync` → `Enable VSync`; `Settings.X.Y` → `Y`. */
export function keyToDisplay(keyText: string): string | null {
  const suffix = keyText.slice("Settings.".length);
  if (!suffix) return null;
  const parts = suffix.split(".");
  if (parts.length > 1) return parts[parts.length - 1];

  const words = suffix.match(/[A-Z][a-z]*|[A-Z]+(?=[A-Z][a-z])|[A-Z]+$|^[a-z]+|[0-9]+/g);
  if (!words || words.length === 0) return suffix;
  return words.join(" ");
}

const SETTINGS_UTF16 = utf16leBytes("Settings.");

/** Ключи `Settings.*` из кучи #US (подпись синтезируется из имени). */
export function scanDotnetSettings(data: Uint8Array): SettingKey[] {
  const heap = findDotnetUsHeap(data);
  const usStart = heap ? heap[0] : 0;
  const usEnd = heap ? heap[0] + heap[1] : data.length;
  const results: SettingKey[] = [];
  const seen = new Set<string>();
  let i = usStart;

  const findMarker = (from: number): number => {
    const last = Math.min(usEnd, data.length) - SETTINGS_UTF16.length;
    for (let p = from; p <= last; p++) {
      let ok = true;
      for (let j = 0; j < SETTINGS_UTF16.length; j++) {
        if (data[p + j] !== SETTINGS_UTF16[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return p;
    }
    return -1;
  };

  while (i < usEnd - SETTINGS_UTF16.length) {
    const pos = findMarker(i);
    if (pos < 0 || pos >= usEnd) break;
    const keyStart = pos - 1;
    if (keyStart < 0) {
      i = pos + 1;
      continue;
    }
    const prefixByte = data[keyStart];
    let totalBytes: number;
    let keyDataStart: number;
    if (prefixByte < 0x80) {
      totalBytes = prefixByte;
      keyDataStart = keyStart + 1;
    } else if (prefixByte < 0xc0 && keyStart >= 1) {
      totalBytes = ((prefixByte & 0x3f) << 8) | data[keyStart - 1];
      keyDataStart = keyStart + 2;
    } else {
      i = pos + 1;
      continue;
    }
    const utf16Bytes = totalBytes - 1;
    if (utf16Bytes < 10 || utf16Bytes > 200 || utf16Bytes % 2 !== 0) {
      i = pos + 1;
      continue;
    }
    if (keyDataStart + utf16Bytes > data.length) {
      i = pos + 1;
      continue;
    }
    const keyText = decodeUtf16le(data.subarray(keyDataStart, keyDataStart + utf16Bytes));
    const tail = keyText.slice(9);
    if (!keyText.startsWith("Settings.") || ![...tail].every((c) => isAlnumOrDotUnderscore(c))) {
      i = pos + 1;
      continue;
    }
    if (seen.has(keyText)) {
      i = pos + 1;
      continue;
    }
    const display = keyToDisplay(keyText);
    if (display === null) {
      i = pos + SETTINGS_UTF16.length;
      continue;
    }
    seen.add(keyText);
    results.push({ key: keyText, display: pySlice(display, 500) });
    i = pos + SETTINGS_UTF16.length;
  }
  return results;
}

function isAlnumOrDotUnderscore(c: string): boolean {
  return /[\p{Alphabetic}\p{Nd}._]/u.test(c);
}

/** Похоже ли на подпись UI (порт `_looks_like_display_text`). */
export function looksLikeDisplayText(s: string): boolean {
  const length = cpLen(s);
  if (!s || length < 2 || length > 80) return false;
  if (s.startsWith("Settings.") || s.startsWith("System.")) return false;
  if (s.includes("_") && !s.includes(" ")) return false;
  if (/[{}[\]<>();=]/.test(s)) return false;
  if (pyIsLower(s)) return false;
  if (s.includes(" ")) return true;
  if ([...s].some(pyIsUpperChar)) return true;
  if (pyIsUpper(s) && [..."AEIOU"].some((v) => s.includes(v))) return true;
  return false;
}

/**
 * Автономные UI-строки из кучи #US (структурный проход по префиксам длины).
 *
 * `heapRange` — границы кучи, если она уже вырезана из сборки (декодер отдал
 * только её): тогда заголовок `BSJB` не ищется, а сканируется ровно диапазон.
 *
 * `limit` — лимит строк на сборку (`null` — без лимита, значение по умолчанию).
 * Исторический `[:500]` молча терял 251 UI-кандидат из 751 на корпусе (в том
 * числе видимые строки Lovense/сохранений). Если лимит задан, отбрасывание
 * считается в `truncation` и печатается в конце прогона.
 */
export function scanDotnetUiStrings(
  data: Uint8Array,
  heapRange?: [number, number],
  limit: number | null = null,
  truncation?: TruncationBucket,
): string[] {
  const heap = heapRange ?? findDotnetUsHeap(data);
  if (!heap) return [];
  const usStart = heap[0];
  const usEnd = heap[0] + heap[1];
  const results: string[] = [];
  const seen = new Set<string>();
  let i = usStart;

  while (i < usEnd - 2) {
    const b0 = data[i];
    if (b0 === 0x00) {
      i += 1;
      continue;
    }
    let totalBytes: number;
    let prefixSize: number;
    if (b0 < 0x80) {
      totalBytes = b0;
      prefixSize = 1;
    } else if (b0 < 0xc0) {
      if (i + 1 >= usEnd) break;
      totalBytes = ((b0 & 0x3f) << 8) | data[i + 1];
      prefixSize = 2;
    } else {
      i += 1;
      continue;
    }
    const utf16Bytes = totalBytes - 1;
    if (utf16Bytes < 2 || utf16Bytes > 300 || utf16Bytes % 2 !== 0) {
      i += prefixSize;
      continue;
    }
    const dataStart = i + prefixSize;
    if (dataStart + utf16Bytes + 1 > usEnd) break;
    const terminal = data[dataStart + utf16Bytes];
    if (terminal !== 0x00 && terminal !== 0x01) {
      i += prefixSize;
      continue;
    }
    const s = pyStrip(
      stripNulEnds(decodeUtf16le(data.subarray(dataStart, dataStart + utf16Bytes))),
    );
    i = dataStart + utf16Bytes + 1;

    const length = cpLen(s);
    if (seen.has(s) || length < 3 || length > 80) continue;
    if (!looksLikeDisplayText(s)) continue;
    if (!s.includes(" ") && !s.includes("_")) {
      const capsVowel = pyIsUpper(s) && [..."AEIOU"].some((v) => s.includes(v));
      if (!(capsVowel && length >= 2 && length <= 20)) continue;
    }
    seen.add(s);
    results.push(s);
  }

  const ordered = results
    .map((text, index) => ({ text, index, priority: dotnetUiPriority(text) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((item) => item.text);
  return capList(ordered, limit, truncation ?? THROWAWAY_BUCKET);
}

function stripNulEnds(s: string): string {
  // eslint-disable-next-line no-control-regex -- NUL-обрезка как Python strip("\x00")
  return s.replace(/^\u0000+|\u0000+$/g, "");
}

/** Порт `_ui_priority` (сортировка по «похожести на UI»). */
export function dotnetUiPriority(s: string): number {
  if (s.includes(" ")) {
    if (s.includes("/") || s.includes("\\")) return -10;
    return 100;
  }
  if (pyIsUpper(s)) {
    const hasVowel = [..."AEIOU"].some((v) => s.includes(v));
    const length = cpLen(s);
    if (hasVowel && !s.includes("_") && length >= 2 && length <= 20) return 80;
  }
  const chars = [...s];
  if (pyIsUpperChar(chars[0]) && chars.slice(1).some(pyIsLower)) return 50;
  if (s.startsWith("_")) return -50;
  if (pyIsLowerChar(chars[0]) && chars.slice(1).some(pyIsUpperChar)) return 20;
  return 0;
}
