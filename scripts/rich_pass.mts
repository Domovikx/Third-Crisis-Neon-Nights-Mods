/**
 * rich_pass.mts — заполнить `rich_translation` для строк с тегами ВНУТРИ фразы.
 *
 * Зачем: на таких строках рантайм не может собрать разметку сам (`Replace` ищет
 * чистый текст цельным куском), поэтому без `rt` игрок видит перевод без
 * цвета/курсива. Правило «есть rich_text → есть rich_translation» описано в
 * `docs/rich-text-audit.md` и проверяется `npm run rt:audit`.
 *
 * Как работает: берём готовый `msgstr` (перевод), просим модель расставить те же
 * теги вокруг соответствующих слов перевода, затем ЖЁСТКО проверяем:
 *   - набор тегов совпадает с оригиналом (имя+параметры, мультимножество);
 *   - теги сбалансированы;
 *   - текст без тегов равен `msgstr` (с точностью до пробелов).
 * Не прошло — строка остаётся без `rt` и попадает в отчёт (ничего не портим).
 *
 * CLI:
 *   node scripts/rich_pass.mts --lang ru [--limit 20] [--dry]
 *        [--url http://127.0.0.1:1234] [--model index-translate-9b]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { parsePo, type PoEntry } from "../.opencode/skills/extract-text/scripts/po_file.mts";

const REPO = join(import.meta.dirname, "..");

/** Теги TMP: имя + параметры как есть (`<color=#fff>` ≠ `<color=#000>`). */
const TAG_RX = /<\/?[a-zA-Z][^<>]*>/g;

/** Мультимножество тегов (порядок не важен, параметры важны). */
export function tagSet(s: string): string[] {
  return (s.match(TAG_RX) ?? []).slice().sort();
}

/** Текст без тегов, пробелы схлопнуты (для сверки с msgstr). */
export function plainOf(s: string): string {
  return s.replace(TAG_RX, "").replace(/\s+/g, " ").trim();
}

/** Незакрытые теги, оставшиеся в стеке (для сверки «как в оригинале»). */
export function openStack(s: string): string[] {
  const stack: string[] = [];
  for (const tag of s.match(TAG_RX) ?? []) {
    const name = /^<\/?([a-zA-Z]+)/.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (tag.startsWith("</")) {
      if (stack[stack.length - 1] === name) stack.pop();
      else stack.push(`!${name}`); // перекрещенное закрытие помечаем
    } else if (!tag.endsWith("/>")) {
      stack.push(name);
    }
  }
  return stack;
}

/**
 * Годится ли предложенный `rt` для записи.
 *
 * Возвращает причину отказа или null. Требования:
 *   - набор тегов (имя+параметры) совпадает с оригиналом;
 *   - текст без тегов совпадает с уже принятым переводом;
 *   - структура вложенности — как в оригинале. Именно «как в оригинале», а не
 *     «идеально»: в данных игры 192 строки с незакрытым `<i>` (AN обрезал
 *     хвост), и такой же незакрытый тег в переводе — правильный ответ, TMP
 *     трактует его как «курсив до конца строки».
 */
export function validateRt(rich: string, msgstr: string, candidate: string): string | null {
  const want = tagSet(rich);
  const got = tagSet(candidate);
  if (want.length !== got.length || want.some((t, i) => t !== got[i])) return "tags differ";
  if (plainOf(candidate) !== plainOf(msgstr)) return "plain differs";
  const a = openStack(rich);
  const b = openStack(candidate);
  if (a.length !== b.length || a.some((t, i) => t !== b[i])) return "nesting differs";
  return null;
}

/** Записи, которым нужен `rt`: inline-разметка, есть перевод, нет `rt`. */
export function needRt(entries: PoEntry[], richMap: ReadonlyMap<string, string>): PoEntry[] {
  const out: PoEntry[] = [];
  for (const e of entries) {
    if (!e.msgid || !e.msgstr) continue;
    if (e.translator.some((c) => /^rich(_translation)?:/.test(c))) continue;
    const rich = richMap.get(e.msgid);
    if (!rich) continue;
    const plain = plainOf(rich);
    if (!plain || rich.includes(plain)) continue; // обёртку соберут и так
    out.push(e);
  }
  return out;
}

/**
 * Подсвеченные фрагменты: текст внутри inline-тегов.
 *
 * Модели нужно знать, ЧТО подсвечено: иначе она не может найти соответствие в
 * переводе и либо пересказывает, либо оставляет тег висеть. Пример:
 * `<i>(<color>F-Fuck!</color> That was too close!)</i>` → `F-Fuck!`.
 */
export function highlighted(rich: string): string[] {
  const out: string[] = [];
  const rx = /<([a-zA-Z]+)(?:=[^<>]*)?>([^<>]+)<\/\1>/g;
  for (const m of rich.matchAll(rx)) {
    const text = m[2].trim();
    if (text) out.push(text);
  }
  return out;
}

/** Простая inline-пара: тег + текст внутри (без вложенных тегов). */
export interface InlineSpan {
  open: string;
  inner: string;
  close: string;
}

/** Найти пары «тег → текст → тот же закрывающий тег» внутри строки. */
export function inlineSpans(rich: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  const rx = /<([a-zA-Z]+)(?:=[^<>]*)?>([^<>]+)<\/\1>/g;
  for (const m of rich.matchAll(rx)) {
    out.push({ open: m[0].slice(0, m[0].indexOf(">") + 1), inner: m[2], close: `</${m[1]}>` });
  }
  return out;
}

/**
 * Собрать `rt` из готового перевода и выбранных фрагментов.
 *
 * Модель не переписывает текст, а только указывает, каким куском перевода
 * соответствует подсвеченное слово. Текст без тегов поэтому гарантированно
 * равен `msgstr` — сборка детерминированная.
 *
 * `picks[i]` — подстрока `msgstr` для `spans[i]`; ищем по порядку, чтобы две
 * одинаковые подсветки не наложились.
 */
export function buildRtWithSpans(
  msgstr: string,
  spans: readonly InlineSpan[],
  picks: readonly string[],
): string | null {
  if (spans.length !== picks.length) return null;
  let out = msgstr;
  let cursor = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const pick = picks[i].trim();
    if (!pick) return null;
    const at = out.indexOf(pick, cursor);
    if (at < 0) return null;
    out = `${out.slice(0, at)}${spans[i].open}${pick}${spans[i].close}${out.slice(at + pick.length)}`;
    cursor = at + spans[i].open.length + pick.length + spans[i].close.length;
  }
  return out;
}

/** Вставить `# rich_translation:` перед `msgctxt`/`msgid` нужных записей. */
export function insertRtComments(text: string, updates: ReadonlyMap<string, string>): string {
  if (updates.size === 0) return text;
  // PO — блоки, разделённые пустой строкой; правим блок целиком, чтобы не
  // зависеть от порядка `#.`/`msgctxt`/`msgid` внутри записи.
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const m = /^msgid "(.*)"$/m.exec(block);
      if (!m) return block;
      const key = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      const value = updates.get(key);
      return value === undefined ? block : `# rich_translation: ${value}\n${block}`;
    })
    .join("\n\n");
}

interface Cli {
  lang: string;
  limit: number;
  dry: boolean;
  url: string;
  model: string;
  mode: "markup" | "span";
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    lang: "ru",
    limit: 0,
    dry: false,
    url: "http://127.0.0.1:1234",
    model: "index-translate-9b",
    mode: "markup",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`нет значения для ${a}`);
      return v;
    };
    if (a === "--dry") cli.dry = true;
    else if (a === "--lang") cli.lang = val();
    else if (a === "--limit") cli.limit = Number(val());
    else if (a === "--url") cli.url = val();
    else if (a === "--model") cli.model = val();
    else if (a === "--mode") {
      const mode = val();
      if (mode !== "markup" && mode !== "span") throw new Error(`--mode: markup|span, не ${mode}`);
      cli.mode = mode;
    } else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return cli;
}

const SYS = `You preserve markup while translating game text.
Input: an original line with TMP tags, and its finished translation without tags.
Task: put the SAME tags around the corresponding words of the translation.
Rules: do not change the translation wording; every tag must appear exactly once,
with the same name and same parameters; reply with one line only, no explanation.`;

async function markup(
  url: string,
  model: string,
  rich: string,
  msgstr: string,
  marks: string[],
  hint = "",
): Promise<string> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYS },
        {
          role: "user",
          content: `original: ${rich}\ntranslation: ${msgstr}${hint ? `\n${hint}` : ""}`,
        },
      ],
      temperature: 0,
      max_tokens: 500,
      // LM Studio понимает reasoning_effort, llama.cpp — только шаблон.
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (json.choices?.[0]?.message?.content ?? "").trim().split(/\r?\n/)[0] ?? "";
}

/**
 * Спросить у модели, каким фрагментом перевода передан подсвеченный текст.
 *
 * Ответ — только подстрока перевода (копия), без кавычек и пояснений. Если
 * модель ничего не нашла или ответила фразой — считаем, что соответствия нет.
 */
async function pickSpan(
  url: string,
  model: string,
  inner: string,
  msgstr: string,
): Promise<string> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You map a highlighted fragment of an English line to the exact words of its finished translation. " +
            "Reply with ONLY that fragment copied verbatim from the translation, no quotes, no explanation. " +
            "If the translation has no corresponding words, reply with an empty line.",
        },
        {
          role: "user",
          content: `highlighted: ${inner}
translation: ${msgstr}`,
        },
      ],
      temperature: 0,
      max_tokens: 120,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (json.choices?.[0]?.message?.content ?? "").trim().replace(/^["'«»]+|["'«»]+$/g, "");
}

async function main(argv: string[]): Promise<number> {
  let cli: Cli;
  try {
    cli = parseArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 2;
  }
  const potPath = join(REPO, "po", "template.pot");
  const poPath = join(REPO, "po", `${cli.lang}.po`);
  const richMap = new Map<string, string>();
  for (const e of parsePo(readFileSync(potPath, "utf8"))) {
    const rich = e.comments.find((c) => c.startsWith("rich_text: "))?.slice(11);
    if (rich) richMap.set(e.msgid, rich);
  }
  const poText = readFileSync(poPath, "utf8");
  const todoAll = needRt(parsePo(poText), richMap);
  const todo = cli.limit ? todoAll.slice(0, cli.limit) : todoAll;
  console.log(`${cli.lang}: нужен rt — ${todoAll.length}, берём ${todo.length}`);
  if (cli.dry) {
    for (const e of todo.slice(0, 10)) console.log("  •", JSON.stringify(e.msgid.slice(0, 70)));
    return 0;
  }

  const updates = new Map<string, string>();
  const failed: string[] = [];
  let lastProblem = "";
  for (const [i, e] of todo.entries()) {
    const rich = richMap.get(e.msgid) as string;
    if (cli.mode === "span") {
      const spans = inlineSpans(rich);
      const picks: string[] = [];
      let ok = spans.length > 0;
      for (const span of spans) {
        try {
          const pick = await pickSpan(cli.url, cli.model, span.inner, e.msgstr);
          if (!pick || !e.msgstr.includes(pick)) {
            ok = false;
            break;
          }
          picks.push(pick);
        } catch (err) {
          console.error(`LLM: ${(err as Error).message}`);
          ok = false;
          break;
        }
      }
      const built = ok ? buildRtWithSpans(e.msgstr, spans, picks) : null;
      if (built && !validateRt(rich, e.msgstr, built)) {
        updates.set(e.msgid, built);
      } else {
        failed.push(`${e.msgid}  ⟵ span: ${ok ? "не собралось" : "нет соответствия"}`);
      }
      if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${todo.length}`);
      continue;
    }

    let candidate = "";
    let hint = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        candidate = await markup(cli.url, cli.model, rich, e.msgstr, highlighted(rich), hint);
      } catch (err) {
        if (attempt === 3) console.error(`LLM: ${(err as Error).message}`);
        continue;
      }
      const problem = validateRt(rich, e.msgstr, candidate);
      lastProblem = problem ?? "";
      if (!problem) break;
      // Следующая попытка — с точным указанием, что не так: модель чаще всего
      // пересказывает текст, а нужен буквальный перенос перевода.
      hint =
        problem === "plain differs"
          ? `WRONG: text without tags was "${plainOf(candidate)}" but it MUST be exactly "${plainOf(e.msgstr)}". Copy the translation verbatim, only insert the tags.`
          : `WRONG: ${problem}. Tags must match the original exactly (same names, same parameters, same nesting).`;
      candidate = "";
    }
    if (candidate && !validateRt(rich, e.msgstr, candidate)) {
      updates.set(e.msgid, candidate);
    } else {
      failed.push(`${e.msgid}  ⟵ ${lastProblem || "no answer"}`);
    }
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${todo.length}`);
  }

  if (updates.size) {
    writeFileSync(poPath, insertRtComments(poText, updates), "utf8");
  }
  console.log(`готово: записано ${updates.size}, не прошло ${failed.length}`);
  for (const m of failed.slice(0, 12)) console.log("  ✗", m.slice(0, 140));
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
