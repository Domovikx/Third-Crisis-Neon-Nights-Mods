/**
 * text_filters.mts — общие фильтры пайплайна (единственный владелец).
 *
 * Порт-паритет `pipeline-common/scripts/text_filters.py` (R2-рефакторинг в
 * старом репо, логика не менялась). Контракт: общие фильтры импортируются
 * отсюда и НИКОГДА не дублируются в скиллах — правка только в этом файле.
 *
 * Отличие от Python: `str.isdigit()` заменён на ASCII-цифры (`/[0-9]/`):
 * имена Unity-компонентов всегда латиница, а поведение должно быть
 * предсказуемым (арабско-индийские цифры нам не нужны).
 */

/** Строки, которые не переводятся в принципе (сырые ключи PlayMaker/пресетов). */
export const SKIP_RAW_PREFIXES = [
  "line_",
  "expressions/",
  "separatedexpressions/",
  "Poses/",
  "expressionadditive/",
  "p>xo",
  "Other Dialogue Presets",
  "Zoey Dialogue Presets",
  "_Preset",
  "Dialogue Presets",
  "Char_",
  "Apl_",
] as const;

/** Спикеры, у которых голоса/реплики не переводятся как диалог. */
export const KNOWN_NON_SPEAKERS = new Set<string>([
  "GlowingHole",
  "GlowingHoleKeys/",
  "Narrator",
  "Confirm",
  "Other Dialogue Presets",
  "Zoey Dialogue Presets",
  "Simon",
]);

/**
 * Авто-триаж: имена ассетов и бинарный мусор получают skip при рождении.
 * Применяется ТОЛЬКО к raw/settings (UI-ish) записям, никогда к диалогам —
 * в истории может встретиться что угодно.
 */

/** Сигналы Unity-компонентов в токенах без пробелов. */
const ASSET_SUFFIXES = [
  "Renderer",
  "System",
  "Manager",
  "Controller",
  "Handler",
  "Receiver",
  "Target",
  "Pickup",
  "Link",
  "Mask",
  "Interact",
  "Effect",
  "UI",
] as const;

const ASSET_PREFIXES = ["NN", "AMS"] as const;

/** Unity-компонент/скрипт? (NNHsvRenderer, EventSystem, NodeLink2)
 *
 * Правило «любая цифра = ассет» действует только на строки БЕЗ пробелов:
 * «Zone 2» останется текстом, «Zone2» уйдёт в skip. Так же отсекаются
 * GUID/хэши и имена вида `Text (TMP)` — но не как мусор, а как ассет.
 */
export function isAssetName(s: string): boolean {
  if (!s || s.includes(" ") || s.length < 4) return false;
  if (ASSET_PREFIXES.some((p) => s.startsWith(p))) return true;
  if (ASSET_SUFFIXES.some((p) => s.endsWith(p))) return true;
  if (/[0-9]/.test(s)) return true;
  return false;
}

/** Легитимное использование процента — цифры + необязательный пробел + `%` в конце. */
const PCT_LEGIT_RX = /[0-9]+\s?%$/;

/**
 * Бинарный мусор? (Bff?D, H\?d, %IR, S5?d)
 *
 * Легитимный процент — цифры перед `%` в конце ("50%"); легитимный `?` —
 * в конце строки ("Really?"). Диалоги исключены (проверяет вызывающий).
 */
export function isGarbageFragment(s: string): boolean {
  if (!s) return false;
  if (s.includes("\\")) return true;
  if (s.includes("%") && !PCT_LEGIT_RX.test(s)) return true;
  if (s.includes("?") && !s.includes(" ") && !s.endsWith("?") && s.length <= 12) {
    // Пунктуация вроде ?!, ?..., ?? — легитимна; `?`, приклеенный к буквам
    // или символам (Bff?D, S5?d), — бинарный фрагмент.
    for (let i = 0; i < s.length; i++) {
      const next = s[i + 1];
      if (s[i] === "?" && i + 1 < s.length && !"!?.".includes(next)) return true;
    }
  }
  return false;
}

/** Пресет авто-триажа или null, если строка обычная. */
export interface AutoTriage {
  translation: string;
  skipTranslation: boolean;
}

/** Пресет для авто-триажа строк, иначе null. */
export function autoTriage(text: string): AutoTriage | null {
  if (isAssetName(text) || isGarbageFragment(text)) {
    return { translation: text, skipTranslation: true };
  }
  return null;
}

/** TMP-теги (`<color=...>`, `<font=...>`): вырезаются для проверок/длины. */
export const RICH_TAG_RX = /<[^>]+>/g;

/** Строка начинается с известного «не переводить» префикса. */
export function isSkipPrefix(s: string): boolean {
  return SKIP_RAW_PREFIXES.some((p) => s.startsWith(p));
}

/** Убрать rich-теги и обрезать пробелы по краям. */
export function stripRich(s: string): string {
  return s.replace(RICH_TAG_RX, "").trim();
}
