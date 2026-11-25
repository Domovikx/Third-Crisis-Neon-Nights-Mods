/**
 * rich_gate.mts — гейт `rich_translation` (контракт владельца, 2026-11-24).
 *
 * Правило: в `po/<lang>.po` под КАЖДОЙ строкой `#. rich_text: …` идёт строка
 * `#. rich_translation: …`; значение = `msgstr` + те же теги в том же порядке.
 * Непереведённая строка (`msgstr ""`) — пустая заготовка, это норма.
 *
 * Два уровня:
 *   1. PO (adjacency): соседняя строка, непустота при переводе, совпадение
 *      последовательности тегов и текста.
 *   2. `.dat` ↔ POT по ключам: каждый ключ POT с `rich_text` (минус `#, skip`)
 *      обязан иметь размеченный перевод в `.dat`, и наоборот.
 *
 * CLI:
 *   node scripts/rich_gate.mts [--lang ru|all] [--dat] [--root <dir>] [--allow-review]
 *
 * `#, rt-review` — это «ждёт человека», а не «проверено»: при открытых
 * review-строках гейт красный (exit ≠ 0). `--allow-review` — осознанный режим
 * «смотреть только нарушения разметки».
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import { findArtifacts, parseTags, tagRaws } from "./rich_tags.mts";

const REPO = join(import.meta.dirname, "..");
export const LANGS = ["zh", "ru", "es", "pt", "de", "ja", "fr", "pl", "ko", "it"] as const;

/** Теги по настоящему парсеру: авторские `< … >` и `<< … >>` — не теги. */
export const tagSequence = (s: string): string[] => tagRaws(s);
export const denseText = (s: string): string => s.replace(/<[^<>]*>/g, "").replace(/\s+/gu, "");

export const RICH_LINE = /^#\. rich_text: (.*)$/m;
export const RT_LINE = /^#\. rich_translation:(?: (.*))?$/m;

export interface PoGate {
  lang: string;
  /** Записей с `#. rich_text:`. */
  rich: number;
  /** Пар с правильным соседством. */
  adjacent: number;
  /** Пустых заготовок (msgstr пустой). */
  stubs: number;
  /** Пустой `rich_translation` при непустом `msgstr`. */
  emptyForTranslated: string[];
  /** Соседней строки нет / она не `rich_translation`. */
  notAdjacent: string[];
  /** Последовательность тегов разошлась. */
  tagMismatch: { key: string; rich: string[]; rt: string[] }[];
  /** Текст `rich_translation` не равен `msgstr`. */
  textMismatch: { key: string; rt: string; msgstr: string }[];
  /** Старые `# rich_translation:` / `# rich:` — не мигрированы. */
  legacy: number;
  /** `rich_text` без тегов (шум дампа): переносить нечего, нужен человек. */
  untagged: string[];
  /** Тег вокруг пустоты/пробела/пунктуации — игрок это видит. */
  artifacts: { key: string; problems: string[] }[];
  /** Строки, где часть тегов не подтвердилась и ждёт человека (`#, rt-review`). */
  review: string[];
  /** Ключи (msgid) этих записей — для сверки с `.dat`. */
  keys: Set<string>;
}

/** Проверить один PO-файл по правилу adjacency. */
export function auditPoText(lang: string, raw: string): PoGate {
  // EOL нормализуем до LF: иначе `split(/\n\n/)` не делит CRLF-блоки, а `$`
  // без `/m` не матчит строку с `\r` — гейт молча проверяет 0 записей и
  // показывает ложный зелёный на любом CRLF-PO.
  const text = raw.replace(/\r\n?/g, "\n");
  const out: PoGate = {
    lang,
    rich: 0,
    adjacent: 0,
    stubs: 0,
    emptyForTranslated: [],
    notAdjacent: [],
    tagMismatch: [],
    textMismatch: [],
    legacy: 0,
    untagged: [],
    artifacts: [],
    review: [],
    keys: new Set<string>(),
  };
  for (const block of text.split(/\n\n/)) {
    const lines = block.split("\n");
    if (lines.some((l) => l.startsWith("# rich_translation:") || l.startsWith("# rich:")))
      out.legacy += 1;
    const at = lines.findIndex((l) => RICH_LINE.test(l));
    if (at < 0) continue;
    const rich = (RICH_LINE.exec(lines[at]) as RegExpExecArray)[1];
    const entry = parsePo(block).find((e) => e.msgid !== undefined);
    const msgstr = entry?.msgstr ?? "";
    const key = entry?.msgid ?? "";
    out.rich += 1;
    out.keys.add(key);
    const flagged = (entry?.flags ?? []).includes("rt-review");
    const rtMatch = RT_LINE.exec(lines[at + 1] ?? "");
    if (!rtMatch) {
      out.notAdjacent.push(key.slice(0, 80));
      continue;
    }
    out.adjacent += 1;
    const rt = rtMatch[1] ?? "";
    if (!msgstr) {
      out.stubs += 1;
      continue;
    }
    if (!rt) {
      out.emptyForTranslated.push(key.slice(0, 80));
      continue;
    }
    const problems = findArtifacts(rt);
    if (problems.length) out.artifacts.push({ key: key.slice(0, 80), problems });
    if (!parseTags(rich).length) {
      // Битая разметка источника (шум дампа): переносить нечего. Пара обязана
      // быть, но сверить теги/текст не с чем — строка в отчёте.
      out.untagged.push(rich.slice(0, 80));
      continue;
    }
    if (denseText(rt) !== denseText(msgstr)) {
      out.textMismatch.push({
        key: key.slice(0, 80),
        rt: rt.slice(0, 80),
        msgstr: msgstr.slice(0, 80),
      });
      continue;
    }
    if (flagged) {
      // Позиция тега не подтверждена: теги сняты осознанно, строка ждёт
      // человека. Это НЕ «всё хорошо», поэтому ключ виден в списке.
      out.review.push(key.slice(0, 80));
      continue;
    }
    const richTags = tagSequence(rich);
    const rtTags = tagSequence(rt);
    if (richTags.length !== rtTags.length || richTags.some((t, i) => t !== rtTags[i])) {
      out.tagMismatch.push({ key: key.slice(0, 80), rich: richTags, rt: rtTags });
    }
  }
  return out;
}

/** Ключи POT с `rich_text`, которые обязаны получить размеченный перевод. */
export function potRichKeys(potText: string): Set<string> {
  const out = new Set<string>();
  for (const e of parsePo(potText)) {
    if (!e.msgid) continue;
    if (!e.comments.some((c) => c.startsWith("rich_text: "))) continue;
    if (e.flags.includes("skip")) continue;
    out.add(e.msgid);
  }
  return out;
}

/**
 * Переведённые ключи PO (`msgstr` непустой).
 *
 * Требование `rich_translation` применяется только к переведённым строкам:
 * у непереведённой держится пустая заготовка, и в `.dat` размеченного перевода
 * у неё быть не может. Поэтому «ожидаемое» множество ключей для языка —
 * `potRichKeys ∩ poTranslatedKeys`.
 */
export function poTranslatedKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const e of parsePo(text)) {
    if (!e.msgid || !e.msgstr) continue;
    out.add(e.msgid);
  }
  return out;
}

/** Ключи `.dat`, у которых есть непустой `rt` (размеченный перевод). */
export function datRtKeys(datText: string): Set<string> {
  const out = new Set<string>();
  for (const line of datText.split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as { t: string; rt?: string };
    if (row.rt) out.add(row.t);
  }
  return out;
}

function main(argv: string[]): number {
  let root = REPO;
  let langs: string[] = [...LANGS];
  let checkDat = false;
  let allowReview = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dat") checkDat = true;
    else if (a === "--allow-review") allowReview = true;
    else if (a === "--root") {
      const v = argv[++i];
      if (!v) throw new Error("--root: нужен каталог");
      root = resolve(v);
    } else if (a === "--lang") {
      const v = argv[++i] ?? "";
      if (v === "all") langs = [...LANGS];
      else if (!(LANGS as readonly string[]).includes(v)) throw new Error(`неизвестный язык: ${v}`);
      else langs = [v];
    } else throw new Error(`неизвестный аргумент: ${a}`);
  }
  const potKeysAll = checkDat
    ? potRichKeys(readFileSync(join(root, "po", "template.pot"), "utf8"))
    : new Set<string>();
  console.log(
    "язык  rich  пар  заготовок  без пары  пустых  теги≠  текст≠  артефакты  на человеке  legacy  dat≠",
  );
  let bad = 0;
  let reviewTotal = 0;
  for (const lang of langs) {
    const poText = readFileSync(join(root, "po", `${lang}.po`), "utf8");
    const r = auditPoText(lang, poText);
    let datDiff = "-";
    if (checkDat) {
      const translated = poTranslatedKeys(poText);
      const potKeys = new Set([...potKeysAll].filter((k) => translated.has(k)));
      const datKeys = datRtKeys(readFileSync(join(root, "runtime", `patch_${lang}.dat`), "utf8"));
      const missing = [...potKeys].filter((k) => !datKeys.has(k)).length;
      const extra = [...datKeys].filter((k) => !potKeys.has(k)).length;
      datDiff = `${missing}+${extra}`;
      bad += missing + extra;
    }
    bad +=
      r.emptyForTranslated.length +
      r.notAdjacent.length +
      r.tagMismatch.length +
      r.textMismatch.length +
      r.artifacts.length +
      r.legacy;
    // `#, rt-review` = разметку ждёт человек. Молча-зелёный гейт при 1400
    // открытых строках — дефект: без `--allow-review` они считаются отказом.
    reviewTotal += r.review.length;
    if (!allowReview) bad += r.review.length;
    console.log(
      `${lang.padEnd(4)} ${String(r.rich).padStart(5)} ${String(r.adjacent).padStart(4)} ` +
        `${String(r.stubs).padStart(9)} ${String(r.notAdjacent.length).padStart(8)} ` +
        `${String(r.emptyForTranslated.length).padStart(6)} ${String(r.tagMismatch.length).padStart(6)} ` +
        `${String(r.textMismatch.length).padStart(6)} ${String(r.artifacts.length).padStart(10)} ` +
        `${String(r.review.length).padStart(11)} ${String(r.legacy).padStart(6)} ${String(datDiff).padStart(6)}`,
    );
    for (const k of r.notAdjacent.slice(0, 3)) console.log(`  ! нет пары: ${k}`);
    for (const k of r.emptyForTranslated.slice(0, 3)) console.log(`  ! пустой rt: ${k}`);
    for (const x of r.tagMismatch.slice(0, 3))
      console.log(
        `  ! теги: ${x.key}\n      rich ${x.rich.join(" ")}\n      rt   ${x.rt.join(" ")}`,
      );
    for (const x of r.textMismatch.slice(0, 3)) console.log(`  ! текст: ${x.key}`);
    for (const x of r.artifacts.slice(0, 3))
      console.log(`  ! артефакт: ${x.key} — ${x.problems.join("; ").slice(0, 90)}`);
    if (r.untagged.length) console.log(`  ~ rich_text без тегов (шум дампа): ${r.untagged.length}`);
  }
  if (bad) {
    const note =
      reviewTotal && !allowReview
        ? ` (из них на человеке: ${reviewTotal}; осознанно пропустить — --allow-review)`
        : "";
    console.log(`\nнарушений: ${bad}${note}`);
  } else if (reviewTotal) {
    console.log(`\nнарушений нет (на человеке: ${reviewTotal}, пропущено по --allow-review)`);
  } else {
    console.log("\nнарушений нет");
  }
  return bad ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
