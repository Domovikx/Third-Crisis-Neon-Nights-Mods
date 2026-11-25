/**
 * script_guard.mts — чужая письменность внутри перевода.
 *
 * Симптом: слово собрано из букв разных алфавитов — модель подставляет визуально
 * похожий символ. В ru так испортилось имя героя: `Lio` стал `Лิโอ` (тайский) и
 * `Лيو` (арабский) в 13 строках, ещё `Пrying` (кириллица + латиница). В ja в
 * `エンフォーサー` попала арабская `ف` (9 строк), в ko — арабская `م`, тайские и
 * корейские буквы вперемешку с русскими (22 строки), в pl — `zmiennые`.
 * В игре это кракозябры, а глазами такую строку почти невозможно заметить:
 * символы выглядят как обычные буквы (проверено 2026-11-24).
 *
 * Поэтому проверка механическая: для каждого языка задан НАБОР разрешённых
 * письменностей (`SCRIPTS_BY_LANG`), а любой символ вне набора — дефект.
 * Исключение одно и честное: символ из ДРУГОЙ письменности законен, если она уже
 * есть в оригинале строки (`Русский Машинный Перевод / …` — название языка
 * латиницей остаётся кириллицей во всех языках).
 *
 * Марки (диакритика), цифры, пунктуация, пробелы и символы разрешены всегда:
 * это оформление, а не буква.
 */

/** Символы, допустимые в переводе независимо от языка (оформление). */
const NEUTRAL = "\\p{Script=Common}\\p{N}\\p{P}\\p{Z}\\p{S}\\p{M}\\s";

/**
 * Письменности, разрешённые языку.
 *
 * Латиница разрешена везде (имена, бренды, аббревиатуры). Кириллица — только
 * ru. Для zh греческие буквы разрешены осознанно: `利奥的数据α` — обозначение
 * «данные α», это не подмена письменности.
 */
export const SCRIPTS_BY_LANG: Record<string, string[]> = {
  de: ["Latin"],
  es: ["Latin"],
  fr: ["Latin"],
  it: ["Latin"],
  pl: ["Latin"],
  pt: ["Latin"],
  ru: ["Cyrillic", "Latin"],
  zh: ["Han", "Latin", "Greek"],
  ja: ["Han", "Hiragana", "Katakana", "Latin"],
  ko: ["Hangul", "Han", "Latin"],
};

/** Письменности, которые могут «протечь» в чужой перевод. */
const FOREIGN_SCRIPTS = [
  "Latin",
  "Cyrillic",
  "Greek",
  "Arabic",
  "Hebrew",
  "Thai",
  "Devanagari",
  "Hangul",
  "Han",
  "Hiragana",
  "Katakana",
  "Armenian",
  "Georgian",
];

/** Регэксп «символ этой письменности». */
const SCRIPT_RX: Record<string, RegExp> = Object.fromEntries(
  FOREIGN_SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, "u")]),
);

/** Один символ — допустимый в языке (без учёта оригинала). */
const ALLOWED_IN_LANG: Record<string, RegExp> = Object.fromEntries(
  Object.entries(SCRIPTS_BY_LANG).map(([lang, scripts]) => [
    lang,
    new RegExp(`[${NEUTRAL}${scripts.map((s) => `\\p{Script=${s}}`).join("")}]`, "u"),
  ]),
);

/** Письменности, которые реально встречаются в тексте. */
function scriptsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const ch of text) for (const s of FOREIGN_SCRIPTS) if (SCRIPT_RX[s].test(ch)) out.add(s);
  return out;
}

/** Символы, допустимые в переводе (кириллица, латиница, цифры, пунктуация, пробелы, символы, марки). */
const ALLOWED_RX = /[\p{Script=Cyrillic}\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}\p{M}\s]/u;

/**
 * Найти символы чужой письменности (универсально: кириллица + латиница).
 *
 * Возвращает уникальные символы в порядке появления (для отчёта). Пусто —
 * письменность чистая.
 */
export function foreignScriptHits(text: string): string[] {
  const found: string[] = [];
  for (const ch of text) {
    if (!ALLOWED_RX.test(ch) && !found.includes(ch)) found.push(ch);
  }
  return found;
}

/**
 * Языки, чья письменность — кириллица или латиница.
 *
 * Оставлено для совместимости: старые вызовы проверяли только их. Новый код
 * использует `SCRIPTS_BY_LANG` (он покрывает и CJK).
 */
export const LATIN_CYRILLIC_LANGS: ReadonlySet<string> = new Set([
  "en",
  "ru",
  "de",
  "es",
  "fr",
  "it",
  "pl",
  "pt",
]);

/** Есть ли в тексте хоть один символ чужой письменности (универсальная проверка). */
export function hasForeignScript(text: string): boolean {
  for (const ch of text) if (!ALLOWED_RX.test(ch)) return true;
  return false;
}

/**
 * Символы чужой для языка письменности.
 *
 * `source` (msgid) снимает ложные срабатывания: если письменность есть в
 * оригинале, её наличие в переводе законно.
 */
export function foreignScriptHitsFor(lang: string, text: string, source = ""): string[] {
  const langRx = ALLOWED_IN_LANG[lang];
  if (!langRx) return [];
  const fromSource = scriptsIn(source);
  const found: string[] = [];
  for (const ch of text) {
    if (langRx.test(ch)) continue;
    const okFromSource = FOREIGN_SCRIPTS.some((s) => fromSource.has(s) && SCRIPT_RX[s].test(ch));
    if (okFromSource) continue;
    if (!found.includes(ch)) found.push(ch);
  }
  return found;
}

/** Есть ли в тексте символ чужой для языка письменности. */
export function hasForeignScriptFor(lang: string, text: string, source = ""): boolean {
  return foreignScriptHitsFor(lang, text, source).length > 0;
}

/** Языки, для которых определён набор письменностей. */
export const GUARDED_LANGS: readonly string[] = Object.keys(SCRIPTS_BY_LANG);

// --- заглушки машинного прохода -------------------------------------------

/**
 * Слова-заглушки, которые оставляет машинный проход вместо перевода.
 *
 * Симптом (2026-11-25, найдено в 6 языках): в `msgstr` стоит само слово
 * «translation» / «перевод» / «翻訳» либо префикс `translation: …` поверх
 * имени ассета. Второй класс — утечка инструкции промпта: «重要：不要添加行号…
 * 回复只需译文本身» вместо реплики. Это видно игроку как текст.
 *
 * Проверка намеренно узкая, чтобы не ловить легитимные подписи:
 * `Russian Machine Translated`, `Нет перевода для элемента`,
 * `Sprache (maschinelle Übersetzung)` — не заглушки.
 */
const STUB_WORDS = new Set([
  "translation",
  "перевод",
  "翻訳",
  "翻譯",
  "翻译",
  "übersetzung",
  "traduction",
  "traduzione",
  "traducción",
  "tradução",
  "traduit",
  "übersetzt",
]);

const STUB_PREFIX =
  /^(translation|перевод|翻訳|翻譯|翻译|übersetzung|traduction|traduzione|traducción|tradução)\s*:\s*/iu;

const INSTRUCTION_MARK = /(重要|важно|important|wichtig|importante)/iu;
const NUMBERING_MARK =
  /(行号|行番号|номер строки|numéro de (la )?ligne|número de (la )?línea|line numbers?)/iu;
const TRANSLATION_MARK =
  /(翻译|翻訳|翻譯|译文|перевод|traduction|traduzione|traducción|tradução|translation)/iu;

/**
 * Заглушки машинного прохода в переводе. Пустой массив — чисто.
 *
 * `source` (msgid) снимает ложное срабатывание на строке, где сам оригинал
 * начинается с `translation:` — там префикс легитимен.
 */
export function stubHits(msgstr: string, source = ""): string[] {
  const text = msgstr.trim();
  if (!text) return [];
  const hits: string[] = [];
  const bare = text.replace(/[.!?…\s]+$/u, "").toLowerCase();
  if (STUB_WORDS.has(bare)) hits.push("stub-word");
  const prefix = STUB_PREFIX.exec(text);
  if (prefix && !STUB_PREFIX.test(source.trim())) hits.push("stub-prefix");
  if (INSTRUCTION_MARK.test(text) && NUMBERING_MARK.test(text) && TRANSLATION_MARK.test(text)) {
    hits.push("prompt-instruction");
  }
  return hits;
}
