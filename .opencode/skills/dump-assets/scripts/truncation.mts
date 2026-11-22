/**
 * truncation.mts — единый учёт обрезок при извлечении (чтобы они не были тихими).
 *
 * Принцип: ограничение на КОЛИЧЕСТВО строк, попадающих в дамп, допустимо только
 * если (а) оно настраиваемое, (б) посчитано и показано в конце прогона.
 * Тихая обрезка — дефект источника данных: аудит покрытия POT (2026-11-22)
 * показал, что `raw_strings[:100]` терял 2 940 429 строк у 1 768 объектов
 * (40.6 МБ сырого текста, 70 % всех raw-строк), а `#US`-куча с лимитом 500
 * отрезала 251 UI-кандидат.
 *
 * `null` в лимите = без ограничения. По умолчанию без лимита идут
 * `raw_strings` и UI-строки `#US`; лимит сохранён только там, где он защищает
 * от мусора и не имеет потребителей (`global_strings`: 2.06 млн кандидатов на
 * корпусе, в POT это поле не читается вовсе).
 */

/** Сколько и чего отбросил лимит. */
export interface TruncationBucket {
  /** Сколько объектов/ассетов затронуто (единица задаётся меткой в отчёте). */
  units: number;
  /** Сколько строк/значений не попало в дамп. */
  dropped: number;
  /** Действующий лимит (`null` — без лимита; для отчёта). */
  limit: number | null;
}

/** Все точки, где извлечение режет данные. */
export interface TruncationReport {
  rawStrings: TruncationBucket;
  globalStrings: TruncationBucket;
  dotnetUi: TruncationBucket;
  /** Значения строковых полей, срезанные по длине (`MAX_STRING_LEN`). */
  stringLength: TruncationBucket;
}

function bucket(): TruncationBucket {
  return { units: 0, dropped: 0, limit: null };
}

/** Пустой отчёт — один на прогон дампа (счётчики копятся по ходу). */
export function createTruncationReport(): TruncationReport {
  return {
    rawStrings: bucket(),
    globalStrings: bucket(),
    dotnetUi: bucket(),
    stringLength: bucket(),
  };
}

/**
 * Оставить не больше `limit` элементов.
 *
 * При обрезке пополняет бакет: `units` +1 (объект/ассет), `dropped` — на число
 * отброшенных элементов. При `limit === null` возвращает исходный массив.
 */
export function capList<T>(items: T[], limit: number | null, target: TruncationBucket): T[] {
  if (limit === null) {
    target.limit = null;
    return items;
  }
  target.limit = limit;
  if (items.length <= limit) return items;
  target.units += 1;
  target.dropped += items.length - limit;
  return items.slice(0, limit);
}

/** Есть ли в отчёте хоть одна обрезка. */
export function hasTruncations(report: TruncationReport): boolean {
  return Object.values(report).some((item) => item.dropped > 0);
}

const FIELDS: Array<[keyof TruncationReport, string]> = [
  ["rawStrings", "raw_strings"],
  ["globalStrings", "global_strings"],
  ["dotnetUi", "UI-строки #US"],
  ["stringLength", "значения строк длиннее MAX_STRING_LEN"],
];

/**
 * Человеческие строки отчёта об обрезках (пусто, если резать не пришлось).
 *
 * Формат нарочно без числительных: сообщение читает человек, а не парсер,
 * и главное в нём — что обрезка была, сколько и при каком лимите.
 */
export function formatTruncations(report: TruncationReport): string[] {
  const lines: string[] = [];
  for (const [key, label] of FIELDS) {
    const item = report[key];
    if (item.dropped === 0) continue;
    lines.push(
      `  ${label}: отброшено ${item.dropped} (затронуто: ${item.units}, лимит: ${item.limit ?? "нет"})`,
    );
  }
  return lines;
}

/** Пределы прогона одной строкой (для журнала запуска). */
export function formatLimits(report: TruncationReport): string {
  const show = (value: number | null): string => (value === null ? "без лимита" : String(value));
  return [
    `raw_strings=${show(report.rawStrings.limit)}/объект`,
    `global_strings=${show(report.globalStrings.limit)}/ассет`,
    `#US=${show(report.dotnetUi.limit)}/сборка`,
  ].join(", ");
}

/**
 * Значение CLI-флага лимита: число, `null` для «без лимита».
 *
 * `all`, `none`, `0` и `-1` — без лимита (человеческие способы это сказать).
 * `undefined` — значение не разобрано (ошибка аргумента).
 */
export function parseLimit(value: string): number | null | undefined {
  const text = value.trim().toLowerCase();
  if (text === "all" || text === "none" || text === "" || text === "0" || text === "-1")
    return null;
  if (!/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
