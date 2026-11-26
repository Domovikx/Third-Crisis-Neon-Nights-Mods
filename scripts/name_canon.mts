/**
 * name_canon.mts — канон имён персонажей: одна форма на язык, проверяемая механически.
 *
 * Зачем: имя в переводе — это «ключ» к персонажу. Если в одной строке `利奥`, в
 * другой `莉奥`, а в третьей латинское `Lio`, игрок видит трёх разных людей, а
 * поиск по имени ломается. То же с `ハイメ`/`ハイム` (Jaime в ja) и с
 * `Rungar`/`Rugnar`: в оригинале это два написания, и перевод обязан повторять
 * написание КОНКРЕТНОЙ строки, а не выбирать одно на всех.
 *
 * Источник канона — модуль `config/name-canon.mts` (JSON-артефакта нет):
 *   - `canon`  — имена, у которых есть строка `msgctxt "speaker-name"`. Тест
 *                требует, чтобы каждый PO был с ней согласен (это и есть
 *                «все speaker-name совпадают с каноном»);
 *   - `extra`  — имена без `speaker-name` (Jaime, Rungar), сверяются только по
 *                вариантам в тексте;
 *   - `wrong`  — формы, которых в тексте быть не должно.
 *
 * Границы: у латиницы — по буквам (`Lio` не ловит `FindLio`); у CJK границ нет,
 * поэтому для варианта-префикса канона (zh `伦加` ⊂ `伦加尔`) требуется, чтобы
 * следующий символ канона не стоял после варианта.
 */
import { resolve } from "node:path";

import { type PoEntry } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import { NAME_CANON, type NameCanon, type NameLang } from "../config/name-canon.mts";

export {
  NAME_CANON,
  NAME_LANGS,
  type NameCanon,
  type NameForms,
  type NameLang,
} from "../config/name-canon.mts";

/** Корень репозитория: scripts/ → на уровень выше. */
export const REPO_ROOT = resolve(import.meta.dirname, "..");

/** Канон имён — сам модуль конфига (единственный источник, без чтения файлов). */
export function loadNameCanon(): NameCanon {
  return NAME_CANON;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isAscii = (s: string): boolean => /^[\x20-\x7E]+$/u.test(s);

/**
 * Регэксп одного варианта имени.
 *
 * `canon` нужен только для варианта-префикса: `伦加` не должен срабатывать
 * внутри канонического `伦加尔`.
 *
 * Латиница длиной ≥5 допускает короткое окончание: в pl/de имя склоняется
 * («Rugnara», «Rungarowi»), и запрещённая форма должна ловиться вместе с ним.
 * Короткие имена (`Lio`, `Mira`) — строго по границам, иначе `Lio` поймал бы
 * `Lion`.
 */
export function variantRx(variant: string, canon = ""): RegExp {
  if (isAscii(variant)) {
    const tail = variant.length >= 5 ? "(?:[a-z]{0,3})?" : "";
    return new RegExp(`(?<![A-Za-z])${esc(variant)}${tail}(?![A-Za-z])`, "iu");
  }
  const at = canon.indexOf(variant);
  const after = at >= 0 ? canon[at + variant.length] : "";
  return new RegExp(`${esc(variant)}${after ? `(?!${esc(after)})` : ""}`, "u");
}

/** Есть ли имя `name` в оригинале строки (для латиницы — по границам слова). */
export function mentions(text: string, name: string): boolean {
  return variantRx(name).test(text);
}

/**
 * Расхождения `speaker-name` с каноном.
 *
 * Возвращает список «язык · имя · что стоит / что должно» — пусто, если всё
 * согласовано.
 */
export function speakerNameMismatches(
  canon: NameCanon,
  lang: NameLang,
  entries: PoEntry[],
): string[] {
  const byName = new Map(
    entries.filter((e) => e.msgctxt === "speaker-name" && e.msgid).map((e) => [e.msgid, e.msgstr]),
  );
  const out: string[] = [];
  for (const [name, forms] of Object.entries(canon.canon)) {
    const want = forms[lang];
    if (want === undefined) continue;
    const got = byName.get(name);
    if (got === undefined) out.push(`${lang}: нет строки speaker-name для «${name}»`);
    else if (got !== want) out.push(`${lang}: «${name}» = «${got}», канон «${want}»`);
  }
  return out;
}

/**
 * Запрещённые формы имён в тексте.
 *
 * Смотрим только строки, где имя есть в оригинале: если перевод имени нет
 * вовсе (местоимение), это другой класс дефекта — потеря, а не разнобой.
 */
export function wrongNameHits(canon: NameCanon, lang: NameLang, entries: PoEntry[]): string[] {
  const out: string[] = [];
  const canonById = { ...canon.canon, ...canon.extra };
  for (const e of entries) {
    if (!e.msgstr || e.flags.includes("skip") || e.msgctxt === "speaker-name") continue;
    for (const [name, variants] of Object.entries(canon.wrong[lang] ?? {})) {
      if (!mentions(e.msgid, name)) continue;
      // Строка про другое написание того же персонажа (Rungar ≠ Rugnar) — не наша.
      const other = name === "Rungar" ? "Rugnar" : name === "Rugnar" ? "Rungar" : "";
      if (other && mentions(e.msgid, other)) continue;
      const canonForm = canonById[name]?.[lang] ?? "";
      for (const v of variants) {
        if (!variantRx(v, canonForm).test(e.msgstr)) continue;
        out.push(
          `${lang}: «${name}» в оригинале, в переводе «${v}» (канон «${canonForm}»): ${e.msgstr.slice(0, 60)}`,
        );
        break;
      }
    }
  }
  return out;
}
