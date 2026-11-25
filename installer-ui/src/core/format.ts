/** Форматирование чисел для UI (без Intl: тесты должны быть стабильны). */

const KB = 1024;
const MB = KB * 1024;

/** 1234 → «1.2 KB», 987 → «987 B». Один десятичный знак для KB/MB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

/** Код языка → подпись: `ru` → `RU`. */
export function langLabel(code: string): string {
  return code.toUpperCase();
}

/** Стереть корень игры из пути для компактного лога. */
export function shortPath(path: string, max = 64): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.length <= max) return normalized;
  return `…${normalized.slice(normalized.length - max + 1)}`;
}
