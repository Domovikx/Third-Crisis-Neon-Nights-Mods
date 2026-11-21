/**
 * po_file.mts — минимальный парсер/рендерер PO для пайплайна NeonTranslator.
 *
 * Порт `extract-text/scripts/po_file.py` (поведение 1:1). Понимает подмножество,
 * которое реально производят Poedit/Weblate/msgmerge:
 *   - msgid / msgctxt / msgstr, однострочные и многострочные ("..." продолжения)
 *   - #: ссылки, #. извлечённые комментарии, #, флаги (включая fuzzy), # комментарии
 *   - заголовочную запись (msgid "")
 *
 * Это не полный gettext — ровно столько, чтобы каталоги round-trip'ились
 * детерминированно (байт-в-байт после parse → render).
 */

export interface PoEntry {
  msgid: string;
  msgctxt: string;
  msgstr: string;
  refs: string[];
  comments: string[];
  flags: string[];
  translator: string[];
}

const MSG_RX = /^(msgid|msgctxt|msgstr)\s+"(.*)"$/;
const CONT_RX = /^"(.*)"$/;
const REF_RX = /^#: +(.+)$/;
const FLAG_RX = /^#, +(.+)$/;
const CMT_RX = /^#\. +(.+)$/;
const TR_RX = /^# +(.+)$/;

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

/** Раскодировать PO-эскейпы (\n, \r, \t, \", \\; прочее — «как есть»). */
export function poUnescape(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      out += ESCAPES[n] ?? n;
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Закодировать строку для PO (одна строка, детерминированно). */
export function poEscape(s: string): string {
  return (s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

/** Пустая запись. */
export function newEntry(): PoEntry {
  return { msgid: "", msgctxt: "", msgstr: "", refs: [], comments: [], flags: [], translator: [] };
}

/** Поля, которые несут текст (всё остальное — списки комментариев/флагов). */
type MsgField = "msgid" | "msgctxt" | "msgstr";

function setField(e: PoEntry, f: MsgField, v: string): void {
  if (f === "msgid") e.msgid = v;
  else if (f === "msgctxt") e.msgctxt = v;
  else e.msgstr = v;
}

function appendField(e: PoEntry, f: MsgField, v: string): void {
  if (f === "msgid") e.msgid += v;
  else if (f === "msgctxt") e.msgctxt += v;
  else e.msgstr += v;
}

/** Разобрать PO/POT в массив записей. */
export function parsePo(text: string): PoEntry[] {
  const entries: PoEntry[] = [];
  let cur: PoEntry | null = null;
  let field: "msgid" | "msgctxt" | "msgstr" | null = null;

  const flush = (): void => {
    if (cur && (cur.msgid || cur.msgstr || cur.msgctxt || cur.refs.length)) entries.push(cur);
  };
  const ensure = (): PoEntry => (cur ??= newEntry());

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      cur = null;
      field = null;
      continue;
    }

    let m = MSG_RX.exec(line);
    if (m) {
      const f = m[1] as MsgField;
      field = f;
      setField(ensure(), f, poUnescape(m[2]));
      continue;
    }

    m = CONT_RX.exec(line);
    if (m && cur && field) {
      appendField(cur, field, poUnescape(m[1]));
      continue;
    }

    m = REF_RX.exec(line);
    if (m) {
      // Одна ссылка на строку `#:` (все наши писатели так и пишут).
      // Пробелы НЕ разделяют: стабильные refs содержат имена спикеров
      // с пробелами ([spk:Cartel Guy]) — сплит ломал бы их на фрагменты
      // при каждом round-trip parse → render.
      ensure().refs.push(m[1].trim());
      field = null;
      continue;
    }

    m = FLAG_RX.exec(line);
    if (m) {
      ensure().flags.push(...m[1].split(",").map((x) => x.trim()));
      field = null;
      continue;
    }

    m = CMT_RX.exec(line);
    if (m) {
      ensure().comments.push(m[1]);
      field = null;
      continue;
    }

    m = TR_RX.exec(line);
    if (m) {
      ensure().translator.push(m[1]);
      field = null;
      continue;
    }

    // Неизвестная строка: закрывает продолжение поля, иначе игнорируется.
    field = null;
  }

  flush();
  return entries;
}

/** Отрендерить записи + строки заголовка в PO-текст (один завершающий перевод строки). */
export function renderPo(entries: PoEntry[], headerLines: string[]): string {
  const out = [...headerLines, ""];
  for (const e of entries) {
    for (const ref of e.refs) out.push(`#: ${ref}`);
    for (const c of e.comments) out.push(`#. ${c}`);
    for (const t of e.translator) out.push(`# ${t}`);
    const flags = e.flags.filter(Boolean);
    if (flags.length) out.push(`#, ${flags.join(", ")}`);
    if (e.msgctxt) out.push(`msgctxt "${poEscape(e.msgctxt)}"`);
    out.push(`msgid "${poEscape(e.msgid)}"`);
    out.push(`msgstr "${poEscape(e.msgstr)}"`);
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}
