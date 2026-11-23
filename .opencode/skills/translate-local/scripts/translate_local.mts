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
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";

import { scanDump } from "../../extract-text/scripts/inventory.mts";
import { inKeys, readKeys } from "../../pipeline-common/scripts/qa_keys.mts";
import { isPromptLeak } from "../../../../scripts/leak_guard.mts";
import { LATIN_CYRILLIC_LANGS, hasForeignScript } from "../../../../scripts/script_guard.mts";
import { loadGenderMap } from "../../../../scripts/speaker_gender.mts";
import {
  parsePo,
  poEscape,
  poUnescape,
  type PoEntry,
} from "../../extract-text/scripts/po_file.mts";
import { substTokens } from "../../pipeline-common/scripts/text_filters.mts";
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

/**
 * Подсказка для точечного ретрая, когда перевод не прошёл `validate`.
 *
 * Замер 2026-11-23 (150 строк): 9 отказов, все — `banned cluster`: модель
 * писала стоны как «Фхааа», хотя в промпте это запрещено. Без ретрая строка
 * остаётся пустой навсегда (и при следующем прогоне модель повторит выбор),
 * поэтому на отказ делается ОДИН повтор с явным указанием, что не так.
 */
const FIX_HINT: Record<string, string> = {
  "banned cluster":
    "Не используй сочетания «фх», «гх», «нгх», «мгх». Для вздохов и стонов пиши «Фф», «Ффф», «Мхм», «Ах», «Ох».",
  "tag imbalance": "Сохрани все теги (<i>, </i>, <color=...>) ровно как в оригинале.",
  token: "Сохрани токены подстановки (#...#, {…}, %s) буква в букву, переводи только текст вокруг.",
  numbering: "Не добавляй номер строки (например «2. ») в перевод: ответ — только сам текст.",
  empty: "Ответ не должен быть пустым: переведи строку.",
};
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
/**
 * Глоссарий имён для промпта.
 *
 * Сначала — КАНОН из строк `msgctxt "speaker-name"`: их `msgstr` и есть принятое
 * написание (Rosie=Рози). Раньше брались просто первые 30 слов с заглавной, и
 * канон мог не попасть; в тексте из-за этого появлялись «Роузи» и «Клаудия»
 * (проверено 2026-11-23: 15 таких строк в ru).
 */
export function buildGlossary(entries: PoEntry[], limit = 60): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (m: string, t: string): void => {
    if (!t || seen.has(m) || out.length >= limit) return;
    seen.add(m);
    out.push(`${m}=${t}`);
  };
  for (const e of entries) {
    if (e.msgctxt === "speaker-name") push(e.msgid, e.msgstr);
    if (out.length >= limit) return out.join("; ");
  }
  for (const e of entries) {
    const [m, t] = [e.msgid, e.msgstr];
    if (t && /^[A-Z][a-z]{1,15}$/.test(m) && !["Off", "Yes", "No"].includes(m)) push(m, t);
    if (out.length >= limit) break;
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
  context?: ReadonlyMap<string, string[]>,
): PoEntry[][] {
  if (need.length <= 1) return [need];
  if (estTokens(system, batchPrompt(need, context), maxTokens) <= budget) return [need];
  const mid = Math.floor(need.length / 2);
  return [
    ...splitForCtx(system, need.slice(0, mid), maxTokens, budget, context),
    ...splitForCtx(system, need.slice(mid), maxTokens, budget, context),
  ];
}

/**
 * Контекст сцены: соседние реплики того же диалогового объекта в дампе.
 *
 * Без него модель видит одну строку и выбирает неверный смысл. Реальный случай
 * 2026-11-23: «Aww shucks~! Well, come on in! Give it a try!» переведено как
 * «Ах, черт! Ну же, заходи!», хотя перед этим в сцене «Oh- Wow! The bed!» и
 * речь о том, чтобы залезть в постель. Системный промпт требовал контекст, а
 * код его не передавал — теперь передаёт.
 */
export async function buildSceneContext(dumpDir: string): Promise<Map<string, string[]>> {
  const { items } = await scanDump(dumpDir);
  const scenes = new Map<string, { idx: number; speaker: string; text: string }[]>();
  for (const it of items) {
    if (it.kind !== "dlg" || it.idx === null) continue;
    const list = scenes.get(it.source) ?? [];
    list.push({ idx: it.idx, speaker: it.speaker, text: it.text });
    scenes.set(it.source, list);
  }
  const out = new Map<string, string[]>();
  const cut = (t: string): string => (t.length > 160 ? `${t.slice(0, 157)}…` : t);
  for (const list of scenes.values()) {
    list.sort((a, b) => a.idx - b.idx);
    list.forEach((cur, i) => {
      if (out.has(cur.text)) return; // первое вхождение побеждает
      const ctx: string[] = [];
      for (const j of [i - 2, i - 1]) {
        const p = list[j];
        if (p) ctx.push(`prev: [${p.speaker || "—"}] ${cut(p.text)}`);
      }
      const n = list[i + 1];
      if (n) ctx.push(`next: [${n.speaker || "—"}] ${cut(n.text)}`);
      if (ctx.length) out.set(cur.text, ctx);
    });
  }
  return out;
}

/**
 * Пользовательский промпт пачки: контекст (`// …`, не переводить) +
 * нумерованные строки с тегом спикера.
 */
export function batchPrompt(
  items: PoEntry[],
  context?: ReadonlyMap<string, string[]>,
  genders?: ReadonlyMap<string, "female" | "male">,
): string {
  const ctxLines: string[] = [];
  items.forEach((e, i) => {
    const ctx = context?.get(e.msgid);
    if (!ctx?.length) return;
    for (const line of ctx) ctxLines.push(`// ${i + 1} ${line}`);
  });
  const lines = items.map((e, i) => {
    const sp = speakerOf(e);
    const g = sp ? genders?.get(sp) : undefined;
    return `${i + 1}. ${e.msgid}${sp ? ` (speaker: ${sp}${g ? `, ${g}` : ""})` : ""}`;
  });
  const contextBlock = ctxLines.length
    ? `Context for meaning (lines starting with // are NOT translated):\n${ctxLines.join("\n")}\n`
    : "";
  return (
    contextBlock +
    `Translate each line. Reply with exactly ${items.length} lines ` +
    `in format "N. translation". Never repeat the speaker tag ` +
    `in translations.\n${lines.join("\n")}`
  );
}

/**
 * Промпт улучшения: у нас уже есть перевод, надо сделать его лучше.
 *
 * Отличие от обычного перевода — модель видит текущий вариант и правит его,
 * а не переводит заново: так меньше дрейфа смысла (TSSR делает то же).
 */
export function improvePrompt(
  items: PoEntry[],
  context?: ReadonlyMap<string, string[]>,
  genders?: ReadonlyMap<string, "female" | "male">,
): string {
  const ctxLines: string[] = [];
  items.forEach((e, i) => {
    for (const line of context?.get(e.msgid) ?? []) ctxLines.push(`// ${i + 1} ${line}`);
  });
  const lines = items.map((e, i) => {
    const sp = speakerOf(e);
    const g = sp ? genders?.get(sp) : undefined;
    return `${i + 1}. EN: ${e.msgid}${sp ? ` (speaker: ${sp}${g ? `, ${g}` : ""})` : ""}\n   RU: ${e.msgstr}`;
  });
  const contextBlock = ctxLines.length
    ? `Context for meaning (lines starting with // are NOT translated):\n${ctxLines.join("\n")}\n`
    : "";
  return (
    contextBlock +
    `Improve each Russian translation: keep the same meaning and facts, keep the adult register exactly as explicit as the English source (no softening, no clinical terms), ` +
    `never change the gender of second-person forms («ты пришла» follows the person ADDRESSED, not the speaker), ` +
    `make the language natural, preserve markup tags. Reply with exactly ${items.length} lines in format "N. improved translation".\n` +
    lines.join("\n")
  );
}

// --- ответ модели ---

const RESP_RX = /^\s*(\d+)\s*[.)]\s?(.*)$/;
// Утечка метаданных промпта в текст: английская и русская формы. Модель
// переводит «(speaker: Zoey)» и оставляет «(говорящий: Зои)» / «(эмоция: …)» —
// в игре это видно как часть реплики (проверено 2026-11-23: 42 строки в ru).
const SPEAKER_LEAK_RX =
  /\s*[（(](?:speaker|emotion|говорящ[а-яё]*|говорит|голос[а-яё]*|эмоци[а-яё]*|说话人|说话者|发言者|语气|情感|角色)\s*[:：][^)）]*[)）]\s*$/iu;
// Второй вариант без метки: «（Zoey，女）» / «（Zoey，female）» в конце строки.
const SPEAKER_LEAK_NO_LABEL_RX =
  /\s*[（(][^（()）]{1,20}[，,]\s*(?:女性|男性|女|男|female|male)[)）]\s*$/iu;
// Второй вид утечки — без двоеточия: «(голос Зои)» в конце реплики
// (проверено 2026-11-23: одна такая строка в ru). Узко: только в конце и коротко,
// иначе задели бы реплики вроде «(Голосовой файл)».
const VOICE_TAIL_RX = /\s*\((?:голос[а-яё]*|эмоци[а-яё]*)\s+(?!файл)[^)]{1,30}\)\s*$/iu;

/** Убрать эхо `(speaker: X)`, которое модель копирует из промпта. */
export function stripSpeakerLeak(tr: string): { clean: string; leaked: boolean } {
  const clean = tr
    .replace(SPEAKER_LEAK_RX, "")
    .replace(SPEAKER_LEAK_NO_LABEL_RX, "")
    .replace(VOICE_TAIL_RX, "")
    .trim();
  return { clean, leaked: clean !== tr.trim() };
}

/**
 * Разобрать ответ «1. текст» ровно на n строк; иначе null (нужен ретрай).
 *
 * Особый случай — `n === 1`: модель часто отвечает одной строкой БЕЗ нумерации
 * (замер 2026-11-23: из 19 ретраев на 5 строк все были одноэлементными
 * чанками). При одной строке выравнивать нечего, поэтому принимаем ответ как
 * есть — но только если он действительно одна непустая строка, иначе это
 * преамбула/пояснение и нужен ретрай. Префикс-эхо `N.` тоже снимаем.
 */
export function parseResponse(text: string, n: number): string[] | null {
  const out: [number, string][] = [];
  for (const line of text.trim().split(/\r\n|\r|\n/)) {
    const m = RESP_RX.exec(line);
    if (m) out.push([Number(m[1]), stripEchoLabel(m[2])]);
  }
  out.sort((a, b) => a[0] - b[0]);
  if (out.length === n && !out.some(([i], idx) => i !== idx + 1)) return out.map(([, t]) => t);

  if (n === 1) {
    const lines = text
      .trim()
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 1) {
      const bare = stripEchoLabel(lines[0].replace(/^N\s*[.)]\s*/i, ""));
      if (bare) return [bare];
    }
  }
  return null;
}

/**
 * Срезать эхо метки из ответа модели.
 *
 * В improve-режиме промпт показывает пару `EN: …` / `RU: …`, и модель иногда
 * копирует `RU: ` в начало перевода — в игре это видно как часть реплики
 * (проверено 2026-11-23: 6 строк из 10). Метка срезается только в начале.
 */
export function stripEchoLabel(text: string): string {
  return text.replace(/^(?:RU|EN|RUS|ENG)\s*:\s*/iu, "").trim();
}

/**
 * Рамка реплики: кавычки/скобки по краям — часть текста.
 *
 * EN `"…"` → RU `«…»` — допустимая смена стиля, поэтому проверяем не символ,
 * а НАЛИЧИЕ открывающей и закрывающей рамки. Потеря кавычки превращает реплику
 * в повествование (проверено 2026-11-23: improve уронил `"Я искренне…`).
 */
export function keepsFraming(src: string, tr: string): boolean {
  const s = src.trim();
  const t = tr.trim();
  // «q» — кавычки (в т.ч. китайские “” 「」 『』), «b» — скобки (в т.ч. （） ［］).
  const opens = (x: string): string =>
    /^["«„“「『]/u.test(x) ? "q" : /^[(（\[]/u.test(x) ? "b" : "";
  const closes = (x: string): string =>
    /["»“”」』]$/u.test(x) ? "q" : /[)）\]]$/u.test(x) ? "b" : "";
  const a = opens(s);
  if (a && a === closes(s) && a !== opens(t)) return false;
  const c = closes(s);
  if (c && c === opens(s) && c !== closes(t)) return false;
  return true;
}

/**
 * Пол формы 2-го лица в переводе («ты пришла» / «ты пришёл»).
 *
 * Нужен как щит на пассе улучшения: модель видит пол СПИКЕРА и иногда
 * переставляет на него формы адресата («не слышала» → «не слышал»), хотя
 * «ты» согласуется с тем, к кому обращаются (2026-11-23, 7 строк).
 */
export function person2Gender(text: string): "fem" | "masc" | null {
  const fem = /(?<!\p{L})ты\s+(?:[^.!?…]{0,20}?)([а-яё]+ла)(?!\p{L})/iu.test(text);
  const masc = /(?<!\p{L})ты\s+(?:[^.!?…]{0,20}?)([а-яё]+л)(?!\p{L})(?![а-яё])/iu.test(text);
  if (fem && !masc) return "fem";
  if (masc && !fem) return "masc";
  return null;
}

/**
 * Вернуть рамку и маркер, которые модель потеряла.
 *
 * EN `> Text` и `(Text)` — часть строки: рантайм её показывает. Модель регулярно
 * выбрасывает `>` и скобки, и ретрай не помогает (2026-11-23: 7 строк zh так и
 * остались пустыми). Восстанавливаем детерминированно, до валидации.
 */
export function restoreFraming(src: string, tr: string, lang: string): string {
  let out = tr.trim();
  const s = src.trim();
  if (s.startsWith(">") && !out.startsWith(">")) out = `> ${out}`;
  if (s.endsWith(">") && !out.endsWith(">")) out = `${out} >`;
  const openQuote = lang === "ru" ? "«" : "“";
  const closeQuote = lang === "ru" ? "»" : "”";
  if (/^[(（]/.test(s) && !/^[(（]/.test(out)) out = `（${out}`;
  if (/[)）]$/.test(s) && !/[)）]$/.test(out)) out = `${out}）`;
  if (/^["“]/.test(s) && !/^["“«]/.test(out) && !/^[(（]/.test(out)) out = `${openQuote}${out}`;
  if (/["”]$/.test(s) && !/["”»]$/.test(out) && !/[)）]$/.test(out)) out = `${out}${closeQuote}`;
  return out;
}

/**
 * Проверка ответа. `null` — ок; строка — причина отказа.
 * Длину НЕ проверяем (AGENTS.md): единственная сверка — смысловая (QA + человек).
 */
export function validate(src: string, tr: string, lang: string): string | null {
  if (!tr) return "empty";
  // Ведущий «>» — маркер реплики, а не тег: вырезаем его до сверки скобок.
  const stripMarker = (x: string): string => x.replace(/^>\s?/, "");
  const a = stripMarker(src);
  const b = stripMarker(tr);
  const count = (s: string, ch: string): number => s.split(ch).length - 1;
  if (count(a, "<") !== count(b, "<") || count(a, ">") !== count(b, ">")) return "tag imbalance";
  if (lang === "ru" && BANNED_RX.test(tr)) return "banned cluster";
  if (!keepsMarker(src, tr)) return "marker";
  if (!keepsTokens(src, tr)) return "token";
  if (!keepsNumbering(src, tr)) return "numbering";
  if (!keepsFraming(src, tr)) return "framing";
  // Модель иногда возвращает не перевод, а собственный промпт (4 строки в ru,
  // 2026-11-23). Такое в игре видно как текст реплики, поэтому не пишем.
  if (isPromptLeak(tr)) return "prompt leak";
  // Гомоглифы: имя Lio превращалось в «Лิโอ» (тайский) и «Лيو» (арабский) в 13
  // строках ru. Для иероглифических языков проверка не применяется.
  if (LATIN_CYRILLIC_LANGS.has(lang) && hasForeignScript(tr)) return "foreign script";
  return null;
}

/**
 * В перевод не должен протекать номер строки промпта.
 *
 * Протокол ответа — «N. перевод», и модель иногда оставляет `2.` в самом
 * тексте: в ru таких строк нашлось 30 (2026-11-23). Если оригинал не начинается
 * с числа, перевод с `N.` — дефект: в игре он покажется как «2. Но как ты...?».
 */
export function keepsNumbering(src: string, tr: string): boolean {
  if (!/^\d+\s*[.)]\s/.test(tr)) return true;
  return /^\d+\s*[.)]\s/.test(src);
}

/**
 * Токены подстановки обязаны пережить перевод БУКВА В БУКВУ.
 *
 * В диалогах ANToolkit встречаются пресеты вида
 * `#TakenFromInventoryText# #ItemName#.` — игра заменяет `#...#` значениями
 * (имя предмета и т. п.). Переименованный токен ломает подстановку молча,
 * поэтому проверка жёсткая: набор токенов в переводе должен совпасть с
 * исходным. Также закрываем `{Имя}` и printf-стиль `%s`, `%1$d`.
 */
export function keepsTokens(src: string, tr: string): boolean {
  const a = substTokens(src).sort();
  const b = substTokens(tr).sort();
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Ведущий маркер реплики (`!`, `?`, `→`, `►`, `★`, `☆`, `•`) — часть текста,
 * а не оформление: в игре это значок/пункт, и потеря «!» меняет смысл
 * (`! Rosie said it` — про реплику Рози). Замер 2026-11-23: старый перевод
 * потерял «!» и дописал «Ах,» — валидатор такое теперь ловит.
 *
 * Пары `!`/`¡` и `?`/`¿` считаются сохранением маркера (испанский набор).
 */
export function keepsMarker(src: string, tr: string): boolean {
  const m = /^[!?¡¿→►★☆•>]/u.exec(src);
  if (!m) return true;
  const mark = m[0];
  if (tr.startsWith(mark)) return true;
  // CJK пишет те же маркеры полноширинными знаками: ! → ！, ? → ？
  const pair: Record<string, string[]> = {
    "!": ["¡", "！"],
    "?": ["¿", "？"],
    ">": [">", "＞"],
  };
  return (pair[mark] ?? []).some((alt) => tr.startsWith(alt));
}

// --- запись po --------------------------------------------------------------

/**
 * Заменить `msgstr` у записей с ключами из `updates`.
 *
 * По умолчанию пишется ТОЛЬКО пустой `msgstr`. `overwrite` включается режимом
 * `--repair`: там перезаписываются записи, которые не прошли `validate` (потеря
 * маркера, дисбаланс тегов) — без этого старый дефект не исправить никогда.
 * Остальное содержимое файла остаётся как было (побайтово, кроме переводов
 * строк: файл нормализуется в LF — как в Python-версии).
 * Запись атомарная: `.part` → rename (обрыв не обнулит каталог переводов).
 */
export function applyMsgstrInPlace(
  path: string,
  updates: Map<string, string>,
  overwrite = false,
): void {
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
      if (next !== undefined && (oldEmpty || overwrite)) out.push(`msgstr "${poEscape(next)}"`);
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

/**
 * Перезагрузить модель в LM Studio после падения бэкенда.
 *
 * Падение выглядит как `HTTP 400 {"error":"terminated"}` (лог LM Studio:
 * «Channel Error … terminated»): процесс инференса умер и модель выгружена.
 * Без перезагрузки прогон останавливается, поэтому пробуем поднять её сами.
 * Если `lms` в PATH нет — молча возвращаем false (поведение как раньше).
 */
export function reloadModel(model: string, contextLength = 8192): boolean {
  for (const bin of ["lms", "lms.exe"]) {
    const res = spawnSync(bin, ["load", model, "--gpu", "max", "-c", String(contextLength)], {
      stdio: "ignore",
      timeout: 240_000,
    });
    if (res.status === 0) return true;
  }
  return false;
}

/** POST `/v1/chat/completions`; встроенный fetch, без зависимостей. */
async function callLm(
  url: string,
  model: string,
  system: string,
  user: string,
  timeoutMs: number,
  maxTokens: number,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
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
        // Гасим «размышления» модели: с ними токены уходят в reasoning_content,
        // ответ пустеет/обрезается. LM Studio понимает reasoning_effort,
        // llama.cpp — только chat_template_kwargs (проверено 2026-11-23).
        reasoning_effort: "none",
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Node прячет причину в `cause`: без неё «fetch failed» бесполезен.
    const cause = (err as { cause?: { message?: string } }).cause?.message ?? "";
    throw new Error(`fetch failed: ${(err as Error).message}${cause ? ` (${cause})` : ""}`);
  }
  if (!res.ok) {
    // Тело ответа обязательно: сервер объясняет причину (контекст, шаблон).
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
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
  /** Режим починки: очередь — переведённые строки, не прошедшие `validate`. */
  repair?: boolean;
  /** Каталог дампа для контекста сцены (без него контекст не передаётся). */
  dumpDir?: string;
  /** Режим улучшения: переписывать УЖЕ переведённые строки. */
  improve?: boolean;
  /** Ограничить очередь строками из списка `qa_judge --out` (ключи). */
  keys?: ReadonlySet<string>;
  /** Пол спикеров (config/speaker-gender.json); тесты подменяют. */
  genders?: ReadonlyMap<string, "female" | "male">;
  /** Пауза между повторами запроса, мс (тесты ставят 0). */
  retryDelayMs?: number;
  /** Куда писать отчёты (по умолчанию console.log; тесты глушат). */
  log?: (line: string) => void;
}

export interface RunSummary {
  entries: number;
  /** Пустых `msgstr`, которые реально пойдут в работу (без `#, skip`). */
  empty: number;
  queued: number;
  done: number;
  triaged: number;
  failed: number;
  /** Пустые строки с `#, skip`: перевод политикой не нужен, модель не зовём. */
  skipped: number;
  /** Остановились по файлу PAUSE. */
  paused: boolean;
  /** Остановились из-за ошибки LLM (прогресс сохранён). */
  aborted: boolean;
}

/**
 * Модель перевода по умолчанию — ОДНО место для CLI и `runQueue`.
 *
 * Владелец закрепил `index-translate-9b` (LM Studio, `127.0.0.1:1234`):
 * общий пульт бэкендов (`scripts/llm_backend.mts`) на перевод не влияет,
 * иначе языки уезжают на другой модели. Раньше здесь стоял `trans14` —
 * второй дефолт, который разошёлся с CLI; поймано 2026-11-23.
 */
export const DEFAULT_TRANSLATE_MODEL = "index-translate-9b";
/** Батч по умолчанию: замер 2026-11-22 — 5 строк быстрее и стабильнее 10. */
export const DEFAULT_BATCH = 5;

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
  const model = opts.model ?? DEFAULT_TRANSLATE_MODEL;
  const batch = Math.max(1, opts.batch ?? DEFAULT_BATCH);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(0, opts.limit ?? 0);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const ctxLimit = opts.ctxLimit ?? 1900;
  const maxTokens = opts.maxTokens ?? 1200;
  const target = targetLanguage(lang);

  if (!existsSync(poPath)) throw new Error(`missing ${poPath}`);
  const entries = parsePo(readFileSync(poPath, "utf8")).filter((e) => e.msgid);
  // `#, skip` — решение политики potgen: перевод не нужен, строку в модель не
  // шлём (po_update такие строки в PO и не заводит; здесь — страховка для PO,
  // отредактированных руками). Счётчик виден в отчёте.
  const isSkip = (e: PoEntry): boolean => e.flags.includes("skip");
  const skipEmpty = entries.filter((e) => !e.msgstr && isSkip(e));
  let empty = entries.filter((e) => !e.msgstr && !isSkip(e));
  const summary: RunSummary = {
    entries: entries.length,
    empty: empty.length,
    queued: 0,
    done: 0,
    triaged: 0,
    failed: 0,
    skipped: skipEmpty.length,
    paused: false,
    aborted: false,
  };
  log(
    `${lang}: ${entries.length} entries, ${empty.length} empty` +
      (skipEmpty.length ? `, ${skipEmpty.length} skip (не переводятся)` : ""),
  );

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

  // --repair: очередь — не пустые, а ПЕРЕВЕДЁННЫЕ строки, которые не проходят
  // validate (потеря маркера, дисбаланс тегов). Обычный прогон их не трогает.
  const genders = opts.genders ?? loadGenderMap(opts.root ?? REPO_ROOT);

  let todo = opts.improve
    ? entries.filter((e) => e.msgstr && !e.flags.includes("skip"))
    : opts.repair
      ? entries.filter(
          (e) => e.msgstr && !e.flags.includes("skip") && validate(e.msgid, e.msgstr, lang),
        )
      : empty;
  if (opts.keys) {
    const before = todo.length;
    todo = todo.filter((e) => inKeys(e, opts.keys as ReadonlySet<string>));
    log(`keys: ${todo.length} из ${before} строк попали в список`);
  }
  if (opts.repair) log(`repair: ${todo.length} строк не проходят validate`);
  if (opts.improve) log(`improve: ${todo.length} переведённых строк к улучшению`);
  todo = offset ? todo.slice(offset) : todo;
  if (limit) todo = todo.slice(0, limit);
  summary.queued = todo.length;

  let sceneContext: Map<string, string[]> = new Map();
  if (opts.dumpDir) {
    const started = Date.now();
    sceneContext = await buildSceneContext(opts.dumpDir);
    log(
      `scene context: ${sceneContext.size} строк с соседями ` +
        `из ${opts.dumpDir} (${Math.round((Date.now() - started) / 100) / 10} с)`,
    );
  }
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
      for (const sub of splitForCtx(system, need, maxTokens, ctxLimit, sceneContext)) {
        let parsed: string[] | null = null;
        let resp = "";
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            resp = await callLm(
              url,
              model,
              formatPromptN(system, sub.length),
              opts.improve
                ? improvePrompt(sub, sceneContext, genders)
                : batchPrompt(sub, sceneContext, genders),
              timeoutMs,
              maxTokens,
            );
          } catch (err) {
            const message = (err as Error).message;
            // Падение бэкенда («terminated») лечится перезагрузкой модели;
            // сетевой таймаут — просто повтором. Три попытки, потом стоп.
            if (attempt < 3) {
              log(`LLM call failed: ${message}; retry ${attempt}/3`);
              const crashed = /terminated|HTTP 400/i.test(message);
              if (crashed && attempt === 1) {
                log(`перезагружаю модель ${model}…`);
                reloadModel(model);
              }
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                (opts.retryDelayMs ?? 3000) * attempt,
              );
              continue;
            }
            log(`LLM call failed: ${message}; stopping, progress kept`);
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
        /** Один точечный ретрай строки с подсказкой «что не так». */
        async function fixOne(e: PoEntry, problem: string): Promise<string | null> {
          const hint = FIX_HINT[problem];
          if (!hint) return null;
          try {
            const resp2 = await callLm(
              url,
              model,
              formatPromptN(system, 1),
              `${batchPrompt([e], sceneContext)}\n\nВАЖНО: ${hint}\n` +
                "Ответь РОВНО одной строкой: только перевод, без нумерации, без кавычек и пояснений.",
              timeoutMs,
              maxTokens,
            );
            const again = parseResponse(resp2, 1);
            if (!again) return null;
            const clean = stripSpeakerLeak(again[0]).clean;
            return clean && !validate(e.msgid, clean, lang) ? clean : null;
          } catch {
            return null;
          }
        }

        for (let k = 0; k < sub.length; k += 1) {
          const e = sub[k];
          const leak = stripSpeakerLeak(parsed[k]);
          if (leak.leaked) note(`LEAK src=${e.msgid.slice(0, 80)}`);
          const framed = restoreFraming(e.msgid, leak.clean, lang);
          const problem = validate(e.msgid, framed, lang);
          if (problem) {
            note(
              `${problem.toUpperCase()} src=${e.msgid.slice(0, 80)} tr=${leak.clean.slice(0, 80)}`,
            );
            const fixed = await fixOne(e, problem);
            if (fixed) {
              updates.set(entryKey(e), fixed);
              translatedKeys.push(entryKey(e));
              summary.done += 1;
            } else {
              summary.failed += 1;
            }
          } else if (opts.improve) {
            // В improve пустая/такая же строка — не улучшение, не пишем.
            // Щит: пол 2-го лица не переставляем (адресат ≠ спикер).
            const oldGender = person2Gender(e.msgstr);
            const newGender = person2Gender(leak.clean);
            const flipsGender = oldGender !== null && newGender !== null && oldGender !== newGender;
            if (leak.clean && leak.clean.trim() !== e.msgstr.trim() && !flipsGender) {
              updates.set(entryKey(e), leak.clean);
              translatedKeys.push(entryKey(e));
              summary.done += 1;
            } else {
              summary.failed += 0;
            }
          } else {
            updates.set(entryKey(e), framed);
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
      applyMsgstrInPlace(poPath, updates, opts.repair === true || opts.improve === true);
    }
    i += chunk.length;
    log(
      `progress: done=${summary.done} triaged=${summary.triaged} failed=${summary.failed} pos=${i}/${todo.length}`,
    );
  }
  log(
    `RESULT done=${summary.done} triaged=${summary.triaged} failed=${summary.failed}` +
      (summary.skipped ? ` skipped=${summary.skipped}` : ""),
  );
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
  repair: boolean;
  improve: boolean;
  /** Файл со списком строк на вычитку (`qa_judge` → `.bad.jsonl`). */
  keys?: string;
  dumpDir?: string;
  url: string;
  model: string;
  timeout: number;
  ctxLimit: number;
  maxTokens: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    lang: "ru",
    limit: 0,
    offset: 0,
    batch: DEFAULT_BATCH,
    include: [],
    dryRun: false,
    repair: false,
    improve: false,
    url: "http://127.0.0.1:1234",
    model: DEFAULT_TRANSLATE_MODEL,
    timeout: 180,
    ctxLimit: 1900,
    maxTokens: 1200,
    help: false,
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
      case "--repair":
        args.repair = true;
        break;
      case "--improve":
        args.improve = true;
        break;
      case "--keys":
        args.keys = value();
        break;
      case "--dump":
        args.dumpDir = value();
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
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (flag.startsWith("-")) throw new Error(`неизвестная опция: ${flag}`);
        break;
    }
  }
  return args;
}

const USAGE = `translate_local — батч-перевод пустых msgstr через локальную LLM

  node translate_local.mts --lang <код> [--limit N] [--offset N] [--batch N]
                           [--url URL] [--model ИМЯ] [--dry-run]

  --lang      язык из config/language-priority.json (по умолчанию ru)
  --limit     сколько строк перевести за прогон (0 = все пустые)
  --offset    пропустить N пустых строк (для порций)
  --batch     строк в одном запросе к модели (по умолчанию 5)
  --url       OpenAI-compatible endpoint (по умолчанию http://127.0.0.1:1234)
  --model     имя модели (по умолчанию index-translate-9b)
  --dry-run   показать план без вызовов LLM
  --dump <d>  каталог дампа: передавать модели соседние реплики сцены
  --improve   улучшать уже переведённые строки (повторные пассы качества)
  --keys <f>  ограничить улучшение строками из списка (.bad.jsonl судьи)
  --repair    починить уже переведённые строки, не прошедшие validate
              (маркер, дисбаланс тегов) — перезаписывает их
`;

async function main(argv: string[]): Promise<number> {
  let a: CliArgs;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error(USAGE);
    return 1;
  }
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
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
    repair: a.repair,
    improve: a.improve,
    keys: a.keys ? readKeys(readFileSync(resolve(REPO_ROOT, a.keys), "utf8")) : undefined,
    dumpDir: a.dumpDir,
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
