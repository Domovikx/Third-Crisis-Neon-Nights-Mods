/**
 * rich_tags.mts — разбор TMP-разметки и перенос тегов БЕЗ догадок.
 *
 * Зачем свой парсер. Регекс `<[^>]+>` (и `<\/?[a-zA-Z][^<>]*>`) ловит за тег
 * авторские угловые кавычки: `< Like this, hmmm...? >` и `<< Declination … >>`.
 * Игра такой текст тегом не считает, значит и проверять/переносить его как тег
 * нельзя. Поэтому тег — только `<` + `/`? + имя + (параметры) + `>`, без `<`
 * внутри и без пробела сразу после `<`.
 *
 * Второе правило (владелец, 2026-11-24): позицию тега в переводе нельзя
 * угадывать. Если подсвеченный фрагмент не находится в переводе буквально
 * (перестановка слов, другой порядок), тег НЕ ставится: пара выбрасывается,
 * строка уходит в отчёт «разметка требует человека». Поэтому `placeTags`
 * никогда не создаёт `<b> </b>`, `<i></i>` и тег на пунктуации — у него просто
 * нет такой ветки: тег вставляется только вокруг найденного непустого текста.
 */

export interface RichTag {
  raw: string;
  name: string;
  closing: boolean;
  /** Смещения в исходной строке: `start..end` — сам тег. */
  start: number;
  end: number;
}

const NAME_RX = /^[a-zA-Z][a-zA-Z0-9-]*/;

/**
 * Разобрать теги строки. Всё, что не подходит под грамматику тега,
 * остаётся текстом (в том числе `< Like this >` и `<< … >>`).
 */
export function parseTags(s: string): RichTag[] {
  const out: RichTag[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "<") {
      i += 1;
      continue;
    }
    let j = i + 1;
    const closing = s[j] === "/";
    if (closing) j += 1;
    const name = NAME_RX.exec(s.slice(j))?.[0];
    if (!name) {
      i += 1;
      continue;
    }
    j += name.length;
    // Параметры: до `>`, но внутри не должно быть `<` (иначе это не тег).
    let k = j;
    while (k < s.length && s[k] !== ">" && s[k] !== "<") k += 1;
    if (k >= s.length || s[k] !== ">") {
      i += 1;
      continue;
    }
    out.push({ raw: s.slice(i, k + 1), name: name.toLowerCase(), closing, start: i, end: k + 1 });
    i = k + 1;
  }
  return out;
}

/** Подпись структуры: имена с закрытием, в порядке появления. */
export function tagSignature(s: string): string[] {
  return parseTags(s).map((t) => (t.closing ? "/" : "") + t.name);
}

/** Полные теги (с параметрами) в порядке появления — для строгого сравнения. */
export function tagRaws(s: string): string[] {
  return parseTags(s).map((t) => t.raw);
}

export interface Pair {
  open: RichTag;
  close: RichTag;
  inner: string;
  /** Смещение начала/конца внутреннего текста в «чистом» тексте строки. */
  innerStart: number;
  innerEnd: number;
}

export interface Segments {
  pairs: Pair[];
  /** Полный текст без тегов. */
  plain: string;
}

/**
 * Пары «открывающий → соответствующий закрывающий» + текст без тегов.
 *
 * Вложенность разбирается стеком; перекрещенные закрытия (`</i></color>` в
 * данных игры) закрывают ближайший подходящий тег, лишние игнорируются.
 */
export function segmentsOf(s: string, tags: RichTag[] = parseTags(s)): Segments {
  const pairs: Pair[] = [];
  const stack: { tag: RichTag; plainAt: number }[] = [];
  let plain = "";
  let last = 0;
  for (const tag of tags) {
    plain += s.slice(last, tag.start);
    last = tag.end;
    if (!tag.closing) {
      stack.push({ tag, plainAt: plain.length });
      continue;
    }
    const at = [...stack].reverse().findIndex((x) => x.tag.name === tag.name);
    if (at < 0) continue; // закрытие без открытия — мусор данных игры
    const item = stack[stack.length - 1 - at];
    stack.splice(stack.length - 1 - at, 1);
    pairs.push({
      open: item.tag,
      close: tag,
      inner: plain.slice(item.plainAt),
      innerStart: item.plainAt,
      innerEnd: plain.length,
    });
  }
  plain += s.slice(last);
  pairs.sort((a, b) => a.innerStart - b.innerStart || a.innerEnd - b.innerEnd);
  return { pairs, plain };
}

/**
 * Артефакты разметки: тег вокруг пустоты, пробела или пунктуации.
 *
 * Именно это видит игрок как «<b> </b> посреди фразы» или цвет без текста.
 */
export function findArtifacts(rt: string): string[] {
  const problems: string[] = [];
  const { pairs, plain } = segmentsOf(rt);
  const meaningful = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);
  for (const p of pairs) {
    const inner = p.inner.trim();
    if (!inner) problems.push(`пустая пара ${p.open.raw}${p.close.raw}`);
    else if (!meaningful(inner)) {
      // Пунктуация внутри тега — норма, только если ВСЯ строка из пунктуации
      // (данные игры: `<i>(... ! )</i>`). Если рядом есть слова, тег повис на
      // знаке — это артефакт переноса.
      const rest = plain.slice(0, p.innerStart) + plain.slice(p.innerEnd);
      if (meaningful(rest))
        problems.push(`тег на пунктуации ${p.open.raw}${JSON.stringify(inner)}${p.close.raw}`);
    }
  }
  const tags = parseTags(rt);
  const last = tags[tags.length - 1];
  if (last && !last.closing && rt.slice(last.end).trim() === "")
    problems.push(`открывающий тег в конце: ${last.raw}`);
  return problems;
}

export interface Placement {
  rt: string;
  /** Сколько тегов не поставлено (позиция не подтверждена). */
  dropped: number;
  /** Сколько тегов поставлено вокруг найденного текста. */
  placed: number;
}

/**
 * Перенести теги `rich` на текст `text` БЕЗ угадывания позиций.
 *
 *   - обёртка (`<i>весь текст</i>`) переносится точно: её границы — края
 *     текста, угадывать нечего;
 *   - inline-пара ставится только если её текст буквально найден в переводе
 *     (без учёта регистра) и в нём есть буква/цифра;
 *   - иначе пара выбрасывается целиком (в отчёт), текст остаётся как есть.
 *
 * Результат детерминированный: тот же вход — тот же выход.
 */
export function placeTags(rich: string, text: string): Placement {
  const tags = parseTags(rich);
  if (!tags.length) return { rt: text, dropped: 0, placed: 0 };
  if (!text) return { rt: text, dropped: tags.length, placed: 0 };
  const { pairs, plain } = segmentsOf(rich, tags);
  const total = plain.length;

  /** Границы пары в `text`, если позиция подтверждена. */
  const placementOf = (p: Pair): { from: number; to: number } | null => {
    if (p.innerStart === 0 && p.innerEnd === total) return { from: 0, to: text.length };
    const inner = p.inner;
    if (inner.trim().length < 2 || !/[\p{L}\p{N}]/u.test(inner)) return null;
    const at = text.toLowerCase().indexOf(inner.toLowerCase());
    if (at < 0) return null;
    return { from: at, to: at + inner.length };
  };

  // Смещение каждого тега в «чистом» тексте rich → позиция в text.
  const offsets = new Map<RichTag, number>();
  {
    let acc = 0;
    let last = 0;
    for (const t of tags) {
      acc += rich.slice(last, t.start).length;
      offsets.set(t, acc);
      last = t.end;
    }
  }
  const mapping = new Map<RichTag, number>();
  for (const p of pairs) {
    const at = placementOf(p);
    if (!at) continue;
    mapping.set(p.open, at.from);
    mapping.set(p.close, at.to);
  }
  // Непарный ОТКРЫВАЮЩИЙ тег в начале — структура игры (обрезка головы/хвоста:
  // `<i>> Hahh!`), он честно накрывает весь текст. Непарные закрытия и теги в
  // середине не переносим: закрытие без открытия ломает разметку перевода.
  const inPair = new Set<RichTag>();
  for (const p of pairs) {
    inPair.add(p.open);
    inPair.add(p.close);
  }
  for (const t of tags) {
    if (inPair.has(t) || mapping.has(t)) continue;
    if (!t.closing && (offsets.get(t) ?? -1) === 0) mapping.set(t, 0);
  }
  let out = "";
  let cursor = 0;
  let placed = 0;
  for (const t of tags) {
    const at = mapping.get(t);
    if (at === undefined || at < cursor) continue; // позиция не подтверждена
    out += text.slice(cursor, at) + t.raw;
    cursor = at;
    placed += 1;
  }
  out += text.slice(cursor);
  return { rt: out, dropped: tags.length - placed, placed };
}

/** Доля текста, накрытая каждой парой тегов (по убыванию). */
export function tagSpans(s: string): number[] {
  const { pairs, plain } = segmentsOf(s);
  const total = plain.length;
  if (!total) return [];
  return pairs.map((p) => (p.innerEnd - p.innerStart) / total).sort((a, b) => b - a);
}

/**
 * Выделение всей строки там, где оригинал выделял фрагмент.
 *
 * Так писал старый машинный пасс (`<b>` вокруг всего перевода). Структурно
 * годится, по смыслу — нет: такую разметку не переиспользуем, а переносим
 * заново (и, если позиция не подтвердится, уводим строку в отчёт).
 */
export function isDegeneratePlacement(rt: string, rich: string): boolean {
  const a = tagSpans(rt);
  const b = tagSpans(rich);
  if (!a.length || a.length !== b.length) return false;
  return a.some((v, i) => v > 0.9 && b[i] < 0.5);
}

/**
 * Переиспользовать расставленный `rt`, заменив теги на теги оригинала.
 *
 * Местами старый `rt` несёт «перверсию» (`<color=#B867FF><font …>` вместо
 * `<color=#EB83FF>`). Контракт теперь строгий, поэтому имена и параметры
 * берутся из `rich_text`, а позиции — из готового `rt`. Если структура не
 * совпала (тег потерян/лишний) — null: позиции восстанавливать не из чего.
 */
export function retagKeepingPositions(rt: string, rich: string): string | null {
  const richTags = parseTags(rich);
  const rtTags = parseTags(rt).filter((t) => t.name !== "font");
  if (richTags.length !== rtTags.length) return null;
  if (richTags.some((t, i) => t.name !== rtTags[i].name || t.closing !== rtTags[i].closing))
    return null;
  let out = "";
  let cursor = 0;
  let next = 0;
  for (const tag of parseTags(rt)) {
    out += rt.slice(cursor, tag.start);
    if (tag.name === "font") {
      // Стилевой слой `<font …>` принадлежит старой «перверсии»: на его месте
      // ставится тег из `rich_text` (или ничего, если это лишний `<font>`).
      cursor = tag.end;
      continue;
    }
    out += richTags[next].raw;
    next += 1;
    cursor = tag.end;
  }
  return out + rt.slice(cursor);
}
