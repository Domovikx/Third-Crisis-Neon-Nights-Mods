/**
 * emit.mts — как конфиг печатает свой JSON-артефакт и сгенерированный TS-код.
 *
 * Конфиги — `.mts`-модули (типизированные объекты), а рядом лежит JSON-артефакт
 * для Rust и рантайма. Печатать его должен сам модуль:
 *
 *   node config/language-priority.mts > config/language-priority.json
 *
 * JSON форматирует prettier от компактной записи: ширина решает, что остаётся
 * на одной строке, — поэтому перегенерация побайтно совпадает с закоммиченным
 * файлом (`git diff` пуст), а `npm run format:check` не ругается.
 * prettier грузится ДИНАМИЧЕСКИ: модули конфигов импортируют и рантайм-скрипты,
 * которым devDependency не нужна.
 */

/** JSON-артефакт конфига: prettier от компактного JSON. */
export async function renderJson(value: unknown): Promise<string> {
  const { format } = await import("prettier");
  return format(JSON.stringify(value), { parser: "json", filepath: "config/emit.json" });
}

/** Сгенерированный TypeScript (для `--write`-генераторов вроде speaker_gender). */
export async function formatTypeScript(code: string): Promise<string> {
  const { format } = await import("prettier");
  return format(code, {
    parser: "typescript",
    quoteProps: "consistent",
    filepath: "config/emit.ts",
  });
}
