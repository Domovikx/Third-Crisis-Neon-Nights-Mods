/**
 * font_coverage.mts — «ни одного тофу»: глифы шрифтов против символов корпуса.
 *
 * Каждый язык перевода рисуется своим шрифтом (`fonts/`), а незнакомые символы
 * подхватывает цепочка фолбэков. Скрипт читает cmap шрифтов напрямую (без
 * зависимостей и без Python) и сверяет с символами, реально встречающимися в
 * `po/<lang>.po` (msgstr). Код выхода 1, если хотя бы один символ корпуса не
 * покрыт ни одним шрифтом цепочки.
 *
 * Политика и цифры — `docs/fonts.md`.
 *
 * CLI: node scripts/font_coverage.mts [--list] [--json]
 *   --list — печатать непокрытые символы (U+XXXX) по языкам;
 *   --json — машинный отчёт в stdout.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "..");

/** Шрифты и их роль. Порядок = порядок фолбэк-цепочки. */
export const FONT_CHAIN = [
  "RobotoCondensed-Regular.ttf",
  "NotoSansSC.ttf",
  "NotoSansJP.ttf",
  "NotoSansKR.ttf",
  "NotoSansMarks.ttf",
];

/** Основной шрифт языка (первым в цепочке); остальные — фолбэк. */
export const FACE_FOR_LANG: Record<string, string> = {
  ru: "RobotoCondensed-Regular.ttf",
  de: "RobotoCondensed-Regular.ttf",
  es: "RobotoCondensed-Regular.ttf",
  fr: "RobotoCondensed-Regular.ttf",
  it: "RobotoCondensed-Regular.ttf",
  pl: "RobotoCondensed-Regular.ttf",
  pt: "RobotoCondensed-Regular.ttf",
  zh: "NotoSansSC.ttf",
  ja: "NotoSansJP.ttf",
  ko: "NotoSansKR.ttf",
};

const SKIP = new Set(["zh", "ja", "ko"]);

/** Диапазоны кодпоинтов, для которых в шрифте есть настоящий глиф. */
export type Ranges = Array<[number, number]>;

/**
 * Прочитать cmap (формат 4 и 12) из TTF/OTF. Формат 4 — BMP, 12 — Unicode
 * целиком; для наших сабсетов достаточно 4, но 12 поддерживаем, чтобы файл
 * можно было заменить полным шрифтом без правки проверки.
 */
export function glyphRanges(fontPath: string): Ranges {
  const buf = readFileSync(fontPath);
  const numTables = buf.readUInt16BE(4);
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString("ascii", rec, rec + 4) === "cmap") {
      cmapOffset = buf.readUInt32BE(rec + 8);
      break;
    }
  }
  if (cmapOffset < 0) throw new Error(`${fontPath}: нет таблицы cmap`);

  const numSub = buf.readUInt16BE(cmapOffset + 2);
  const subs: Array<{ platform: number; encoding: number; offset: number }> = [];
  for (let i = 0; i < numSub; i++) {
    const rec = cmapOffset + 4 + i * 8;
    subs.push({
      platform: buf.readUInt16BE(rec),
      encoding: buf.readUInt16BE(rec + 2),
      offset: buf.readUInt32BE(rec + 4),
    });
  }
  // Предпочитаем Windows Unicode (3/1, 3/10), иначе любой Unicode (0/*).
  const pick =
    subs.find((s) => s.platform === 3 && s.encoding === 10) ??
    subs.find((s) => s.platform === 3 && s.encoding === 1) ??
    subs.find((s) => s.platform === 0);
  if (!pick) throw new Error(`${fontPath}: нет Unicode-подтаблицы cmap`);

  const off = cmapOffset + pick.offset;
  const format = buf.readUInt16BE(off);
  const out: Ranges = [];
  if (format === 4) {
    const segCount = buf.readUInt16BE(off + 6) / 2;
    const endOff = off + 14;
    const startOff = endOff + segCount * 2 + 2;
    for (let i = 0; i < segCount; i++) {
      const end = buf.readUInt16BE(endOff + i * 2);
      const start = buf.readUInt16BE(startOff + i * 2);
      if (start === 0xffff) continue;
      out.push([start, end]);
    }
  } else if (format === 12) {
    const groups = buf.readUInt32BE(off + 12);
    for (let i = 0; i < groups; i++) {
      const rec = off + 16 + i * 12;
      out.push([buf.readUInt32BE(rec), buf.readUInt32BE(rec + 4)]);
    }
  } else {
    throw new Error(`${fontPath}: неподдерживаемый формат cmap ${format}`);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Есть ли глиф для кодпоинта (бинарный поиск по диапазонам). */
export function covers(ranges: Ranges, cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Символы msgstr языка, которые вообще могут попасть на экран. */
export function corpusChars(lang: string, root: string = REPO_ROOT): number[] {
  const entries = parsePo(readFileSync(join(root, "po", `${lang}.po`), "utf8"));
  const set = new Set<number>();
  for (const e of entries) {
    for (const ch of e.msgstr) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue; // управляющие
      set.add(cp);
    }
  }
  return [...set].sort((a, b) => a - b);
}

export interface LangReport {
  lang: string;
  chars: number;
  face: string;
  /** Символы, которых нет у основного шрифта языка. */
  faceMissing: number;
  /** Символы, не покрытые ВСЕЙ цепочкой (это и есть «тофу»). */
  uncovered: number[];
}

/** Сверить корпус всех языков с цепочкой шрифтов. */
export function checkFonts(root: string = REPO_ROOT): LangReport[] {
  const ranges = new Map<string, Ranges>();
  for (const f of FONT_CHAIN) ranges.set(f, glyphRanges(join(root, "fonts", f)));
  const anyCovered = (cp: number) => FONT_CHAIN.some((f) => covers(ranges.get(f)!, cp));

  return Object.keys(FACE_FOR_LANG).map((lang) => {
    const chars = corpusChars(lang, root);
    const face = FACE_FOR_LANG[lang];
    const faceRanges = ranges.get(face);
    if (!faceRanges) throw new Error(`нет шрифта ${face} для ${lang}`);
    const uncovered = chars.filter((cp) => !anyCovered(cp));
    return {
      lang,
      chars: chars.length,
      face,
      faceMissing: chars.filter((cp) => !covers(faceRanges, cp)).length,
      uncovered,
    };
  });
}

const cp = (n: number) => `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;

function main(argv: string[]): number {
  const list = argv.includes("--list");
  const json = argv.includes("--json");
  const report = checkFonts();
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("язык  шрифт                            символов  нет в шрифте  не покрыто");
    for (const r of report) {
      const face = r.face.padEnd(32);
      console.log(
        `${r.lang.padEnd(5)} ${face} ${String(r.chars).padStart(8)} ${String(r.faceMissing).padStart(13)} ${String(r.uncovered.length).padStart(11)}` +
          (list && r.uncovered.length > 0 ? `  ${r.uncovered.map(cp).join(" ")}` : ""),
      );
    }
  }
  const bad = report.filter((r) => r.uncovered.length > 0);
  if (bad.length > 0) {
    console.error(`\nТОФУ: ${bad.map((r) => `${r.lang}: ${r.uncovered.length}`).join(", ")}`);
    return 1;
  }
  const cjk = report.filter((r) => SKIP.has(r.lang)).map((r) => `${r.lang} ${r.chars}`);
  console.log(`\nOK: ни одного тофу (CJK: ${cjk.join(", ")}).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
