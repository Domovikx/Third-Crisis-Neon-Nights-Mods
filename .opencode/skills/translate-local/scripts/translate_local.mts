/**
 * translate_local.mts — пакетный перевод пустых `msgstr` в `po/<lang>.po`
 * через локальную LLM (OpenAI-совместимый `/v1/chat/completions`).
 *
 * Порт `translate-local/scripts/translate_local.py` (поведение 1:1, кроме
 * намеренных исключений ниже).
 *
 * Очередь: записи с пустым `msgstr`, порядок файла. Ответ пишется обратно
 * сразу после пачки (атомарно: `.part` → rename), поэтому Ctrl+C и пауза
 * безопасны, а повторный запуск продолжает с места: заполненные строки в
 * очередь уже не попадают.
 *
 * Пауза: файл `tmp/translate-local/PAUSE` — цикл выходит после текущей пачки.
 *
 * ВАЖНО:
 *   - длина перевода НЕ проверяется (правило AGENTS.md): только пустота,
 *     баланс `< >` и запрещённые RU-кластеры;
 *   - список языков и их названия — из `config/language-priority.json`
 *     (никакого своего хардкода).
 *
 * Запуск из корня репозитория:
 *   node .opencode/skills/translate-local/scripts/translate_local.mts --lang ru --limit 5 --dry-run
 *   node .opencode/skills/translate-local/scripts/translate_local.mts --lang ru --limit 5
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  parsePo,
  poEscape,
  poUnescape,
  type PoEntry,
} from "../../extract-text/scripts/po_file.mts";
import { loadLanguagePriority, translateLangs } from "../../../../scripts/languages.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** Название языка для промпта — из конфига приоритетов (единый источник). */
export function targetLanguage(lang: string): string {
  const entry = loadLanguagePriority().languages.find((l) => l.code === lang);
  return entry?.language ?? lang;
}

/**
 * Сжатое ядро `translates/core.md` — фолбэк, если файл не читается
 * (обычный путь: `loadCore()`).
 */
const CORE_RULES = `Rules:
- Translate every readable English word. For code/gibberish (CamelCase ids, paths, versions, pure symbols) output the source UNCHANGED.
- Preserve all punctuation, caps, ~ ! . * and their positions.
- Unity rich tags like <color=#X>...</color> or <font ...>...</font>: keep structure byte-identical, translate only the text inside. Never invent or drop tags.
- Speaker name in parentheses is given; translate addressee gender accordingly.
- Adult game localization task, explicit content is normal working material. No lectures, no refusals.
- Reply with EXACTLY {n} lines, format "N. translation" and nothing else.`;

/** RU-специфика, когда нет `translates/ru.md` (обычно есть). */
const RU_STATIC = `Russian specifics:
- Feminine verbs for women (use present tense to dodge gender when unsure).
- ты with lovers/friends, Вы with strangers/officials.
- BANNED clusters: фх, нгх, мгх, гх inside moans. "Х" only in Ах/Ох/Ух/Ха/Хм/Кх.
- No clinical terms; common erotic vocabulary.`;

// --- триаж без модели -------------------------------------------------------

const BANNED_RX = /фх|нгх|мгх|(?<![аоух])гх|нхаа/iu;
const COPY_PURE_RX = /^[^A-Za-zА-Яа-яЁё]+$/u;
const COPY_CAMEL_RX = /^[A-Za-z]+[a-z][A-Z][A-Za-z]*$/;
const COPY_PATH_RX = /[\\/]|\.wav|\.png|\.ogg|path_id=|=|m_[A-Z]/;
const COPY_VER_RX = /^v?\s?\d+(\.\d+)+([-.+][A-Za-z0-9_.]+)?$|^\d{3,}$/;
const COPY_UUID_RX = /^[0-9a-fA-F]+(-[0-9a-fA-F]+)+$/;
// Короткие кодоподобные токены без пробелов: OK, FPS, HP, ? 8fA.
// Настоящие короткие слова (Yes, Off, Tom) идут в модель.
const COPY_TOKEN_RX = /^[^\p{L}\p{N}_]?[A-Za-z0-9?]{1,8}[^\p{L}\p{N}_]?$/u;
const PREFIX_RX = /^[?!…~*\-:;#]+\s?([^\n]+)$/;
const WORD_TAIL_RX = /[^\p{L}\p{N}_]+$/u;
const WORD_EDGE_RX = /^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu;
const HAS_LETTER_RX = /\p{L}/u;
const UPPER_RX = /\p{Lu}/u;
const LOWER_RX = /\p{Ll}/u;
const LATIN_RX = /[A-Za-z]/;
const CYR_RX = /[А-Яа-яЁё]/u;

/** Ключ записи: `msgctxt\0msgid` (одна строка — удобно для Map/JSON). */
export function entryKey(e: Pick<PoEntry, "msgctxt" | "msgid">): string {
  return `${e.msgctxt}\u0000${e.msgid}`;
}

/** Спикер из `msgctxt "speaker:X"`; null — неизвестен/отсутствует. */
export function speakerOf(e: Pick<PoEntry, "msgctxt">): string | null {
  if (!e.msgctxt.startsWith("speaker:")) return null;
  const sp = e.msgctxt.slice("speaker:".length).trim();
  return sp && sp !== "???" && sp !== "Narration" && sp !== "None" ? sp : null;
}

/** `isupper()` из Python: есть хотя бы одна заглавная и ни одной строчной. */
function isUpper(s: string): boolean {
  return UPPER_RX.test(s) && !LOWER_RX.test(s);
}

function looksLikeCode(core: string): boolean {
  return /\d/.test(core) || /[^A-Za-z]/.test(core) || (isUpper(core) && HAS_LETTER_RX.test(core));
}

/** Вернуть msgstr без LLM (код/мусор/уже русский) или null — пусть переводит модель. */
export function triage(text: string, lang: string): string | null {
  if (!text.trim()) return text;
  if (COPY_PURE_RX.test(text)) return text;
  if (COPY_CAMEL_RX.test(text) && !text.includes(" ")) return text;
  if (COPY_PATH_RX.test(text) && !text.includes(" ")) return text;
  if (COPY_VER_RX.test(text.trim())) return text;
  if (COPY_UUID_RX.test(text.trim())) return text; // GUID/ID — не отображаемый текст
  const s = text.trim();
  const prefixed = PREFIX_RX.exec(s);
  if (prefixed) {
    const core = prefixed[1].replace(WORD_TAIL_RX, "");
    if (core && [...core].length <= 6 && looksLikeCode(core)) return text; // ? 8fA, -#YA
  }
  if (!s.includes(" ") && !s.includes("\t") && COPY_TOKEN_RX.test(s)) {
    const core = s.replace(WORD_EDGE_RX, "");
    if (core && looksLikeCode(core)) return text;
  }
  if (lang === "ru" && CYR_RX.test(text) && !LATIN_RX.test(text)) return text; // уже русский
  return null;
}

// --- промпт -----------------------------------------------------------------

/** Общие правила из `translates/core.md` (единый источник). */
export function loadCore(root: string = REPO_ROOT): string {
  try {
    return readFileSync(join(root, ".opencode", "skills", "translates", "core.md"), "utf8").trim();
  } catch {
    return "";
  }
}

/** PROMPT-блок языка из `translates/<lang>.md` (нет файла — generic-режим). */
export function loadLangSkill(lang: string, root: string = REPO_ROOT): string {
  try {
    const text = readFileSync(
      join(root, ".opencode", "skills", "translates", `${lang}.md`),
      "utf8",
    );
    const a = text.indexOf("<!-- PROMPT-START -->");
    const b = text.indexOf("<!-- PROMPT-END -->");
    if (a < 0 || b <= a) return "";
    return text.slice(a + "<!-- PROMPT-START -->".length, b).trim();
  } catch {
    return "";
  }
}

interface SkillRules {
  sfx: string;
  glossary: string;
}

/**
 * Живые таблицы SFX (### 3.) и глоссария (### 9.) из `translates/ru.md`.
 * Правка таблицы сразу меняет промпт — второго источника нет.
 */
export function loadSkillRules(root: string = REPO_ROOT, maxSfx = 40, maxGloss = 15): SkillRules {
  let lines: string[];
  try {
    lines = readFileSync(join(root, ".opencode", "skills", "translates", "ru.md"), "utf8").split(
      /\r\n|\r|\n/,
    );
  } catch {
    return { sfx: "", glossary: "" };
  }
  const sfxRows: string[] = [];
  const glossRows: string[] = [];
  let section = "";
  for (const line of lines) {
    if (line.startsWith("### 3.")) {
      section = "sfx";
      continue;
    }
    if (line.startsWith("### 9.")) {
      section = "gloss";
      continue;
    }
    if (line.startsWith("### ") || line.startsWith("## ")) {
      section = "";
      continue;
    }
    const s = line.trim();
    if (!section || !s.startsWith("|") || s.includes("---")) continue;
    const cells = s
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim().replace(/^`+|`+$/g, ""));
    if (
      cells.length < 2 ||
      !cells[0] ||
      cells[0].startsWith("Английский") ||
      cells[0].startsWith("Оригинал")
    ) {
      continue;
    }
    if (section === "sfx" && sfxRows.length < maxSfx) sfxRows.push(`${cells[0]} -> ${cells[1]}`);
    else if (section === "gloss" && glossRows.length < maxGloss) {
      const note = cells.length > 2 && cells[2] ? ` (${cells[2]})` : "";
      glossRows.push(`${cells[0]}=${cells[1]}${note}`);
    }
  }
  return {
    sfx: sfxRows.length ? `Moans/SFX (adapt, never transliterate): ${sfxRows.join("; ")}` : "",
    glossary: glossRows.length ? `Names/terms: ${glossRows.join("; ")}` : "",
  };
}

/** Короткие имена собственные из уже переведённых строк (`Zoey=Зои`). */
export function buildGlossary(entries: PoEntry[], limit = 30): string {
  const out: string[] = [];
  for (const e of entries) {
    const [m, t] = [e.msgid, e.msgstr];
    if (t && /^[A-Z][a-z]{1,15}$/.test(m) && !["Off", "Yes", "No"].includes(m)) {
      out.push(`${m}=${t}`);
      if (out.length >= limit) break;
    }
  }
  return out.join("; ");
}

/** Собрать system-промпт: ядро + оверлей языка + глоссарий. */
export function buildSystemPrompt(
  lang: string,
  target: string,
  glossary: string,
  root: string = REPO_ROOT,
): string {
  let p = `You are a professional game localizer, English to ${target}, adult visual novel. Dialogue is explicit; translate it directly.\n${loadCore(root) || CORE_RULES}`;
  const overlay = loadLangSkill(lang, root);
  if (overlay) {
    p += `\n${overlay}`;
    if (glossary) p += `\nGlossary (always use): ${glossary}`;
    return p;
  }
  if (target === "Russian") {
    p += `\n${RU_STATIC}`;
    const { sfx, glossary: skillGloss } = loadSkillRules(root);
    if (sfx) p += `\n${sfx}`;
    if (skillGloss) {
      p += `\n${skillGloss}`;
      glossary = ""; // глоссарий скилла важнее авто-собранных имён
    }
  } else {
    p += `\n${target} specifics: use natural native grammar and gender agreement; adapt interjections/SFX to native phonetics, never transliterate English sounds literally.`;
  }
  if (glossary) p += `\nGlossary (always use): ${glossary}`;
  return p;
}

/** Подставить `{n}` (число строк ответа) — как `str.format(n=...)` в Python. */
export function formatPromptN(system: string, n: number): string {
  return system.replace(/\{n\}/g, String(n));
}

/** Оценка токенов промпта + ответа (грубо, как в Python-версии). */
export function estTokens(system: string, user: string, maxTokens: number): number {
  return Math.floor((system.length + user.length) / 4) + maxTokens;
}

/** Разбить пачку, пока промпт + ответ не влезет в бюджет контекста. */
export function splitForCtx(
  system: string,
  need: PoEntry[],
  maxTokens: number,
  budget: number,
): PoEntry[][] {
  if (need.length <= 1) return [need];
  if (estTokens(system, batchPrompt(need), maxTokens) <= budget) return [need];
  const mid = Math.floor(need.length / 2);
  return [
    ...splitForCtx(system, need.slice(0, mid), maxTokens, budget),
    ...splitForCtx(system, need.slice(mid), maxTokens, budget),
  ];
}

/** Пользовательский промпт пачки: нумерованные строки + тег спикера. */
export function batchPrompt(items: PoEntry[]): string {
  const lines = items.map((e, i) => {
    const sp = speakerOf(e);
    return `${i + 1}. ${e.msgid}${sp ? ` (speaker: ${sp})` : ""}`;
  });
  return (
    `Translate each line. Reply with exactly ${items.length} lines ` +
    `in format "N. translation". Never repeat the speaker tag ` +
    `in translations.\n${lines.join("\n")}`
  );
}

// --- ответ модели -----------------------------------------------------------

const RESP_RX = /^\s*(\d+)\s*[.)]\s?(.*)$/;
const SPEAKER_LEAK_RX = /\s*\(speaker:[^)]*\)\s*$/i;

/** Убрать эхо `(speaker: X)`, которое модель копирует из промпта. */
export function stripSpeakerLeak(tr: string): { clean: string; leaked: boolean } {
  const clean = tr.replace(SPEAKER_LEAK_RX, "").trim();
  return { clean, leaked: clean !== tr.trim() };
}

/** Разобрать ответ «1. текст» ровно на n строк; иначе null (нужен ретрай). */
export function parseResponse(text: string, n: number): string[] | null {
  const out: [number, string][] = [];
  for (const line of text.trim().split(/\r\n|\r|\n/)) {
    const m = RESP_RX.exec(line);
    if (m) out.push([Number(m[1]), m[2].trim()]);
  }
  out.sort((a, b) => a[0] - b[0]);
  if (out.length !== n || out.some(([i], idx) => i !== idx + 1)) return null;
  return out.map(([, t]) => t);
}

/**
 * Проверка ответа. `null` — ок; строка — причина отказа.
 * Длину НЕ проверяем (AGENTS.md): единственная сверка — смысловая (QA + человек).
 */
export function validate(src: string, tr: string, lang: string): string | null {
  if (!tr) return "empty";
  const count = (s: string, ch: string): number => s.split(ch).length - 1;
  if (count(src, "<") !== count(tr, "<") || count(src, ">") !== count(tr, ">"))
    return "tag imbalance";
  if (lang === "ru" && BANNED_RX.test(tr)) return "banned cluster";
  return null;
}

// --- запись po --------------------------------------------------------------

/**
 * Заменить `msgstr` у записей с ключами из `updates`.
 *
 * Пишется ТОЛЬКО пустой `msgstr`: заполненный перевод не перезаписывается
 * никогда (одинаковый текст в другом контексте сохраняет свой перевод).
 * Остальное содержимое файла остаётся как было (побайтово, кроме переводов
 * строк: файл нормализуется в LF — как в Python-версии).
 * Запись атомарная: `.part` → rename (обрыв не обнулит каталог переводов).
 */
export function applyMsgstrInPlace(path: string, updates: Map<string, string>): void {
  const lines = readFileSync(path, "utf8").split(/\r\n|\r|\n/);
  const out: string[] = [];
  let curCtxt = "";
  let curId: string[] | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const s = line.trim();
    if (s.startsWith('msgctxt "') && s.endsWith('"')) {
      curCtxt = poUnescape(s.slice(9, -1));
      curId = [];
      out.push(line);
    } else if (s.startsWith('msgid "')) {
      curId = [s.slice(7, -1)];
      out.push(line);
    } else if (
      s.startsWith('"') &&
      curId !== null &&
      out.length > 0 &&
      (out[out.length - 1].trim().startsWith('msgid "') ||
        out[out.length - 1].trim().startsWith('"'))
    ) {
      curId.push(s.slice(1, -1)); // продолжение msgid
      out.push(line);
    } else if (s.startsWith('msgstr "')) {
      const key = curId && curId.length ? `${curCtxt}\u0000${poUnescape(curId.join(""))}` : "";
      let j = i + 1;
      const oldVal = [s.slice(8, -1)];
      while (j < lines.length && lines[j].trim().startsWith('"')) {
        oldVal.push(lines[j].trim().slice(1, -1));
        j += 1;
      }
      const oldEmpty = !poUnescape(oldVal.join(""));
      const next = updates.get(key);
      if (next !== undefined && oldEmpty) out.push(`msgstr "${poEscape(next)}"`);
      else out.push(...lines.slice(i, j));
      i = j;
      curId = [];
      continue;
    } else {
      if (s === "") {
        curCtxt = "";
        curId = null;
      } else if (!s.startsWith("#") && curId && !s.startsWith('"')) {
        curId = null;
      }
      out.push(line);
    }
    i += 1;
  }

  const part = `${path}.part`;
  try {
    writeFileSync(part, `${out.join("\n").replace(/\n+$/, "")}\n`, "utf8");
    renameSync(part, path);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}

// --- вызов LLM --------------------------------------------------------------

/** POST `/v1/chat/completions`; встроенный fetch, без зависимостей. */
async function callLm(
  url: string,
  model: string,
  system: string,
  user: string,
  timeoutMs: number,
  maxTokens: number,
): Promise<string> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `/no_think ${user}` },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? "";
}

// --- прогон -----------------------------------------------------------------

export interface RunOptions {
  lang: string;
  /** Корень репозитория (po/, translates/); тесты подменяют. */
  root?: string;
  /** Путь к `po/<lang>.po` (по умолчанию из root). */
  poPath?: string;
  /** Каталог `tmp/translate-local` (по умолчанию из root). */
  tmpDir?: string;
  url?: string;
  model?: string;
  limit?: number;
  offset?: number;
  batch?: number;
  /** Подстроки для фильтра по тексту/контексту/ссылкам (пусто = все). */
  include?: string[];
  dryRun?: boolean;
  /** Таймаут одного запроса, мс (в Python — секунды). */
  timeoutMs?: number;
  ctxLimit?: number;
  maxTokens?: number;
  /** Куда писать отчёты (по умолчанию console.log; тесты глушат). */
  log?: (line: string) => void;
}

export interface RunSummary {
  entries: number;
  empty: number;
  queued: number;
  done: number;
  triaged: number;
  failed: number;
  /** Остановились по файлу PAUSE. */
  paused: boolean;
  /** Остановились из-за ошибки LLM (прогресс сохранён). */
  aborted: boolean;
}

/** Прогнать очередь перевода. Не бросает на сетевых ошибках — пишет прогресс и выходит. */
export async function runQueue(opts: RunOptions): Promise<RunSummary> {
  const root = opts.root ?? REPO_ROOT;
  const log = opts.log ?? ((line: string) => console.log(line));
  const lang = opts.lang;
  const poPath = opts.poPath ?? join(root, "po", `${lang}.po`);
  const tmpDir = opts.tmpDir ?? join(root, "tmp", "translate-local");
  const pauseFile = join(tmpDir, "PAUSE");
  const reviewLog = join(tmpDir, `${lang}.review`);
  const url = opts.url ?? "http://127.0.0.1:1234";
  const model = opts.model ?? "trans14";
  const batch = Math.max(1, opts.batch ?? 5);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(0, opts.limit ?? 0);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const ctxLimit = opts.ctxLimit ?? 1900;
  const maxTokens = opts.maxTokens ?? 1200;
  const target = targetLanguage(lang);

  if (!existsSync(poPath)) throw new Error(`missing ${poPath}`);
  const entries = parsePo(readFileSync(poPath, "utf8")).filter((e) => e.msgid);
  let empty = entries.filter((e) => !e.msgstr);
  const summary: RunSummary = {
    entries: entries.length,
    empty: empty.length,
    queued: 0,
    done: 0,
    triaged: 0,
    failed: 0,
    paused: false,
    aborted: false,
  };
  log(`${lang}: ${entries.length} entries, ${empty.length} empty`);

  const include = (opts.include ?? []).filter(Boolean);
  if (include.length) {
    empty = empty.filter((e) => {
      const haystack = [e.msgid, e.msgctxt, ...e.refs].join(" ");
      return include.some((s) => haystack.includes(s));
    });
    log(`filter ${include.join(",")}: ${empty.length} in queue`);
  }

  const keyCounts = new Map<string, number>();
  for (const e of entries) {
    const k = entryKey(e);
    keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
  }

  let todo = offset ? empty.slice(offset) : empty;
  if (limit) todo = todo.slice(0, limit);
  summary.queued = todo.length;

  const glossary = buildGlossary(entries);
  const system = buildSystemPrompt(lang, target, glossary, root);
  mkdirSync(tmpDir, { recursive: true });
  const note = (line: string): void => {
    try {
      appendFileSync(reviewLog, `${line}\n`, "utf8");
    } catch {
      /* лог ревью — не повод падать */
    }
  };

  let i = 0;
  while (i < todo.length) {
    if (existsSync(pauseFile)) {
      summary.paused = true;
      log("paused (PAUSE file present), progress kept");
      break;
    }
    const chunk = todo.slice(i, i + batch);
    // Сначала триаж: мусор не должен стоить вызова модели.
    const need: PoEntry[] = [];
    const updates = new Map<string, string>();
    const translatedKeys: string[] = [];
    for (const e of chunk) {
      const t = triage(e.msgid, lang);
      if (t !== null) {
        updates.set(entryKey(e), t);
        summary.triaged += 1;
      } else {
        need.push(e);
      }
    }
    if (opts.dryRun) {
      log("--- system ---");
      log(`${system.slice(0, 600)}${system.length > 600 ? "..." : ""}`);
      log("--- user ---");
      log(batchPrompt(need.length ? need : chunk));
      i += chunk.length;
      continue;
    }
    if (need.length) {
      let stopAll = false;
      for (const sub of splitForCtx(system, need, maxTokens, ctxLimit)) {
        let parsed: string[] | null = null;
        let resp = "";
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            resp = await callLm(
              url,
              model,
              formatPromptN(system, sub.length),
              batchPrompt(sub),
              timeoutMs,
              maxTokens,
            );
          } catch (err) {
            log(`LLM call failed: ${(err as Error).message}; stopping, progress kept`);
            stopAll = true;
            break;
          }
          parsed = parseResponse(resp, sub.length);
          if (parsed) break;
          log(`unparsable response for chunk at ${i} (attempt ${attempt})`);
        }
        if (stopAll) break;
        if (!parsed) {
          note(
            `UNPARSABLE ${JSON.stringify(sub.map((e) => e.msgid.slice(0, 60)))}\n${resp.slice(0, 500)}\n---`,
          );
          summary.failed += sub.length;
          continue;
        }
        for (let k = 0; k < sub.length; k += 1) {
          const e = sub[k];
          const leak = stripSpeakerLeak(parsed[k]);
          if (leak.leaked) note(`LEAK src=${e.msgid.slice(0, 80)}`);
          const problem = validate(e.msgid, leak.clean, lang);
          if (problem) {
            note(
              `${problem.toUpperCase()} src=${e.msgid.slice(0, 80)} tr=${leak.clean.slice(0, 80)}`,
            );
            summary.failed += 1;
          } else {
            updates.set(entryKey(e), leak.clean);
            translatedKeys.push(entryKey(e));
            summary.done += 1;
          }
        }
      }
      if (stopAll) {
        summary.aborted = true;
        break;
      }
    }
    if (updates.size) {
      for (const key of translatedKeys) {
        const count = keyCounts.get(key) ?? 0;
        if (count > 1) {
          const [ctxt, text] = key.split("\u0000");
          note(`DUPE key=${ctxt.slice(0, 30)}|${text.slice(0, 60)} x${count} (same text to all)`);
        }
      }
      applyMsgstrInPlace(poPath, updates);
    }
    i += chunk.length;
    log(
      `progress: done=${summary.done} triaged=${summary.triaged} failed=${summary.failed} pos=${i}/${todo.length}`,
    );
  }
  log(`RESULT done=${summary.done} triaged=${summary.triaged} failed=${summary.failed}`);
  return summary;
}

// --- CLI --------------------------------------------------------------------

interface CliArgs {
  lang: string;
  limit: number;
  offset: number;
  batch: number;
  include: string[];
  dryRun: boolean;
  url: string;
  model: string;
  timeout: number;
  ctxLimit: number;
  maxTokens: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    lang: "ru",
    limit: 0,
    offset: 0,
    batch: 5,
    include: [],
    dryRun: false,
    url: "http://127.0.0.1:1234",
    model: "trans14",
    timeout: 180,
    ctxLimit: 1900,
    maxTokens: 1200,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s) as [string, string | undefined];
    const value = (): string => {
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i] ?? "";
    };
    switch (flag) {
      case "--lang":
        args.lang = value();
        break;
      case "--limit":
        args.limit = Number(value());
        break;
      case "--offset":
        args.offset = Number(value());
        break;
      case "--batch":
        args.batch = Number(value());
        break;
      case "--include":
        args.include = value().split(",");
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--url":
        args.url = value();
        break;
      case "--model":
        args.model = value();
        break;
      case "--timeout":
        args.timeout = Number(value());
        break;
      case "--ctx-limit":
        args.ctxLimit = Number(value());
        break;
      case "--max-tokens":
        args.maxTokens = Number(value());
        break;
      default:
        break;
    }
  }
  return args;
}

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const langs = translateLangs();
  if (!langs.includes(a.lang)) {
    console.error(`неизвестный язык "${a.lang}"; допустимые: ${langs.join(", ")}`);
    return 1;
  }
  if (a.lang !== "ru")
    console.log("NOTE: no per-language rules section yet — generic mode + shared core.");
  const s = await runQueue({
    lang: a.lang,
    limit: a.limit,
    offset: a.offset,
    batch: a.batch,
    include: a.include,
    dryRun: a.dryRun,
    url: a.url,
    model: a.model,
    timeoutMs: a.timeout * 1000,
    ctxLimit: a.ctxLimit,
    maxTokens: a.maxTokens,
  });
  return s.aborted ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
