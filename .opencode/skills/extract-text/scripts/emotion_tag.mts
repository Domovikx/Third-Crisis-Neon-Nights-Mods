/**
 * emotion_tag.mts — разметка тона диктора (`#. emotion:`) локальной LLM.
 *
 * Порт TSSR `emotion_tag.mts` под ключ TCNN: здесь тон адресуется **точным
 * msgid** (в POT TCNN `uid` не материализован, дублей в наборе озвучки нет).
 *
 * Поток (см. `tasks/2026-11-26-pot-voicing-plan.md`, разделы 3–4):
 *   emotion_tag.mts --sample 100 --out tmp/emotions_sample_9b.json
 *        │  черновик {msgid: "тон"} + `_meta` (время, распределение)
 *        ▼
 *   rust-l10n potgen --emotions <файл>   (или config/emotions.json)
 *        ▼
 *   po/template.pot с `#. emotion: …` (единственный холд тона)
 *
 * Кандидаты — набор озвучки плана: речь персонажей с оригинальным голосом
 * (`voicedInOriginal !== "no"`: Zoey, Max, Lio, Nova) + нарратив (`src: dialog`
 * без спикера, мысли Зои). `#, skip` и чистые стоны M0/M1 исключены.
 *
 * Контекст (важно для качества): если есть дамп (`--dump`, по умолчанию
 * `tmp/dump`), соседние реплики берутся из `dialogues[]` — это настоящие соседи
 * по сцене. POT отсортирован по msgid, поэтому «предыдущая строка по файлу» —
 * не сосед по сцене и как контекст не годится.
 *
 * Режимы:
 *   --sample N        стратифицированная выборка (диалог/нарратив, все голоса,
 *                     мысли в скобках); одинаковый N = одинаковые строки
 *   --sample-out <p>  записать выбранные строки (msgid, спикер, класс)
 *   --limit N         первые N кандидатов (быстрый прогон)
 *   --out <p>         куда писать черновик (по умолчанию tmp/emotions_tagged.json)
 *   --base-url <u>    OpenAI-compatible бэкенд (по умолчанию http://127.0.0.1:1234)
 *   --model <m>       модель (по умолчанию qwen/qwen3.5-9b)
 *   --concurrency N   параллельных запросов (по умолчанию 1 — честный замер)
 *   --resume          не перетирать уже размеченные msgid из --out
 *   --dry-run         только выборка/статистика, без LLM и записи
 *
 * НЕ коммитит и не трогает `po/**`: черновик — `tmp/`, в POT он попадает
 * только через `potgen --emotions` (решение владельца).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CHARACTERS, SPEAKER_TO_CHARACTER } from "../../../../config/voice-characters.mts";

import { parsePo, type PoEntry } from "./po_file.mts";
import { moanClass } from "./pot_voice_stats.mts";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
/** Корень репозитория: `.opencode/skills/extract-text/scripts` → 4 уровня вверх. */
export const REPO_ROOT = resolve(SCRIPTS_DIR, "..", "..", "..", "..");

export const DEFAULT_OUT = join(REPO_ROOT, "tmp", "emotions_tagged.json");
export const DEFAULT_BASE_URL = "http://127.0.0.1:1234";
export const DEFAULT_MODEL = "qwen/qwen3.5-9b";

/** Запасной тон, если модель не дала валидный ответ (тон обязан быть у всех). */
export const DEFAULT_EMO = "Evenly, with a measured neutral tone";

/** Персонажи, у которых в оригинале есть речь для рефа. */
export const VOICED_CHARACTERS: ReadonlySet<string> = new Set<string>(
  Object.values(CHARACTERS)
    .filter((c) => c.voicedInOriginal !== "no")
    .map((c) => c.name),
);

/** Инструкция разметки (TSSR v10 + 18+ регистр TCNN). */
export const LLM_PROMPT =
  "You are a voice director for an adult (18+) visual novel. For the ONE line below, " +
  "give the DELIVERY instruction: the emotional state of the speaker (or narrator) " +
  "while saying it.\n\n" +
  "RULES:\n" +
  "- English only, 2-6 words, one phrase, starts with a capital; no quotes, no period.\n" +
  "- The SPEAKER'S state of delivery, NOT a summary of what the line says.\n" +
  '- NEVER reply "none": every line has a delivery — even neutral lines carry an ' +
  "attitude (measured, flat, weary, bemused...).\n" +
  "- Fit the moment: use the speaker and the neighbouring lines as context.\n" +
  "- Keep the adult register honest: if the scene is intimate, painful or explicit, " +
  "the delivery must fit it — never soften or moralize.\n" +
  "- Be specific and varied: do not reuse one instruction for unrelated lines; " +
  "pick the nuance that belongs to THIS moment.\n" +
  "- Output ONLY the instruction.\n\n";

const srcOf = (e: PoEntry): string => e.comments.find((c) => c.startsWith("src: "))?.slice(5) ?? "";
const isSkip = (e: PoEntry): boolean => e.flags.includes("skip");
const speakerOf = (e: PoEntry): string | null =>
  e.msgctxt.startsWith("speaker:") ? e.msgctxt.slice("speaker:".length) : null;

/** Кандидат разметки: озвучиваемая строка + контекст сцены. */
export interface Candidate {
  msgid: string;
  /** Спикер или null у нарратива/мыслей. */
  speaker: string | null;
  /** `dialog` — речь персонажа, `narration` — мысли/описание от первого лица. */
  kind: "dialog" | "narration";
  /** Мысль в скобках (важная часть нарратива: `(Oh god, he saw me.)`). */
  parenthetical: boolean;
  /** Сосед по сцене из дампа (если дамп есть). */
  prev?: string;
  next?: string;
}

/** Озвучиваемая ли запись по правилам плана (без M0/M1). */
function isVoiceable(e: PoEntry): boolean {
  if (!e.msgid || isSkip(e) || moanClass(e.msgid) !== null) return false;
  if (e.msgctxt === "speaker-name") return false;
  const speaker = speakerOf(e);
  if (speaker) {
    const character = SPEAKER_TO_CHARACTER[speaker as keyof typeof SPEAKER_TO_CHARACTER];
    return Boolean(character && VOICED_CHARACTERS.has(character));
  }
  // Нарратив: только `src: dialog` без спикера (не UI/служебные ассеты).
  return srcOf(e) === "dialog";
}

/** Набор озвучки из POT: уникальные msgid в порядке файла. */
export function voicedEntries(potText: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const e of parsePo(potText)) {
    if (!isVoiceable(e) || seen.has(e.msgid)) continue;
    seen.add(e.msgid);
    const speaker = speakerOf(e);
    out.push({
      msgid: e.msgid,
      speaker,
      kind: speaker ? "dialog" : "narration",
      parenthetical: !speaker && /^\s*\(/.test(e.msgid.replace(/<[^>]+>/g, "")),
    });
  }
  return out;
}

/** Соседи по сцене из дампа: `dialogues[]` каждого ассета — настоящий порядок. */
export function loadSceneContext(dumpDir: string): Map<string, { prev: string; next: string }> {
  const context = new Map<string, { prev: string; next: string }>();
  if (!existsSync(dumpDir)) return context;
  for (const name of readdirSync(dumpDir)) {
    if (!name.endsWith(".jsonl") || name === "summaries.jsonl") continue;
    const lines = readFileSync(join(dumpDir, name), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let object: { dialogues?: Array<{ text?: string }> };
      try {
        object = JSON.parse(line) as typeof object;
      } catch {
        continue;
      }
      const dialogues = object.dialogues;
      if (!Array.isArray(dialogues)) continue;
      const texts = dialogues
        .map((d) => (typeof d.text === "string" ? d.text.trim() : ""))
        .filter(Boolean);
      for (let i = 0; i < texts.length; i++) {
        if (context.has(texts[i])) continue;
        context.set(texts[i], {
          prev: i > 0 ? texts[i - 1] : "",
          next: i + 1 < texts.length ? texts[i + 1] : "",
        });
      }
    }
  }
  return context;
}

/** Прицепить контекст сцены к кандидатам (не мутирует вход). */
export function withContext(
  candidates: Candidate[],
  context: Map<string, { prev: string; next: string }>,
): Candidate[] {
  return candidates.map((c) => {
    const hit = context.get(c.msgid);
    return hit ? { ...c, prev: hit.prev, next: hit.next } : c;
  });
}

/** Промпт одной строки: спикер/класс + соседи по сцене. */
export function buildPrompt(c: Candidate): string {
  const who = c.speaker ?? "Narrator (Zoey's inner voice)";
  const ctx = [
    `Speaker: ${who} | kind: ${c.kind}${c.parenthetical ? " (a thought in parentheses)" : ""}`,
  ];
  if (c.prev) ctx.push(`Previous line: ${c.prev.slice(0, 200)}`);
  ctx.push(`Line (EN): ${c.msgid}`);
  if (c.next) ctx.push(`Next line: ${c.next.slice(0, 200)}`);
  return LLM_PROMPT + ctx.join("\n");
}

/** Чистка ответа модели: кавычки/точка/регистр; null — ответ непригоден. */
export function normalizeEmotion(raw: string | null | undefined): string | null {
  const text = (raw ?? "")
    .trim()
    .replace(/^["'«»]+|["'«»]+$/g, "")
    .replace(/\.+$/, "")
    .trim();
  if (!text) return null;
  if (/^none$/i.test(text)) return null;
  if (/[\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF]/.test(text)) return null;
  if (text.split(/\s+/).length > 6) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Равномерная детерминированная выборка из списка (список должен быть отсортирован). */
export function pickEven<T>(list: T[], need: number): T[] {
  if (need >= list.length) return [...list];
  if (need <= 0) return [];
  const step = list.length / need;
  return Array.from({ length: need }, (_, i) => list[Math.floor(i * step)]);
}

/**
 * Стратифицированная выборка: половина диалога (все голоса) + половина
 * нарратива (не меньше четверти — мысли в скобках). Детерминирована.
 */
export function sampleEntries(candidates: Candidate[], total: number): Candidate[] {
  const byMsgid = (a: Candidate, b: Candidate): number => (a.msgid < b.msgid ? -1 : 1);
  const dialog = candidates.filter((c) => c.kind === "dialog").sort(byMsgid);
  const narration = candidates.filter((c) => c.kind === "narration").sort(byMsgid);
  const parenthetical = narration.filter((c) => c.parenthetical);
  const plainNarration = narration.filter((c) => !c.parenthetical);

  const speakers = [...new Set(dialog.map((c) => c.speaker as string))].sort();
  const dialogBudget = Math.floor(total / 2);
  const narrationBudget = total - dialogBudget;
  const perSpeakerCap = Math.max(1, Math.ceil(dialogBudget / 4));

  const pickedDialog: Candidate[] = [];
  const chosen = new Set<Candidate>();
  for (const speaker of speakers) {
    const pool = dialog.filter((c) => c.speaker === speaker);
    const take = Math.min(pool.length, perSpeakerCap);
    for (const candidate of pickEven(pool, take)) {
      pickedDialog.push(candidate);
      chosen.add(candidate);
    }
  }
  // Остаток диалога — спикеру с самым большим запасом (детерминированно).
  let leftover = dialogBudget - pickedDialog.length;
  const byPoolSize = [...speakers].sort(
    (a, b) =>
      dialog.filter((c) => c.speaker === b).length - dialog.filter((c) => c.speaker === a).length,
  );
  for (const speaker of byPoolSize) {
    if (leftover <= 0) break;
    const pool = dialog.filter((c) => c.speaker === speaker && !chosen.has(c));
    const extra = pickEven(pool, Math.min(leftover, pool.length));
    for (const candidate of extra) {
      pickedDialog.push(candidate);
      chosen.add(candidate);
    }
    leftover -= extra.length;
  }

  // Четверть нарративного бюджета — мысли в скобках (если есть).
  const parenTake = Math.min(parenthetical.length, Math.max(1, Math.floor(narrationBudget / 4)));
  const pickedParen = pickEven(parenthetical, parenTake);
  const pickedNarration = pickEven(plainNarration, narrationBudget - pickedParen.length);

  return [...pickedDialog, ...pickedParen, ...pickedNarration].slice(0, total);
}

export interface AskOptions {
  tries?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
}

/** Один запрос к OpenAI-compatible /v1/chat/completions. */
export async function askLlm(
  baseUrl: string,
  model: string,
  prompt: string,
  opts: AskOptions = {},
): Promise<string | null> {
  const tries = opts.tries ?? 3;
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 60,
    stream: false,
    // qwen3.5 «думает» внутри max_tokens и возвращает пустой content без этого.
    reasoning_effort: "none",
  });
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await doFetch(`${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const emotion = normalizeEmotion(data.choices?.[0]?.message?.content);
      if (emotion) return emotion;
      throw new Error("пустой/невалидный ответ LLM");
    } catch {
      if (attempt < tries - 1) {
        await new Promise((s) => setTimeout(s, opts.delayMs ?? 3000 * (attempt + 1)));
      }
    }
  }
  return null;
}

export interface TagResult {
  emotions: Record<string, string>;
  /** Секунды на строку по каждой размеченной строке (для замера). */
  seconds: number[];
  /** Сколько строк получили DEFAULT_EMO после трёх попыток. */
  fallbacks: number;
  /** Сколько запросов упало с ошибкой (пустой ответ = fallback). */
  errors: number;
}

/** Разметить список кандидатов с ограничением параллельности. */
export async function tagAll(
  candidates: Candidate[],
  opts: {
    baseUrl: string;
    model: string;
    concurrency?: number;
    existing?: Record<string, string>;
    resume?: boolean;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<TagResult> {
  const emotions: Record<string, string> = { ...opts.existing };
  const seconds: number[] = [];
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  let done = 0;
  let fallbacks = 0;
  let errors = 0;
  let index = 0;

  const worker = async (): Promise<void> => {
    while (index < candidates.length) {
      const candidate = candidates[index++];
      if (opts.resume && emotions[candidate.msgid]) {
        done += 1;
        opts.onProgress?.(done, candidates.length);
        continue;
      }
      const started = Date.now();
      const answer = await askLlm(opts.baseUrl, opts.model, buildPrompt(candidate));
      seconds.push((Date.now() - started) / 1000);
      if (!answer) {
        errors += 1;
        fallbacks += 1;
        emotions[candidate.msgid] = DEFAULT_EMO;
      } else {
        emotions[candidate.msgid] = answer;
      }
      done += 1;
      opts.onProgress?.(done, candidates.length);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { emotions, seconds, fallbacks, errors };
}

/** Распределение тонов (для отчёта и проверки «одна эмоция на всё»). */
export function distribution(emotions: Record<string, string>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const emotion of Object.values(emotions)) {
    counts.set(emotion, (counts.get(emotion) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

interface CliOptions {
  pot: string;
  dump: string;
  out: string;
  sample?: number;
  sampleOut?: string;
  limit?: number;
  baseUrl: string;
  model: string;
  concurrency: number;
  resume: boolean;
  dryRun: boolean;
}

function parseCli(argv: string[]): CliOptions {
  const flag = (name: string): string | undefined => {
    const at = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (at < 0) return undefined;
    const arg = argv[at];
    return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[at + 1];
  };
  const pot = flag("--pot") ?? join(REPO_ROOT, "po", "template.pot");
  const out = flag("--out") ?? DEFAULT_OUT;
  return {
    pot,
    dump: flag("--dump") ?? join(REPO_ROOT, "tmp", "dump"),
    out,
    sample: flag("--sample") ? Number(flag("--sample")) : undefined,
    sampleOut: flag("--sample-out"),
    limit: flag("--limit") ? Number(flag("--limit")) : undefined,
    baseUrl: flag("--base-url") ?? process.env.TCNN_LLM_URL ?? DEFAULT_BASE_URL,
    model: flag("--model") ?? process.env.TCNN_LLM_MODEL ?? DEFAULT_MODEL,
    concurrency: flag("--concurrency") ? Number(flag("--concurrency")) : 1,
    resume: argv.includes("--resume"),
    dryRun: argv.includes("--dry-run"),
  };
}

export async function run(opts: CliOptions): Promise<number> {
  const potText = readFileSync(opts.pot, "utf8");
  const allCandidates = voicedEntries(potText);
  const sceneContext = loadSceneContext(opts.dump);
  let candidates = withContext(allCandidates, sceneContext);

  const total = candidates.length;
  if (opts.sample) candidates = sampleEntries(candidates, opts.sample);
  if (opts.limit) candidates = candidates.slice(0, opts.limit);

  const speakerCounts = new Map<string, number>();
  for (const c of candidates) {
    const key = c.speaker ?? "(narration)";
    speakerCounts.set(key, (speakerCounts.get(key) ?? 0) + 1);
  }
  console.log(
    `кандидатов в POT: ${total}; в прогоне: ${candidates.length}; контекст сцены: ${
      sceneContext.size ? `${sceneContext.size} строк из ${opts.dump}` : "нет (дампа нет)"
    }`,
  );
  console.log(
    `по спикерам: ${[...speakerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}`,
  );
  console.log(`мыслей в скобках: ${candidates.filter((c) => c.parenthetical).length}`);

  if (opts.sampleOut) {
    mkdirSync(dirname(opts.sampleOut), { recursive: true });
    const lines = candidates.map((c) => ({
      msgid: c.msgid,
      speaker: c.speaker,
      kind: c.kind,
      parenthetical: c.parenthetical,
      prev: c.prev ?? "",
      next: c.next ?? "",
    }));
    writeFileSync(opts.sampleOut, `${JSON.stringify(lines, null, 2)}\n`);
    console.log(`-> выборка: ${opts.sampleOut}`);
  }
  if (opts.dryRun) return 0;

  let existing: Record<string, string> = {};
  if (opts.resume && existsSync(opts.out)) {
    const previous = JSON.parse(readFileSync(opts.out, "utf8")) as {
      emotions?: Record<string, string>;
    };
    existing = previous.emotions ?? {};
  }

  const started = Date.now();
  const result = await tagAll(candidates, {
    baseUrl: opts.baseUrl,
    model: opts.model,
    concurrency: opts.concurrency,
    existing,
    resume: opts.resume,
    onProgress: (done, total) => {
      if (done % 20 === 0 || done === total) process.stderr.write(`  ... ${done}/${total}\n`);
    },
  });
  const totalSeconds = (Date.now() - started) / 1000;
  const sortedEmotions = Object.fromEntries(
    Object.entries(result.emotions).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const perLine = result.seconds.length
    ? result.seconds.reduce((a, b) => a + b, 0) / result.seconds.length
    : 0;

  mkdirSync(dirname(opts.out), { recursive: true });
  const doc = {
    _comment:
      "Черновик тона: msgid -> English delivery instruction. Генерит emotion_tag.mts; potgen ставит `#. emotion:`.",
    _meta: {
      model: opts.model,
      baseUrl: opts.baseUrl,
      sampled: candidates.length,
      concurrency: opts.concurrency,
      totalSeconds: Number(totalSeconds.toFixed(2)),
      secondsPerLine: Number(perLine.toFixed(3)),
      fallbacks: result.fallbacks,
      errors: result.errors,
      generatedAt: new Date().toISOString(),
      distribution: distribution(result.emotions),
    },
    emotions: sortedEmotions,
  };
  writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`);

  console.log(
    `размечено: ${Object.keys(sortedEmotions).length}; ${perLine.toFixed(2)} с/строка ` +
      `(всего ${totalSeconds.toFixed(1)} с); fallback ${result.fallbacks}`,
  );
  for (const [emotion, count] of distribution(result.emotions).slice(0, 10)) {
    console.log(`  ${String(count).padStart(4)}  ${emotion}`);
  }
  console.log(`-> ${opts.out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseCli(process.argv.slice(2));
  run(options).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`EMOTION_TAG ERROR: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
