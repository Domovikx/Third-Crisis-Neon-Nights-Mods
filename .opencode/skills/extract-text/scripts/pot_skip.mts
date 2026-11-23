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
import { hasSubstToken } from "../../pipeline-common/scripts/text_filters.mts";
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
export type SkipCondition =
  | "noLetters"
  | "shortToken"
  | "noWord"
  | "identifier"
  | "tokens"
  | "hexColor"
  | "assetPath"
  | "saveKey"
  | "snakeCase"
  | "fsmLabel"
  | "fragment";

/** Все допустимые условия; неизвестное — ошибка политики, не тихий игнор. */
export const SKIP_CONDITIONS: readonly SkipCondition[] = [
  "noLetters",
  "shortToken",
  "noWord",
  "identifier",
  "tokens",
  "hexColor",
  "assetPath",
  "saveKey",
  "snakeCase",
  "fsmLabel",
  "fragment",
];

/** Есть ли в строке хоть одна буква (`\p{L}`). */
const HAS_LETTER_RX = /\p{L}/u;

/** «Нет ни одной буквы» — символы, цифры, пунктуация, пустота. */
export function hasLetters(s: string): boolean {
  return HAS_LETTER_RX.test(s);
}

/**
 * Метка FSM: ключ начинается со слова `FSM`.
 *
 * `FSM Lio Printer`, `FSM Nova Moving In`, `FSM Sex XP` — имена машин состояний
 * Unity, которые игрок не видит. Замер 2026-11-23: 12 живых записей.
 */
export function isFsmLabel(s: string): boolean {
  // Одинокое «FSM» — слово, а не метка: нужен текст после него.
  return /^fsm\b\s*\S/iu.test(s.trim());
}

/**
 * Snake_case-токен внутри ключа: `CC_Option_Outfit_…`, `Apl_Female_Carte_Suit2`,
 * `PMA_IsNude`.
 *
 * Это имена ассетов, состояний FSM и отладочные сообщения Unity — игрок их не
 * видит как текст, а перевод даёт смешной гибрид («Апл_Женский_Карточный_Формат2»).
 * Признак структурный: буква + `_` + буква внутри одного слова. Замер
 * 2026-11-23: 415 живых записей, из них в диалогах — 1 (и это путь к ассету).
 */
export function isSnakeCase(s: string): boolean {
  return /\p{L}_\p{L}/u.test(s);
}

/**
 * Save-ключ игры: префикс до первого `/` оканчивается на `Keys`/`Key`.
 *
 * Примеры: `GlowingHoleKeys/103 Peeking Counter`, `CartelHideoutBadendKeys/Did
 * get naked`, `Character Keys/Did stare at ...`. Это идентификаторы состояния
 * для сохранений, игрок их не видит. Замер 2026-11-23: 85 живых записей.
 */
export function isSaveKey(s: string): boolean {
  const text = pyStrip(s);
  const slash = text.indexOf("/");
  if (slash <= 0) return false;
  const prefix = text.slice(0, slash).trim();
  return /(?:keys?)$/i.test(prefix);
}

/** Расширения файлов, которые встречаются в строках игры как ссылки. */
const ASSET_EXT_RX =
  /\.(png|jpe?g|gif|bmp|tga|psd|mat|asset|prefab|wav|ogg|mp3|json|txt|xml|dll|cs|shader|anim|controller|unity|fbx|ttf|otf|dat)\b/i;

/**
 * Похоже ли на путь к ассету, а не на текст для игрока.
 *
 * Замер 2026-11-23: в POT это ровно одна запись —
 * `Assets/AssetPacks/…/blackTex 1.png` из `dialog` (игра сама положила путь в
 * реплику). Узко намеренно: из 234 строк со слэшем `24/7 Kiosk`,
 * `Annoyed / Angry` и `Alpha: N/A` — настоящий текст, их резать нельзя.
 */
export function looksLikeAssetPath(s: string): boolean {
  const text = pyStrip(s);
  if (/^Assets\//i.test(text)) return true;
  if (/(^|[/\\])Resources\//.test(text)) return true;
  return ASSET_EXT_RX.test(text) && /[/\\]/.test(text);
}

/** Максимальная длина «короткого токена» в code points. */
export const SHORT_TOKEN_MAX_CHARS = 12;

/** Сколько букв должно быть в токене, чтобы он считался словом. */
export const WORD_MIN_LETTERS = 3;

/** CamelCase-идентификатор: только латиница/цифры, не ALLCAPS, ≥2 горба. */
const CAMEL_RX = /^[A-Za-z][A-Za-z0-9]*$/;
const ALL_CAPS_RX = /^[A-Z][A-Z0-9]*$/;
/** `snake_case` / `CONST_CASE`: латиница/цифры, разделённые `_`. */
const SNAKE_RX = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/;

/**
 * Похоже ли на программный идентификатор, а не на текст.
 *
 * Признак структурный, а не «по виду»: имя переменной/ассета/поля. Два класса:
 * CamelCase из ≥2 горбов (`AbilityName`, `Camera_Flash` — нет, это snake) и
 * `snake_case`/`CONST_CASE` (`DEFAULT_KEY`, `Char_Klaudia`). Слова с заглавной
 * (`Accept`), аббревиатуры (`ACCESS`, `ARRIVAL`) и дефисы (`Neon-Trust`) НЕ
 * считаются идентификаторами: их можно показывать игроку.
 *
 * Замер 2026-11-23: на `raw:*` это 2 242 записи, которых не закрывают
 * предыдущие правила; в них нет ни одного совпадения с `dialog`/`us`/
 * `settings`/`field:` (проверено по POT).
 */
export function looksLikeIdentifier(text: string): boolean {
  if (SNAKE_RX.test(text)) return true;
  if (!CAMEL_RX.test(text) || ALL_CAPS_RX.test(text)) return false;
  const humps = text.match(/[A-Z]/g)?.length ?? 0;
  return humps >= 2 || /^[a-z]+[A-Z]/.test(text);
}

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
 * `identifier` — программный идентификатор (CamelCase/snake_case/CONST_CASE);
 * `tokens` — шаблон подстановки (`#Имя#`, `{Имя}`, `%s`), не текст для игрока;
 * `hexColor` — `#RRGGBB` (константа цвета, встречается в куче `#US`);
 * `assetPath` — путь к ассету (`Assets/…`, `…/Resources/…`, файл с расширением);
 * `saveKey` — save-ключ (`…Keys/…`, `…Key/…`) из `raw:MonoBehaviour`;
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
    case "identifier":
      return looksLikeIdentifier(ctx.msgid);
    case "tokens":
      // Шаблон с подстановкой (`Received #ItemName#.`) — формат, не текст:
      // игра собирает из него строку и нашего перевода там не будет.
      return hasSubstToken(ctx.msgid);
    case "hexColor":
      // `#FFD24A` из кучи `#US` — константа цвета, а не строка для игрока.
      return /^#[0-9A-Fa-f]{3,8}$/u.test(pyStrip(ctx.msgid));
    case "assetPath":
      // Путь к ассету (`Assets/.../blackTex 1.png`) — это ссылка, не текст.
      return looksLikeAssetPath(ctx.msgid);
    case "snakeCase":
      return isSnakeCase(ctx.msgid);
    case "fsmLabel":
      return isFsmLabel(ctx.msgid);
    case "saveKey":
      // Save-ключ игры (`GlowingHoleKeys/103 Peeking Counter`) — идентификатор
      // состояния, а не реплика. Замер 2026-11-23: 85 живых записей.
      return isSaveKey(ctx.msgid);
    case "fragment":
      return classifyRich(ctx.msgid, ctx.rich).relation === "suffix";
    default:
      // Тип не даёт сюда попасть; runtime-страховка для данных из JSON.
      throw new Error(`неизвестное условие skip: ${String(when)}`);
  }
}
