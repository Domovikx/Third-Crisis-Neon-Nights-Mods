/**
 * rt_audit.mts — правило «есть rich_text → должен быть rich_translation».
 *
 * Почему правило жёсткое. Рантайм собирает показ так: если есть
 * `rich_translation` — берёт его; иначе пытается подставить перевод внутрь
 * `rich_text` через `Replace`. Второй путь работает ТОЛЬКО когда чистый текст
 * является цельным куском разметки (обёртка `<i>…</i>`). Если теги стоят внутри
 * фразы (`Hehe- That sounds- <color>fun...</color>`), сборка не срабатывает и
 * игрок видит перевод без цвета/курсива. Значит для таких строк `rt` — не
 * украшение, а единственный способ сохранить оформление.
 *
 * CLI:
 *   node scripts/rt_audit.mts [--json] [--strict] [--lang ru]
 *     --strict — exit 1, если хоть где-то не хватает `rt` (для гейта перед релизом)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { parsePo, type PoEntry } from "../.opencode/skills/extract-text/scripts/po_file.mts";

const REPO = join(import.meta.dirname, "..");

/** Разметка с тегами ВНУТРИ текста: `Replace` её не соберёт. */
export function isInlineRich(rich: string): boolean {
  if (!rich) return false;
  const plain = rich.replace(/<[^>]*>/g, "");
  return plain.length > 0 && !rich.includes(plain);
}

/** Есть ли у записи явный перевод разметки (новое имя или старый алиас). */
export function hasRichTranslation(entry: PoEntry): boolean {
  return entry.translator.some((c) => /^rich(_translation)?:/.test(c));
}

export interface RtStat {
  lang: string;
  rich: number;
  inline: number;
  inlineTranslated: number;
  inlineWithRt: number;
  missing: number;
  /** Переводов с тегами при чистом оригинале: теги должны жить в `rt`. */
  tagsInMsgstr: number;
}

/** Посчитать одно PO: сколько inline-строк есть и у скольких нет `rt`. */
export function auditLang(lang: string, poText: string): RtStat {
  const stat: RtStat = {
    lang,
    rich: 0,
    inline: 0,
    inlineTranslated: 0,
    inlineWithRt: 0,
    missing: 0,
    tagsInMsgstr: 0,
  };
  for (const e of parsePo(poText)) {
    if (!e.msgid) continue;
    if (!/<[^>]+>/.test(e.msgid) && /<[^>]+>/.test(e.msgstr)) stat.tagsInMsgstr += 1;
    const rich = e.comments.find((c) => c.startsWith("rich_text: "))?.slice(11) ?? "";
    if (!rich) continue;
    stat.rich += 1;
    if (!isInlineRich(rich)) continue;
    stat.inline += 1;
    if (e.msgstr) stat.inlineTranslated += 1;
    if (hasRichTranslation(e)) stat.inlineWithRt += 1;
    else if (e.msgstr) stat.missing += 1;
  }
  return stat;
}

interface Cli {
  json: boolean;
  strict: boolean;
  lang: string | null;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { json: false, strict: false, lang: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") cli.json = true;
    else if (argv[i] === "--strict") cli.strict = true;
    else if (argv[i] === "--lang") cli.lang = argv[++i] ?? null;
    else throw new Error(`неизвестный аргумент: ${argv[i]}`);
  }
  return cli;
}

function main(argv: string[]): number {
  let cli: Cli;
  try {
    cli = parseArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 2;
  }
  const langs = cli.lang
    ? [cli.lang]
    : ["zh", "ru", "es", "pt", "de", "ja", "fr", "pl", "ko", "it"];
  const stats = langs
    .map((l) => {
      try {
        return auditLang(l, readFileSync(join(REPO, "po", `${l}.po`), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((s): s is RtStat => s !== null);

  if (cli.json) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log("язык  rich  inline  переведено  с rt  без rt  теги-в-msgstr");
    for (const s of stats) {
      console.log(
        `${s.lang.padEnd(4)} ${String(s.rich).padStart(5)} ${String(s.inline).padStart(7)} ` +
          `${String(s.inlineTranslated).padStart(11)} ${String(s.inlineWithRt).padStart(5)} ` +
          `${String(s.missing).padStart(6)} ${String(s.tagsInMsgstr).padStart(6)}`,
      );
    }
    const missing = stats.reduce((n, s) => n + s.missing, 0);
    console.log(`\nбез rich_translation (потеряют оформление): ${missing}`);
  }
  const missing = stats.reduce((n, s) => n + s.missing, 0);
  return cli.strict && (missing > 0 || stats.some((s) => s.tagsInMsgstr > 0)) ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
