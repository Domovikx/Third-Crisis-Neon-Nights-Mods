/**
 * leak_guard.mts — утечка инструкций промпта в перевод.
 *
 * Симптом: в `msgstr` стоит не реплика, а сам промпт переводчика —
 * «Перевод каждой строки. Отвечайте ровно одной строкой в формате «N. перевод»…».
 * В игре это видно как текст реплики (проверено 2026-11-23: 4 строки в ru,
 * причём судья-LLM такую строку ОТКЛОНИЛА как «translation instructions, not
 * source content» — то есть согласилась с обвинением и всё равно сказала
 * «dismissed»; поэтому проверка механическая).
 *
 * Детектор намеренно узкий: только устойчивые обороты наших промптов. Любая
 * попытка «ловить инструкции вообще» начнёт срабатывать на репликах героев,
 * которые как раз обсуждают инструкции.
 */

/** Устойчивые обороты промпта переводчика/судьи. */
export const LEAK_PATTERNS: RegExp[] = [
  /Отвечайте\s+ровно\s+(?:одной|N)/iu,
  /Перевод(?:им)?\s+каждой\s+строки/iu,
  /Никогда\s+не\s+повторяйте\s+тег/iu,
  /в\s+формате\s+«?N\.\s*перевод/iu,
  /Translate\s+each\s+line/iu,
  /Reply\s+with\s+exactly\s+\d+\s+lines?/iu,
  /Never\s+repeat\s+the\s+speaker/iu,
  /Answer\s+ONLY\s+JSON/iu,
];

/** Вернуть найденные обороты (пусто — утечки нет). */
export function leakHits(text: string): string[] {
  return LEAK_PATTERNS.filter((re) => re.test(text)).map((re) => re.source.slice(0, 32));
}

/** Есть ли в тексте утечка промпта. */
export function isPromptLeak(text: string): boolean {
  return LEAK_PATTERNS.some((re) => re.test(text));
}
