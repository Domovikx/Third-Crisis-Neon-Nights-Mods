/**
 * rt_backfill.mts — держит `#. rich_translation:` рядом с `#. rich_text:` в PO.
 *
 * Контракт (владелец, 2026-11-24): под КАЖДОЙ строкой `#. rich_text: …` идёт
 * `#. rich_translation: …`; значение = `msgstr` + те же теги в том же порядке.
 * Непереведённая строка (`msgstr ""`) держит пустую заготовку — гейт это
 * разрешает.
 *
 * ГЛАВНОЕ ПРАВИЛО: позиция тега в переводе не угадывается.
 *   - обёртка (`<i>весь текст</i>`) переносится точно (границы — края текста);
 *   - inline-пара ставится, только если её текст буквально найден в переводе;
 *   - иначе пара выбрасывается (`rich_translation` = перевод без этих тегов), а
 *     строка получает флаг `#, rt-review` и попадает в отчёт «на человека».
 *   Так не появляются `<b> </b>`, `<i></i>` и тег на пунктуации.
 *
 * Готовый `rt` переиспользуется, если его текст совпадает с `msgstr`, структура
 * совпадает с `rich_text` (перверсивный `<font>` снимается) и размещение не
 * вырождено («вся строка выделена»).
 *
 * CLI:
 *   node scripts/rt_backfill.mts [--lang ru|all] [--dry] [--json <path>]
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import {
  findArtifacts,
  isDegeneratePlacement,
  parseTags,
  placeTags,
  retagKeepingPositions,
  tagRaws,
} from "./rich_tags.mts";

const REPO = join(import.meta.dirname, "..");
const LANGS = ["zh", "ru", "es", "pt", "de", "ja", "fr", "pl", "ko", "it"];
const RICH_PREFIX = "#. rich_text: ";
const RT_PREFIX = "#. rich_translation:";
export const REVIEW_FLAG = "rt-review";

/** Пробелы схлопнуты: сравниваем текст, а не форматирование. */
const dense = (s: string): string => s.replace(/<[^<>]*>/g, "").replace(/\s+/gu, "");

export interface BlockResult {
  rich: string;
  msgstr: string;
  rt: string;
  /** Откуда взялось значение. */
  source: "kept" | "placed" | "stub";
  /** Сколько тегов не удалось подтвердить (нужен человек). */
  dropped: number;
  /** `rich_text` без единого тега: переносить нечего, источник битый. */
  untagged: boolean;
}

/** Разобрать значение rt из `#.` или старого `#`-комментария. */
export function rtOfBlock(lines: readonly string[]): string {
  for (const line of lines) {
    const m = /^#\. rich_translation:(?: (.*))?$/.exec(line);
    if (m) return m[1] ?? "";
    const t = /^# rich_translation:(?: (.*))?$/.exec(line) ?? /^# rich:(?: (.*))?$/.exec(line);
    if (t) return t[1] ?? "";
  }
  return "";
}

/** Переставить/добавить флаг `rt-review`, не трогая остальные флаги. */
export function withReviewFlag(lines: readonly string[], need: boolean): string[] {
  const flagsOf = (line: string): string[] =>
    line
      .slice(2)
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("#,")) {
      kept.push(line);
      continue;
    }
    const flags = flagsOf(line).filter((f) => f !== REVIEW_FLAG);
    if (flags.length) kept.push(`#, ${flags.join(", ")}`);
  }
  if (!need) return kept;
  const at = kept.findIndex((l) => l.startsWith("#,"));
  if (at >= 0) kept[at] = `${kept[at]}, ${REVIEW_FLAG}`;
  else {
    const insertAt = kept.findIndex((l) => l.startsWith("msgctxt ") || l.startsWith('msgid "'));
    kept.splice(insertAt < 0 ? kept.length : insertAt, 0, `#, ${REVIEW_FLAG}`);
  }
  return kept;
}

/** Собрать блок PO с `#. rich_translation:` сразу после `#. rich_text:`. */
export function backfillBlock(block: string): { text: string; result: BlockResult | null } {
  const lines = block.split("\n");
  const richAt = lines.findIndex((l) => l.startsWith(RICH_PREFIX));
  if (richAt < 0) return { text: block, result: null };
  const rich = lines[richAt].slice(RICH_PREFIX.length);
  const msgstr = parsePo(block).find((e) => e.msgid !== undefined)?.msgstr ?? "";
  const legacy = rtOfBlock(lines);
  const untagged = parseTags(rich).length === 0;

  let rt = "";
  let source: BlockResult["source"] = "stub";
  let dropped = 0;
  if (msgstr) {
    if (untagged) {
      // Разметки в источнике нет (шум дампа: `rich_text: << … >>` при msgid ">").
      // Переносить нечего; чужое значение (если было) не затираем.
      rt = legacy || msgstr;
    } else {
      const kept =
        legacy && dense(legacy) === dense(msgstr) ? retagKeepingPositions(legacy, rich) : null;
      if (
        kept &&
        tagRaws(kept).join("\u0000") === tagRaws(rich).join("\u0000") &&
        !findArtifacts(kept).length &&
        !isDegeneratePlacement(kept, rich)
      ) {
        rt = kept;
        source = "kept";
      } else {
        const placed = placeTags(rich, msgstr);
        rt = placed.rt;
        dropped = placed.dropped;
        source = "placed";
      }
    }
  }

  const rest = lines.filter((l) => {
    if (l.startsWith("#. rich_translation:")) return false;
    if (/^# rich(_translation)?:( |$)/.test(l)) return false;
    return true;
  });
  const body = withReviewFlag(rest, dropped > 0);
  const at = body.findIndex((l) => l.startsWith(RICH_PREFIX));
  const value = rt ? `${RT_PREFIX} ${rt}` : RT_PREFIX;
  const out = [...body.slice(0, at + 1), value, ...body.slice(at + 1)];
  return { text: out.join("\n"), result: { rich, msgstr, rt, source, dropped, untagged } };
}

export interface LangReport {
  lang: string;
  rich: number;
  filled: number;
  stubs: number;
  kept: number;
  placed: number;
  /** Строки, где часть тегов не подтвердилась → нужен человек. */
  review: { key: string; dropped: number; rich: string }[];
  failed: string[];
  /** `rich_text` без тегов: битая разметка источника. */
  brokenSource: string[];
}

/** Бэкфилл одного PO-файла; `dry` — только посчитать. */
export function backfillPo(
  lang: string,
  text: string,
  dry = false,
): { out: string; report: LangReport } {
  const chunks = text.split(/\n\n/);
  const report: LangReport = {
    lang,
    rich: 0,
    filled: 0,
    stubs: 0,
    kept: 0,
    placed: 0,
    review: [],
    failed: [],
    brokenSource: [],
  };
  const out = chunks.map((block) => {
    const { text: next, result } = backfillBlock(block);
    if (!result) return next;
    const key = parsePo(block).find((e) => e.msgid !== undefined)?.msgid ?? "?";
    report.rich += 1;
    if (!result.msgstr) report.stubs += 1;
    else if (result.untagged) report.brokenSource.push(result.rich.slice(0, 80));
    else if (!result.rt) report.failed.push(`${result.rich.slice(0, 80)} ⟵ rt пуст`);
    else {
      report.filled += 1;
      if (result.source === "kept") report.kept += 1;
      else report.placed += 1;
      if (result.dropped > 0)
        report.review.push({
          key: key.slice(0, 80),
          dropped: result.dropped,
          rich: result.rich.slice(0, 80),
        });
    }
    return next;
  });
  const joined = out.join("\n\n");
  if (!dry && joined !== text) {
    const path = join(REPO, "po", `${lang}.po`);
    const part = `${path}.part`;
    writeFileSync(part, joined, "utf8");
    renameSync(part, path);
  }
  return { out: joined, report };
}

function parseArgs(argv: string[]): { langs: string[]; dry: boolean; json: string | null } {
  let langs = LANGS;
  let dry = false;
  let json: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry") dry = true;
    else if (a === "--lang") {
      const v = argv[++i];
      if (v === "all") langs = LANGS;
      else if (!LANGS.includes(v ?? "")) throw new Error(`неизвестный язык: ${v}`);
      else langs = [v];
    } else if (a === "--json") {
      const v = argv[++i];
      if (!v) throw new Error("нет значения для --json");
      json = v;
    } else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return { langs, dry, json };
}

function main(argv: string[]): number {
  const cli = parseArgs(argv);
  const reports: LangReport[] = [];
  if (!cli.dry) console.log("язык  rich  заполнено  заготовок  сохранено  перенесено  на человеке");
  else console.log("язык  rich  заполнено  заготовок  сохранено  перенесено  на человеке (dry)");
  for (const lang of cli.langs) {
    const text = readFileSync(join(REPO, "po", `${lang}.po`), "utf8");
    const { report } = backfillPo(lang, text, cli.dry);
    reports.push(report);
    console.log(
      `${lang.padEnd(4)} ${String(report.rich).padStart(5)} ${String(report.filled).padStart(10)} ` +
        `${String(report.stubs).padStart(10)} ${String(report.kept).padStart(10)} ` +
        `${String(report.placed).padStart(11)} ${String(report.review.length).padStart(12)}`,
    );
  }
  const review = reports.reduce((n, r) => n + r.review.length, 0);
  const failed = reports.reduce((n, r) => n + r.failed.length, 0);
  console.log(
    `\nвсего rich: ${reports.reduce((n, r) => n + r.rich, 0)}; на человеке: ${review}; ошибок: ${failed}`,
  );
  for (const r of reports) for (const x of r.failed) console.log(`  ✗ ${r.lang}: ${x}`);
  const broken = reports.reduce((n, r) => n + r.brokenSource.length, 0);
  if (broken) {
    console.log(`битая разметка источника (rich_text без тегов): ${broken}`);
    for (const r of reports) for (const b of r.brokenSource) console.log(`  ! ${r.lang}: ${b}`);
  }
  if (cli.json) writeFileSync(cli.json, JSON.stringify(reports, null, 2), "utf8");
  return failed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
