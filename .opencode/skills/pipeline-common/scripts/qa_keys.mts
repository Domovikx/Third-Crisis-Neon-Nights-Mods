/**
 * qa_keys.mts — список строк «на вычитку» (общий формат для judge и улучшения).
 *
 * Цепочка качества: `qa_judge.mts` пишет `<out>.bad.jsonl`, `translate_local.mts`
 * с `--improve --keys <файл>` переписывает только эти строки. Формат должен
 * быть ОДИН, иначе файл одного инструмента не читается другим.
 *
 * Ключ записи — `msgctxt \u0000 msgid` (как `entryKey` переводчика): один и тот
 * же текст в разных контекстах — разные строки, и путать их нельзя.
 *
 * Строка файла:
 *   {"c": "speaker:Zoey", "m": "Hello there"}   — полный ключ (основная форма)
 *   Hello there                                  — только msgid (контекст любой)
 */

/** Ключ записи PO. */
export function entryKey(e: { msgctxt?: string; msgid: string }): string {
  return `${e.msgctxt ?? ""}\u0000${e.msgid}`;
}

/**
 * Разобрать файл списка ключей.
 *
 * Возвращает множество ключей; для простых строк (без контекста) добавляется
 * ключ с пустым контекстом, поэтому вызывающий проверяет оба варианта.
 */
export function readKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("{")) {
      try {
        const o = JSON.parse(t) as { c?: string; m?: string };
        if (o.m) {
          keys.add(entryKey({ msgctxt: o.c ?? "", msgid: o.m }));
          continue;
        }
      } catch {
        // не JSON — обработаем как простую строку
      }
    }
    keys.add(entryKey({ msgid: t }));
  }
  return keys;
}

/** Совпадает ли запись со списком (по полному ключу или по одному msgid). */
export function inKeys(e: { msgctxt?: string; msgid: string }, keys: ReadonlySet<string>): boolean {
  return keys.has(entryKey(e)) || keys.has(entryKey({ msgid: e.msgid }));
}
