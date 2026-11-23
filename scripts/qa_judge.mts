/**
 * qa_judge.mts — оценка качества `po/<lang>.po`: судья на грубые ошибки +
 * механический аудит регистра 18+.
 *
 * Два независимых слоя, потому что они ловят разное:
 * 1. СУДЬЯ (локальная LLM, бинарный вердикт) — только ГРУБЫЕ ошибки: чужая
 *    строка, перевёрнутый смысл, потерянный/выдуманный факт, сломанная
 *    грамматика, пол, противоречащий адресату. Промпт — проверенный в TSSR
 *    (v10: recall 61/64, 0 ложных на чистых). Регистр судье НЕ доверяем: на
 *    прогоне 2026-11-23 девятимиллиардная модель флагнула стоны как
 *    «клинические» и нормальную наррацию как «смягчённую».
 * 2. ЛЕКСИКОН (`register_lexicon.mts`) — клинические термины и потеря
 *    откровенности: детерминированно, без модели.
 *
 * Судья ничего не правит: он выдаёт список строк на вычитку, который потом
 * скармливается `translate_local --improve --keys <файл>`.
 *
 * CLI:
 *   node scripts/qa_judge.mts --lang ru [--n 200] [--phase 0]
 *        [--url http://127.0.0.1:8081] [--model index-translate-9b]
 *        [--out tmp/qa-judge] [--keys tmp/qa-judge-ru.bad.jsonl]
 *
 * Выход: `<out>.jsonl` (все вердикты), `<out>.bad.jsonl` (на вычитку),
 * `<out>.md` (сводка).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { parsePo, type PoEntry } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import { leakHits } from "./leak_guard.mts";
import { LATIN_CYRILLIC_LANGS, foreignScriptHits } from "./script_guard.mts";
import { clinicalHits, softenedHits } from "./register_lexicon.mts";
import { inKeys, readKeys } from "../.opencode/skills/pipeline-common/scripts/qa_keys.mts";
import { loadGenderMap } from "./speaker_gender.mts";

const REPO = join(import.meta.dirname, "..");

/** Оценка одной строки глазами судьи (0–10) и причина. */
export interface Verdict {
  /** ok = 10, bad = 2: разрыв, чтобы средняя честно показывала долю брака. */
  score: number;
  bad: boolean;
  reason: string;
  /** Размерности, если модель вернула rubric-форму. */
  dims?: { content?: string; grammar?: string; gender?: string };
}

/**
 * Разобрать ответ судьи.
 *
 * Модель отвечает JSON, но любит обрамлять его текстом или markdown-забором,
 * поэтому берём первый {...} в ответе. Принимаем обе формы: бинарную
 * `{"verdict":"ok|bad"}` и rubric `{"content","grammar","gender","verdict"}`.
 */
export function parseVerdict(text: string): Verdict | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[0]) as Record<string, unknown>;
    const verdict = String(raw.verdict ?? "").toLowerCase();
    const dims = {
      content: raw.content === undefined ? undefined : String(raw.content).toLowerCase(),
      grammar: raw.grammar === undefined ? undefined : String(raw.grammar).toLowerCase(),
      gender: raw.gender === undefined ? undefined : String(raw.gender).toLowerCase(),
    };
    const hasDims = [dims.content, dims.grammar, dims.gender].some((d) => d !== undefined);
    const anyBad = [dims.content, dims.grammar, dims.gender].includes("bad");
    // Без вердикта и без размерностей судить не о чем: это не «всё хорошо».
    if (verdict === "" && !hasDims) return null;
    const bad = verdict === "bad" || anyBad;
    return { score: bad ? 2 : 10, bad, reason: String(raw.reason ?? "").slice(0, 80), dims };
  } catch {
    return null;
  }
}

/**
 * Равномерная выборка по корпусу с фазой.
 *
 * Фаза сдвигает окно, чтобы волны не судили одни и те же строки (как в TSSR:
 * `JUDGE_PHASE`). Возвращает индексы, чтобы отчёт ссылался на конкретные строки.
 */
export function sampleIndexes(total: number, n: number, phase = 0): number[] {
  if (n <= 0 || total <= 0) return [];
  const step = Math.max(1, Math.floor(total / n));
  const out: number[] = [];
  for (
    let i = (phase * Math.max(1, Math.floor(step / 3))) % step;
    i < total && out.length < n;
    i += step
  ) {
    out.push(i);
  }
  return out;
}

/** Кандидаты для суда: переведённые, не skip, осмысленный текст. */
export function candidates(entries: PoEntry[]): PoEntry[] {
  return entries.filter(
    (e) =>
      e.msgid &&
      e.msgstr &&
      !e.flags.includes("skip") &&
      /\p{L}{3}/u.test(e.msgid) &&
      !/^[\d\s.,:;!?()-]+$/.test(e.msgid),
  );
}

/**
 * SYSTEM судьи: только грубые ошибки (перенос промпта TSSR v10, проверен
 * E2E на 64 эталонных дефектах). Регистр и стиль исключены намеренно.
 */
export const JUDGE_SYS = `You are a strict translation QA checker for a game. You get an English SOURCE line, its Russian TRANSLATION, and the SPEAKER (game data; "narration" means an inner thought or description).
Judge three dimensions separately, then set verdict:
- content: "bad" if the translation is about DIFFERENT content than the source (wrong line, or text from a neighbouring line glued in), inverted meaning, or missing/invented key information. Idioms count with their contextual meaning (in erotic scenes "come" = orgasm); a plausible reading of an odd/ambiguous SOURCE is correct.
- grammar: "bad" only if grammar is broken so it distorts the text. Russian has NO articles — article differences are never an error. Never style, word choice, register, literalness, tone, punctuation, minor awkwardness that keeps the meaning.
- gender: "bad" only if forms contradict the SPEAKER or the person ADDRESSED (2nd-person past follows the addressee, not the speaker).
verdict = "bad" if ANY dimension is "bad", else "ok".
Answer ONLY JSON {"content":"ok|bad","grammar":"ok|bad","gender":"ok|bad","verdict":"ok|bad","reason":"max8 words"}.`;

/**
 * SYSTEM второй ступени: проверить ОДНО обвинение.
 *
 * Первая ступень («найди, что не так») склонна к придиркам: на выборке
 * 2026-11-23 из 7 «грубых» реальными были 2 — парафраз, эротическая идиома и
 * кривой источник принимались за ошибку. Проверка одного обвинения с готовыми
 * примерами отказов снимает большую часть ложных (приём TSSR, E2E-итерация
 * v10+verify).
 */
export const VERIFY_SYS = `You verify ONE accusation against a Russian translation of a game. You get the English SOURCE line, the TRANSLATION, and the ACCUSED ERROR.
Confirm if a reader would misunderstand the scene: a different ACTION or OBJECT than the source, opposite meaning, a dropped or invented FACT, broken grammar, or wrong gender forms.
Dismiss if the translation says the same thing in other words: synonyms, a pronoun instead of a name, register, literalness, punctuation, idioms in context, garbled SOURCE, asset names and UI labels.
Answer ONLY JSON {"verdict":"confirmed"|"dismissed","reason":"max8 words"}.`;

/** Вердикт второй ступени. */
export function parseConfirm(text: string): boolean | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const v = String((JSON.parse(m[0]) as { verdict?: unknown }).verdict ?? "").toLowerCase();
    if (v === "confirmed") return true;
    if (v === "dismissed") return false;
    return null;
  } catch {
    return null;
  }
}

async function verify(
  url: string,
  model: string,
  en: string,
  ru: string,
  speaker: string,
  accusation: string,
): Promise<boolean | null> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: VERIFY_SYS },
        {
          role: "user",
          content: `SPEAKER: ${speaker}
SOURCE: ${en}
TRANSLATION: ${ru}
ACCUSED ERROR: ${accusation}`,
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
  return parseConfirm(json.choices?.[0]?.message?.content ?? "");
}

async function judge(
  url: string,
  model: string,
  en: string,
  ru: string,
  speaker: string,
): Promise<Verdict | null> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: JUDGE_SYS },
        { role: "user", content: `SPEAKER: ${speaker}\nSOURCE: ${en}\nTRANSLATION: ${ru}` },
      ],
      temperature: 0,
      max_tokens: 200,
      // Thinking гасим ДВУМЯ полями: LM Studio понимает reasoning_effort,
      // llama.cpp — только chat_template_kwargs (проверено 2026-11-23).
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return parseVerdict(json.choices?.[0]?.message?.content ?? "");
}

interface Cli {
  lang: string;
  n: number;
  phase: number;
  url: string;
  model: string;
  out: string;
  keys: string | null;
  verify: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    lang: "ru",
    n: 100,
    phase: 0,
    url: "http://127.0.0.1:8081",
    model: "index-translate-9b",
    out: "tmp/qa-judge",
    keys: null,
    verify: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`нет значения для ${a}`);
      return v;
    };
    if (a === "--lang") cli.lang = val();
    else if (a === "--n") cli.n = Number(val());
    else if (a === "--phase") cli.phase = Number(val());
    else if (a === "--url") cli.url = val();
    else if (a === "--model") cli.model = val();
    else if (a === "--out") cli.out = val();
    else if (a === "--keys") cli.keys = val();
    else if (a === "--no-verify") cli.verify = false;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  cli.out = join(REPO, cli.out.endsWith(`-${cli.lang}`) ? cli.out : `${cli.out}-${cli.lang}`);
  return cli;
}

async function main(argv: string[]): Promise<number> {
  let cli: Cli;
  try {
    cli = parseArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 2;
  }
  const entries = parsePo(readFileSync(join(REPO, "po", `${cli.lang}.po`), "utf8"));
  // Пол спикера помогает судье ловить ошибки согласования, а не догадываться.
  const genders = loadGenderMap(REPO);
  const pool = candidates(entries);
  let todo: PoEntry[];
  if (cli.keys) {
    const keys = readKeys(readFileSync(join(REPO, cli.keys), "utf8"));
    todo = pool.filter((e) => inKeys(e, keys));
    console.log(`${cli.lang}: по списку ${keys.size} — найдено ${todo.length}`);
  } else {
    todo = sampleIndexes(pool.length, cli.n, cli.phase).map((i) => pool[i]);
    console.log(`${cli.lang}: кандидатов ${pool.length}, судим ${todo.length} (фаза ${cli.phase})`);
  }

  const rows: {
    c: string;
    m: string;
    ru: string;
    verdict: Verdict;
    clinical: string[];
    softened: string[];
    leak: string[];
    script: string[];
  }[] = [];
  let failed = 0;
  for (const [i, e] of todo.entries()) {
    const speaker = e.msgctxt.startsWith("speaker:")
      ? e.msgctxt.slice(8) || "narration"
      : "narration";
    const g = genders.get(speaker);
    const speakerLine = g ? `${speaker} (${g})` : speaker;
    let v: Verdict | null = null;
    for (let attempt = 1; attempt <= 2 && !v; attempt += 1) {
      try {
        v = await judge(cli.url, cli.model, e.msgid, e.msgstr, speakerLine);
      } catch (err) {
        if (attempt === 2) console.error(`LLM: ${(err as Error).message}`);
      }
    }
    if (!v) {
      failed += 1;
      continue;
    }
    // Вторая ступень: придирки снимаются, реальные дефекты остаются.
    if (v.bad && cli.verify) {
      const ok = await verify(cli.url, cli.model, e.msgid, e.msgstr, speaker, v.reason).catch(
        () => null,
      );
      if (ok === false) v = { ...v, bad: false, score: 10, reason: `dismissed: ${v.reason}` };
    }
    rows.push({
      c: e.msgctxt,
      m: e.msgid,
      ru: e.msgstr,
      verdict: v,
      clinical: clinicalHits(e.msgstr, undefined, e.msgid),
      softened: softenedHits(e.msgid, e.msgstr),
      leak: leakHits(e.msgstr),
      script: LATIN_CYRILLIC_LANGS.has(cli.lang) ? foreignScriptHits(e.msgstr) : [],
    });
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${todo.length}`);
  }

  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(`${cli.out}.jsonl`, `${jsonl}\n`, "utf8");

  const flagged = rows.filter(
    (r) =>
      r.verdict.bad ||
      r.clinical.length > 0 ||
      r.softened.length > 0 ||
      r.leak.length > 0 ||
      r.script.length > 0,
  );
  writeFileSync(
    `${cli.out}.bad.jsonl`,
    `${flagged.map((r) => JSON.stringify({ c: r.c, m: r.m, score: r.verdict.score, why: flaggedWhy(r) })).join("\n")}\n`,
    "utf8",
  );

  const scores = rows.map((r) => r.verdict.score);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const bad = rows.filter((r) => r.verdict.bad);
  const clinical = rows.filter((r) => r.clinical.length);
  const soft = rows.filter((r) => r.softened.length);
  const leaks = rows.filter((r) => r.leak.length);
  const scripts = rows.filter((r) => r.script.length);

  const md = [
    `# Оценка перевода: ${cli.lang}`,
    "",
    `Модель судьи: \`${cli.model}\` (бинарный вердикт, как в TSSR). Оценено: ${rows.length} (сбоев ${failed}).`,
    "",
    `- грубых ошибок: **${bad.length}** (${pct(bad.length, rows.length)}) — это и есть правки;`,
    `- оценка «как есть»: **${avg.toFixed(1)} / 10** (ok = 10, bad = 2);`,
    `- клинический регистр: ${clinical.length};`,
    `- потеря откровенности (кандидаты): ${soft.length};`,
    `- утечка промпта (механика): ${leaks.length};`,
    `- чужая письменность (гомоглифы): ${scripts.length}.`,
    "",
    "## Грубые ошибки",
    "",
    ...bad
      .slice(0, 20)
      .flatMap((r) => [
        `- ${r.verdict.dims?.["content"] ?? ""}${r.verdict.reason ? ` — ${r.verdict.reason}` : ""}`,
        `  - EN: ${r.m.slice(0, 150)}`,
        `  - RU: ${r.ru.slice(0, 150)}`,
      ]),
    "",
    "## Чужая письменность",
    "",
    ...scripts.map((r) => `- ${r.script.join(" ")}: ${r.ru.slice(0, 120)}`),
    "",
    "## Утечка промпта",
    "",
    ...leaks.map((r) => `- ${r.ru.slice(0, 140)}`),
    "",
    "## Клинический регистр",
    "",
    ...clinical.map((r) => `- ${r.clinical.join(", ")}: ${r.ru.slice(0, 120)}`),
    "",
    "## Потеря откровенности",
    "",
    ...soft.map((r) => `- ${r.softened.join(", ")}: ${r.m.slice(0, 70)} → ${r.ru.slice(0, 90)}`),
    "",
    `Полные вердикты: \`${cli.out}.jsonl\`; на вычитку: \`${cli.out}.bad.jsonl\`.`,
    "",
    "## Как это читать",
    "",
    "Судья ищет только грубые ошибки (чужая строка, перевёрнутый смысл, потерянный",
    "факт, сломанная грамматика, пол не по адресату) — как проверенный промпт TSSR",
    "v10. Регистр он НЕ судит: на прогоне 2026-11-23 LLM сочла стоны клиникой.",
    "Регистр даёт лексикон: клинические термины и потерю откровенных слов.",
    "Откровенность перевода оценивается по факту наличия слов, а не по ощущению.",
  ].join("\n");
  writeFileSync(`${cli.out}.md`, `${md}\n`, "utf8");
  console.log(
    `готово: ${cli.out}.md · грубых ${bad.length}/${rows.length} · клиника ${clinical.length} · смягчено ${soft.length}`,
  );
  return 0;
}

function flaggedWhy(r: {
  verdict: Verdict;
  clinical: string[];
  softened: string[];
  leak: string[];
  script: string[];
}): string {
  const parts: string[] = [];
  if (r.verdict.bad) parts.push(`judge:${r.verdict.reason || "bad"}`);
  if (r.clinical.length) parts.push(`clinical:${r.clinical.join("+")}`);
  if (r.softened.length) parts.push(`softened:${r.softened.join("+")}`);
  if (r.leak.length) parts.push("prompt-leak");
  if (r.script.length) parts.push("foreign-script");
  return parts.join("; ");
}

function pct(n: number, total: number): string {
  return total ? `${((n / total) * 100).toFixed(1)} %` : "0 %";
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
