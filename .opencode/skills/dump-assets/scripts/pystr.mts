/**
 * pystr.mts — примитивы строк Python, нужные дамперу для паритета.
 *
 * Дамп сверяется с Python-эталоном (`dump_assets.py`), поэтому нельзя
 * подменять `str.strip()`/`str.isalpha()`/`str.isupper()` на JS-аналоги:
 * CPython работает по Unicode-свойствам (BOM, NEL, астральные символы),
 * а `String.prototype.trim` — по другой таблице пробелов.
 *
 * Здесь только то, что реально использует дампер (KISS): пробелы, регистр,
 * алфавитность, код-поинтовая длина/срез, банковское округление и repr float.
 */

/** Пробелы Python `str.strip()` (Unicode White_Space; BOM сюда НЕ входит). */
const PY_WS_RX =
  // eslint-disable-next-line no-control-regex -- \u001c-\u001f/\u0085 — пробелы в Python
  /^[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** `str.strip()` без аргументов (с обоих концов). */
export function pyStrip(s: string): string {
  return s.replace(PY_WS_RX, "");
}

/** Длина в code points (Python `len`), а не в UTF-16 units. */
export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** Python-срез `s[:n]` — по code points. */
export function pySlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** Python `str.isalpha()`: непустая строка только из букв. */
export function pyIsAlpha(s: string): boolean {
  return /^\p{Alphabetic}+$/u.test(s);
}

/** Python `str.isalnum()`: непустая строка только из букв/цифр. */
export function pyIsAlnum(s: string): boolean {
  return /^[\p{Alphabetic}\p{Nd}]+$/u.test(s);
}

/** Python-признак одного символа: `ch.isupper()` / `ch.islower()`. */
export function pyIsUpperChar(ch: string): boolean {
  return /\p{Uppercase}/u.test(ch);
}

export function pyIsLowerChar(ch: string): boolean {
  return /\p{Lowercase}/u.test(ch);
}

/** Python `str.isupper()`: есть заглавные, строчных нет. */
export function pyIsUpper(s: string): boolean {
  let hasUpper = false;
  for (const ch of s) {
    if (pyIsLowerChar(ch)) return false;
    if (pyIsUpperChar(ch)) hasUpper = true;
  }
  return hasUpper;
}

/** Python `str.islower()`: есть строчные, заглавных нет. */
export function pyIsLower(s: string): boolean {
  let hasLower = false;
  for (const ch of s) {
    if (pyIsUpperChar(ch)) return false;
    if (pyIsLowerChar(ch)) hasLower = true;
  }
  return hasLower;
}

/**
 * Python `round()` для `.5` — округление к чётному (banker's), в отличие от
 * `Math.round`. Нужно для `int(round(r * 255))` в `parse_color_parser_list`.
 */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * `repr(float)` Python для JSON (`json.dumps` пишет float через repr).
 *
 * Отличие от `Number#toString` — экспоненциальная запись для |x| < 1e-4 и
 * обязательный `.0` у целых значений. Хвост экспоненты Python дополняет
 * нулями до двух знаков (`1e-05`, `1.5e+20`).
 */
export function pyFloatRepr(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(x);
  if (abs >= 1e16 || abs < 1e-4) {
    const [mantissa, exp] = x.toExponential().split("e");
    const cleanMantissa = mantissa.replace(/\.0$/, "");
    const expNum = Number(exp);
    const sign = expNum < 0 ? "-" : "+";
    const digits = String(Math.abs(expNum)).padStart(2, "0");
    return `${cleanMantissa}e${sign}${digits}`;
  }
  const s = String(x);
  return s.includes(".") ? s : `${s}.0`;
}
