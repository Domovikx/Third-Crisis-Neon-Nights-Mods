/**
 * rich_audit.mts — аудит TMP-разметки (`#. rich_text:`) в POT.
 *
 * Отвечает на вопрос «теги целые или кривые» БЕЗ правок данных: только классы,
 * числа и примеры. Решение по каждому классу принимает человек (правило из
 * `AGENTS.md`: внешний вид не повод что-то выкидывать, повод — структура).
 *
 * Классы:
 *   unbalanced   — открывающих и закрывающих тегов одного имени не поровну;
 *   crossed      — закрытие нарушает порядок вложенности (`<color><i></color></i>`);
 *   stray-close  — закрывающий тег без открывающего;
 *   unclosed     — открывающий без закрывающего;
 *   unknown-tag  — `<имя...>` похоже на тег, но имени нет в списке TMP;
 *   malformed    — `<` без закрывающей `>` или обрыв внутри тега;
 *   css-color    — `<color=red>`: имя из CSS, TMP разбирает его сам (НОРМА);
 *   named-color  — `<color=игровое_имя>` без hex: TMP такого не знает → потеря
 *                  цвета (обычно значит, что карта цветов ещё не была собрана);
 *   stripped-tag — `<font>/<material>` (мы их вырезаем; остаток = баг);
 *   literal-angle— `<` в роли авторской кавычки (`< Like this… >`), не тег;
 *   tag-in-msgid — в самом ключе есть `<`/`>` (ключ = разметка);
 *   self-fragment— ключ = хвост `rich_text`, хотя строка пришла из `bundle`
 *                  (это уже НАША обрезка `stripRich`, а не данные игры);
 *   game-fragment— ключ = хвост `rich_text` у `dialog` (данные игры, см.
 *                  инвариант `rich-fragment`);
 *   duplicate-tag— один и тот же открывающий тег дважды без закрытия внутри.
 *
 * CLI:
 *   node .opencode/skills/extract-text/scripts/rich_audit.mts [--pot <path>]
 *        [--json] [--examples 10] [--out <md>]
 *
 * Ничего не пишет в `po/`; по умолчанию только печатает отчёт.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { parsePo, type PoEntry } from "./po_file.mts";
import { TMP_TAGS, classifyRich, isMeaningfulText } from "./pot_skip.mts";
import { POT_PATH, writeAtomic } from "./potgen.mts";

/** Один распознанный тег. */
interface Tag {
  raw: string;
  name: string;
  closing: boolean;
  index: number;
}

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Имена цветов, которые Unity TMP разбирает сам (`ColorUtility`): их можно
 * оставлять как есть. Всё остальное (`perversion`, `emotion`, …) — игровые
 * имена из `color_parser_list`: они обязаны быть развёрнуты в hex, иначе TMP
 * цвет не поймёт.
 */
const CSS_COLORS = new Set([
  "red",
  "cyan",
  "blue",
  "darkblue",
  "lightblue",
  "purple",
  "yellow",
  "lime",
  "fuchsia",
  "white",
  "silver",
  "grey",
  "gray",
  "black",
  "orange",
  "brown",
  "maroon",
  "green",
  "olive",
  "navy",
  "teal",
  "aqua",
  "magenta",
]);

/** Регекс известного TMP-тега (та же грамматика, что у `stripTmpTags`). */
const KNOWN_TAG_RX = new RegExp(
  `<\\/?(?:${[...TMP_TAGS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRx)
    .join("|")})(?=[\\s=/>])[^<>]*>`,
  "gi",
);

/** Вырезать известные теги, вернуть их список в порядке появления. */
export function tokenizeTags(s: string): Tag[] {
  const tags: Tag[] = [];
  for (const m of s.matchAll(KNOWN_TAG_RX)) {
    const raw = m[0];
    const name = (/^<\/?([a-z-]+)/i.exec(raw)?.[1] ?? "").toLowerCase();
    tags.push({ raw, name, closing: raw.startsWith("</"), index: m.index ?? 0 });
  }
  return tags;
}

/** Классы одной строки разметки. */
export interface RichProblems {
  unbalanced: string[];
  crossed: string[];
  strayClose: string[];
  unclosed: string[];
  unknownTag: string[];
  malformed: string[];
  namedColor: string[];
  cssColor: string[];
  strippedTag: string[];
  literalAngle: number;
  duplicateTag: string[];
}

/** Разобрать разметку: что сломано, с именами тегов. */
export function richProblems(rich: string): RichProblems {
  const tags = tokenizeTags(rich);
  const out: RichProblems = {
    unbalanced: [],
    crossed: [],
    strayClose: [],
    unclosed: [],
    unknownTag: [],
    malformed: [],
    namedColor: [],
    cssColor: [],
    strippedTag: [],
    literalAngle: 0,
    duplicateTag: [],
  };

  // 0. Цвет без hex: CSS-имя TMP разберёт сам, игровое — нет.
  for (const tag of tags) {
    if (tag.closing || tag.name !== "color") continue;
    const value = (/<color=([^>]*)>/i.exec(tag.raw)?.[1] ?? "").trim().toLowerCase();
    if (!value || value.startsWith("#")) continue;
    if (CSS_COLORS.has(value)) out.cssColor.push(tag.raw.slice(0, 40));
    else out.namedColor.push(tag.raw.slice(0, 40));
  }

  // 1. Баланс и вложенность (по стеку).
  const open = new Map<string, number>();
  const close = new Map<string, number>();
  const stack: string[] = [];
  for (const tag of tags) {
    if (tag.closing) {
      close.set(tag.name, (close.get(tag.name) ?? 0) + 1);
      const top = stack[stack.length - 1];
      if (top === undefined) out.strayClose.push(`</${tag.name}>`);
      else if (top !== tag.name) out.crossed.push(`</${tag.name}> закрывает <${top}>`);
      else stack.pop();
    } else {
      open.set(tag.name, (open.get(tag.name) ?? 0) + 1);
      if (stack.includes(tag.name)) out.duplicateTag.push(`<${tag.name}> внутри <${tag.name}>`);
      stack.push(tag.name);
    }
  }
  out.unclosed = [...stack].map((name) => `<${name}>`);
  for (const name of new Set([...open.keys(), ...close.keys()])) {
    if ((open.get(name) ?? 0) !== (close.get(name) ?? 0)) {
      out.unbalanced.push(`${name}: ${open.get(name) ?? 0} откр / ${close.get(name) ?? 0} закр`);
    }
  }

  // 2. Всё, что не распознано как известный тег.
  let rest = rich;
  for (const tag of [...tags].sort((a, b) => b.index - a.index)) {
    rest =
      rest.slice(0, tag.index) +
      " ".repeat(tag.raw.length) +
      rest.slice(tag.index + tag.raw.length);
  }
  for (const m of rest.matchAll(/<[^<>]*>?/g)) {
    const raw = m[0];
    const body = raw.slice(1).replace(/>$/, "");
    if (body.startsWith(" ") || body === "" || body.startsWith("<")) {
      // `< Like this…` — авторская кавычка (или << — вложенная кавычка).
      out.literalAngle += 1;
      continue;
    }
    if (!raw.endsWith(">")) {
      out.malformed.push(raw.slice(0, 40));
      continue;
    }
    const name = (/^\/?([a-z-]+)/i.exec(body)?.[1] ?? "").toLowerCase();
    if (!name) {
      out.malformed.push(raw.slice(0, 40));
    } else if (name === "color" && !body.includes("#")) {
      const value = (body.split("=")[1] ?? "").trim().toLowerCase();
      if (CSS_COLORS.has(value)) out.cssColor.push(raw.slice(0, 40));
      else out.namedColor.push(raw.slice(0, 40));
    } else if (name === "font" || name === "material") {
      out.strippedTag.push(raw.slice(0, 40));
    } else {
      out.unknownTag.push(raw.slice(0, 40));
    }
  }
  return out;
}

/** Итог по всему POT. */
export interface AuditReport {
  entries: number;
  withRich: number;
  counts: Record<string, number>;
  samples: Record<string, string[]>;
  /** src-ы, где встретился каждый класс (для адресации правки). */
  bySrc: Record<string, Record<string, number>>;
}

const CLASS_KEYS = [
  "unbalanced",
  "crossed",
  "stray-close",
  "unclosed",
  "unknown-tag",
  "malformed",
  "css-color",
  "named-color",
  "stripped-tag",
  "literal-angle",
  "duplicate-tag",
  "tag-in-msgid",
  "self-fragment",
  "game-fragment",
] as const;

/** Аудит разобранных записей POT. */
export function audit(entries: readonly PoEntry[]): AuditReport {
  const counts: Record<string, number> = {};
  const samples: Record<string, string[]> = {};
  const bySrc: Record<string, Record<string, number>> = {};
  for (const key of CLASS_KEYS) {
    counts[key] = 0;
    samples[key] = [];
  }

  let withRich = 0;
  let total = 0;
  for (const e of entries) {
    if (!e.msgid) continue;
    total += 1;
    const rich = e.comments.find((c) => c.startsWith("rich_text: "))?.slice("rich_text: ".length);
    if (!rich) {
      if (/[<>]/.test(e.msgid)) bump("tag-in-msgid", e, e.msgid);
      continue;
    }
    withRich += 1;
    const src = e.comments.find((c) => c.startsWith("src: "))?.slice("src: ".length) ?? "";
    const p = richProblems(rich);
    for (const name of p.unbalanced) bump("unbalanced", e, `${name} :: ${rich}`);
    for (const name of p.crossed) bump("crossed", e, `${name} :: ${rich}`);
    for (const name of p.strayClose) bump("stray-close", e, `${name} :: ${rich}`);
    for (const name of p.unclosed) bump("unclosed", e, `${name} :: ${rich}`);
    for (const name of p.unknownTag) bump("unknown-tag", e, `${name} :: ${rich}`);
    for (const name of p.malformed) bump("malformed", e, `${name} :: ${rich}`);
    for (const name of p.namedColor) bump("named-color", e, `${name} :: ${rich}`);
    for (const name of p.cssColor) bump("css-color", e, `${name} :: ${rich}`);
    for (const name of p.strippedTag) bump("stripped-tag", e, `${name} :: ${rich}`);
    for (const name of p.duplicateTag) bump("duplicate-tag", e, `${name} :: ${rich}`);
    if (p.literalAngle) counts["literal-angle"] += 1;

    const relation = classifyRich(e.msgid, rich).relation;
    if (relation === "suffix" && isMeaningfulText(e.msgid)) {
      bump(src === "bundle" ? "self-fragment" : "game-fragment", e, `${rich} :: ${src}`);
    }
  }
  return { entries: total, withRich, counts, samples, bySrc };

  function bump(cls: string, e: PoEntry, text: string): void {
    counts[cls] = (counts[cls] ?? 0) + 1;
    const src = e.comments.find((c) => c.startsWith("src: "))?.slice("src: ".length) ?? "?";
    if (!bySrc[cls]) bySrc[cls] = {};
    bySrc[cls][src] = (bySrc[cls][src] ?? 0) + 1;
    if ((samples[cls]?.length ?? 0) < 50)
      samples[cls]?.push(`${JSON.stringify(e.msgid)} :: ${text}`);
  }
}

/** Markdown-отчёт (детерминированный порядок классов). */
export function renderReport(report: AuditReport, limit = 10): string {
  const lines = [
    "# Аудит TMP-разметки (`rich_text`) в POT",
    "",
    `Записей: ${report.entries}; с \`#. rich_text:\`: ${report.withRich}.`,
    "Классы не взаимоисключающие: одна строка может попасть в несколько.",
    "",
    "| класс | записей | где (src) |",
    "| --- | --- | --- |",
  ];
  for (const key of CLASS_KEYS) {
    const n = report.counts[key] ?? 0;
    const srcs = Object.entries(report.bySrc[key] ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([src, c]) => `${src} ${c}`)
      .join(", ");
    lines.push(`| \`${key}\` | ${n} | ${srcs || "—"} |`);
  }
  lines.push("");
  for (const key of CLASS_KEYS) {
    const list = report.samples[key] ?? [];
    if (!list.length) continue;
    lines.push(`## ${key} — ${report.counts[key]}`, "");
    for (const sample of list.slice(0, limit)) lines.push(`- ${sample}`);
    if (list.length > limit) lines.push(`- … ещё ${report.counts[key] - limit}`);
    lines.push("");
  }
  return lines.join("\n");
}

const USAGE = `Usage: node rich_audit.mts [--pot <path>] [--json] [--examples 10] [--out <md>]

  --pot <path>   POT (по умолчанию po/template.pot)
  --json         вывести AuditReport как JSON
  --examples <n> примеров на класс (по умолчанию 10)
  --out <md>     записать отчёт в файл (по умолчанию только stdout)`;

interface Cli {
  pot: string;
  json: boolean;
  examples: number;
  out: string | null;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { pot: POT_PATH, json: false, examples: 10, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") cli.json = true;
    else if (arg === "--pot" || arg === "--examples" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`нет значения для ${arg}`);
      if (arg === "--pot") cli.pot = resolve(value);
      else if (arg === "--out") cli.out = resolve(value);
      else cli.examples = Number(value);
    } else if (arg.startsWith("--pot=")) cli.pot = resolve(arg.slice(6));
    else if (arg.startsWith("--out=")) cli.out = resolve(arg.slice(6));
    else if (arg.startsWith("--examples=")) cli.examples = Number(arg.slice(11));
    else throw new Error(`неизвестный аргумент: ${arg}`);
  }
  return cli;
}

function main(argv: string[]): number {
  let cli: Cli;
  try {
    cli = parseArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const report = audit(parsePo(readFileSync(cli.pot, "utf8")));
  if (cli.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  const text = renderReport(report, cli.examples);
  if (cli.out) {
    writeAtomic(cli.out, text);
    console.log(`отчёт: ${cli.out}`);
  } else {
    console.log(text);
  }
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
