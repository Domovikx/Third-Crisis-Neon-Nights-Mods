/**
 * pot_skip.mts — единственный владелец логики «этой строке перевод не нужен».
 *
 * Здесь живут три вещи, и только они:
 *   1. чистка TMP-разметки (`stripTmpTags`) — по СПИСКУ известных тегов, а не
 *      регексом `<[^>]+>`;
 *   2. классификация пары `(msgid, rich_text)` — `classifyRich`: обрывок
 *      (ключ = хвост полного текста), расхождение (ключ вообще не содержится)
 *      или норма;
 *   3. условия правил skip-политики (`SKIP_CONDITIONS`,
 *      `skipConditionMatches`) — данные правил лежат в
 *      `config/pot-skip-policy.json`, разбор политики — в `potgen.mts`.
 *
 * Почему чистка по списку, а не `<[^>]+>`: в данных игры `<` и `>` работают
 * авторскими кавычками («< Like this, ... request them. >»). Регекс «любой
 * `<...>`» съедает кусок от такой кавычки до реального тега, и дефект
 * маскируется: наивная чистка даёт 0 обрывков там, где они есть (проверено
 * 2026-11-23 на реальном дампе). Поэтому снимаем ТОЛЬКО известные TMP-теги;
 * всё остальное остаётся текстом.
 *
 * Список тегов — данные, а не магия в регексе: новый тег добавляется одной
 * строкой здесь (TS) и в `tools/rust-l10n/src/pot_skip.rs` (паритет стережёт
 * `npm run test`).
 */
import { pyStrip } from "./inventory.mts";

/**
 * Известные TMP-теги (Rich Text Mesh Pro): имя, закрывающий вариант — `</имя>`.
 *
 * `s` — зачёркивание, `size=`/`color=`/`alpha=`/… — теги с параметром,
 * `br`/`page`/`nobr`/`noparse` — без параметра. Порядок не важен: регекс
 * собирается по убыванию длины имени, чтобы `sprite` не распадался на `s`.
 */
export const TMP_TAGS: readonly string[] = [
  "i",
  "b",
  "u",
  "s",
  "size",
  "color",
  "alpha",
  "material",
  "link",
  "sprite",
  "pos",
  "align",
  "cspace",
  "indent",
  "line-height",
  "mspace",
  "space",
  "voffset",
  "width",
  "font",
  "mark",
  "nobr",
  "noparse",
  "page",
  "br",
];

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Регекс одного TMP-тега: `<`, необязательный `/`, имя из списка, граница
 * имени (пробел/`=`/`/`/`>`), затем параметры до `>`. Регистр — как в данных
 * (`<B>` встречается), поэтому `i`.
 */
const TMP_TAG_RX = new RegExp(
  `<\\/?(?:${[...TMP_TAGS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRx)
    .join("|")})(?=[\\s=/>])[^<>]*>`,
  "gi",
);

/** Убрать ТОЛЬКО известные TMP-теги; прочие `<...>` — авторский текст. */
export function stripTmpTags(s: string): string {
  return s ? s.replace(TMP_TAG_RX, "") : s;
}

/**
 * Порог «осмысленного» обрывка: короче брать нельзя.
 *
 * Замер 2026-11-23 (`tmp/dump-after`): хвостов `text` в `rich_text` семь, но
 * шесть из них — один символ `">"` (шум шрифтовой разметки, не фраза). Чтобы
 * инвариант не утонул в ложных, обрывком считается ключ не короче 10 символов
 * и не менее чем из двух слов. Порог — константы, а не магия по месту.
 */
export const FRAGMENT_MIN_CHARS = 10;
export const FRAGMENT_MIN_WORDS = 2;

/** Длина в code points (как Python `len`, не UTF-16 units). */
function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** Осмысленный ли ключ для диагноза «обрывок» (см. `FRAGMENT_MIN_*`). */
export function isMeaningfulText(s: string): boolean {
  const text = pyStrip(s);
  if (cpLength(text) < FRAGMENT_MIN_CHARS) return false;
  return text.split(/\s+/).filter(Boolean).length >= FRAGMENT_MIN_WORDS;
}

/**
 * Отношение `msgid` к `rich_text`:
 *
 *   ok       — после чистки тегов и обрезки пробелов текст совпал (норма);
 *   suffix   — `msgid` = хвост полного текста (дефект дампа: `text` обрезан);
 *   mismatch — `msgid` в полном тексте не найден вовсе (второй подкласс:
 *              расхождение на символы, markup/кавычки);
 *   noise    — расхождение есть, но ключ ниже порога осмысленности (не диагноз).
 *
 * `plain` — полный текст без TMP-тегов (для отчёта и проверки политикой).
 */
export type RichRelation = "ok" | "suffix" | "mismatch" | "noise";

export interface RichCheck {
  relation: RichRelation;
  /** `rich_text` без TMP-тегов, обрезанный по краям. */
  plain: string;
}

/** Сравнить ключ с полным текстом rich_text. Единственная реализация. */
export function classifyRich(msgid: string, rich: string): RichCheck {
  const plain = pyStrip(stripTmpTags(rich));
  const id = pyStrip(msgid);
  if (plain === id) return { relation: "ok", plain };
  if (!isMeaningfulText(id)) return { relation: "noise", plain };
  return { relation: plain.endsWith(id) ? "suffix" : "mismatch", plain };
}

/** Условия правил skip-политики (имена — контракт JSON, менять нельзя молча). */
export type SkipCondition = "noLetters" | "shortToken" | "noWord" | "fragment";

/** Все допустимые условия; неизвестное — ошибка политики, не тихий игнор. */
export const SKIP_CONDITIONS: readonly SkipCondition[] = [
  "noLetters",
  "shortToken",
  "noWord",
  "fragment",
];

/** Есть ли в строке хоть одна буква (`\p{L}`). */
const HAS_LETTER_RX = /\p{L}/u;

/** «Нет ни одной буквы» — символы, цифры, пунктуация, пустота. */
export function hasLetters(s: string): boolean {
  return HAS_LETTER_RX.test(s);
}

/** Максимальная длина «короткого токена» в code points. */
export const SHORT_TOKEN_MAX_CHARS = 12;

/** Сколько букв должно быть в токене, чтобы он считался словом. */
export const WORD_MIN_LETTERS = 3;

/** Символ внутри токена: буква или цифра (`\p{L}`/`\p{N}`). */
const WORD_CHAR_RX = /[\p{L}\p{N}]/u;

/**
 * Есть ли в строке хотя бы одно «слово» — токен из ≥3 букв.
 *
 * Токен — максимальный отрезок букв/цифр; цифры в нём разрешены (иначе
 * `B33`, `5A?` и подобное считались бы словами), но считаются только буквы.
 * Замер 2026-11-23: на `raw:*` условие совпадает с 3 138 записями, из них
 * 2 961 — токены без пробелов, которые уже закрывает `shortToken`, а 177 —
 * ровно бинарный шум с пробелом (`wK Ax`, `j A`, `w? |b`), который иначе не
 * ловится ничем. Настоящие подписи (`ACCESS`, `ACHIEVEMENTS`, `SAVEFILENAME`)
 * не трогает: у них есть слово.
 */
export function hasWord(text: string): boolean {
  let letters = 0;
  for (const ch of text) {
    if (WORD_CHAR_RX.test(ch)) {
      if (HAS_LETTER_RX.test(ch)) letters += 1;
      continue;
    }
    if (letters >= WORD_MIN_LETTERS) return true;
    letters = 0;
  }
  return letters >= WORD_MIN_LETTERS;
}

/** Контекст проверки условия: ключ, rich_text и провенанс записи. */
export interface SkipContext {
  msgid: string;
  rich: string;
}

/**
 * Сработало ли условие правила на записи.
 *
 * `noLetters` — в ключе нет букв; `shortToken` — нет пробелов и ≤12 символов;
 * `noWord` — нет ни одного токена из ≥3 букв (бинарный шум raw-скана);
 * `fragment` — ключ это хвост `rich_text` (та же чистка, что у инварианта).
 * Провенанс (`src`) проверяет вызывающий: условие о тексте, не о метке.
 */
export function skipConditionMatches(when: SkipCondition, ctx: SkipContext): boolean {
  switch (when) {
    case "noLetters":
      return !hasLetters(ctx.msgid);
    case "shortToken":
      return !/\s/.test(ctx.msgid) && cpLength(ctx.msgid) <= SHORT_TOKEN_MAX_CHARS;
    case "noWord":
      // Бинарный шум raw-скана (`wK Ax`, `w? |b`): ни одного токена из ≥3 букв.
      return !hasWord(ctx.msgid);
    case "fragment":
      return classifyRich(ctx.msgid, ctx.rich).relation === "suffix";
    default:
      // Тип не даёт сюда попасть; runtime-страховка для данных из JSON.
      throw new Error(`неизвестное условие skip: ${String(when)}`);
  }
}
