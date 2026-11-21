/**
 * po2dat.mts — компиляция `po/<lang>.po` в `runtime/patch_<lang>.dat`.
 *
 * Порт `extract-text/scripts/po2dat.py` (поведение 1:1). Игра читает ОДИН
 * JSON-lines файл вместо 1176 YAML. Строка:
 *   {"t": text, "x": translation, "r": rich_text?, "rt": rich_translation?, "sk": true?}
 *
 * rich_text берётся из `#. rich_text:` комментариев `po/template.pot`,
 * явный rich_translation — из `# rich: ...` в PO. Рантайм сам генерирует
 * rich_translation из rich+translation; явный `rt` побеждает.
 *
 * Дубликаты текста разрешаются по «earliest-ref-file-wins» (повторяет
 * first-wins загрузчика C# по отсортированным файлам).
 *
 * CLI: node .opencode/skills/extract-text/scripts/po2dat.mts [lang]
 * Out: runtime/patch_<lang>.dat (артефакт сборки, не трекается)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { parsePo, type PoEntry } from "./po_file.mts";

/** Корень репозитория: .../extract-text/scripts → вверх 4 уровня. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

export interface DatRow {
  t: string;
  x: string;
  r?: string;
  rt?: string;
  sk?: true;
}

export interface DatReport {
  poEntries: number;
  filled: number;
  dupes: Array<[string, Array<[string, string]>]>;
  noRich: number;
  richOnly: number;
  gatedAutoNormalized: number;
}

/** `msgid -> rich_text` из `#. rich_text:` комментариев template.pot (первый побеждает). */
export function loadPotRich(root: string = REPO_ROOT): Map<string, string> {
  const richMap = new Map<string, string>();
  const potPath = join(root, "po", "template.pot");
  if (!existsSync(potPath)) return richMap;
  for (const e of parsePo(readFileSync(potPath, "utf8"))) {
    if (!e.msgid || richMap.has(e.msgid)) continue;
    for (const c of e.comments) {
      if (c.startsWith("rich_text:")) {
        richMap.set(e.msgid, c.slice("rich_text:".length).trim());
        break;
      }
    }
  }
  return richMap;
}

/** Явный rich_translation из `# rich: ...` комментариев переводчика. */
export function rtOverride(entry: PoEntry | undefined): string {
  for (const c of entry?.translator ?? []) {
    if (c.startsWith("rich:")) return c.slice("rich:".length).trim();
  }
  return "";
}

/**
 * Порядковый ключ для разрешения дубликатов: сначала legacy-ссылки
 * `translations/...`, затем стабильные `[spk:...]`, иначе `~`.
 * (POT больше не пишет `#:` refs — тогда все ключи `~` и решает порядок файла.)
 */
function refKey(e: PoEntry): string {
  const files = e.refs.filter((r) => r.startsWith("translations/")).sort();
  const stable = e.refs.filter((r) => r.startsWith("[")).sort();
  files.push(...stable);
  return files[0] ?? "~";
}

/** Скомпилировать `po/<lang>.po` (+ rich из template.pot) в строки .dat. */
export function buildDat(
  lang: string,
  root: string = REPO_ROOT,
): { rows: DatRow[]; report: DatReport } {
  const poPath = join(root, "po", `${lang}.po`);
  if (!existsSync(poPath)) throw new Error(`missing ${poPath}`);

  const entries = parsePo(readFileSync(poPath, "utf8")).filter((e) => e.msgid);
  const richMap = loadPotRich(root);

  const report: DatReport = {
    poEntries: entries.length,
    filled: 0,
    dupes: [],
    noRich: 0,
    richOnly: 0,
    gatedAutoNormalized: 0,
  };
  const rows: DatRow[] = [];
  const seenTexts = new Set<string>();
  let gated = 0;

  const byText = new Map<string, PoEntry[]>();
  for (const e of entries) {
    const group = byText.get(e.msgid);
    if (group) group.push(e);
    else byText.set(e.msgid, [e]);
  }

  for (const [text, group] of byText) {
    const filled = group.filter((e) => e.msgstr);
    let msgstr = "";

    if (filled.length) {
      // Earliest-ref-file-wins: повторяет first-wins загрузчика C# по
      // отсортированным файлам (dialogues/ бьёт speakers.yaml для Cartel Guy).
      filled.sort((a, b) => (refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0));
      if (new Set(filled.map((e) => e.msgstr)).size > 1) {
        report.dupes.push([text, filled.map((e) => [e.msgstr.slice(0, 60), e.msgctxt])]);
      }
      msgstr = filled[0].msgstr;
      // Гейт ревью: авто-нормализованное едет только после подтверждения
      // человеком (снятие флага). До этого строка не попадает в словарь.
      // Гейт смотрит ТОЛЬКО на победителя сортировки: если у текста есть и
      // gated-, и ручная пара, победа gated-пары скроет ручной перевод
      // (поведение Python-версии; исправление — tasks/2026-11-21-po2dat-gated-order.md).
      if (filled[0].flags.includes("auto-normalized")) {
        gated += 1;
        continue;
      }
    }

    if (seenTexts.has(text)) continue;

    const rich = richMap.get(text) ?? "";
    const richTr = filled.length ? rtOverride(filled[0]) : "";
    if (!rich && !msgstr) continue;

    seenTexts.add(text);
    if (!rich) report.noRich += 1;

    const row: DatRow = { t: text, x: msgstr };
    if (rich) row.r = rich;
    if (richTr) row.rt = richTr;
    if (filled.length && filled[0].flags.includes("legacy")) row.sk = true;
    rows.push(row);

    if (msgstr) report.filled += 1;
    else report.richOnly += 1;
  }

  report.gatedAutoNormalized = gated;
  return { rows, report };
}

/**
 * Одна JSON-строка в формате старого Python-пайплайна:
 * `{"t": "...", "x": "..."}` — с `": "` и `", "`, чтобы `.dat` совпадал
 * байт-в-байт со сборкой `po2dat.py` (аудит миграции).
 */
export function toJsonLine(row: DatRow): string {
  const parts = Object.entries(row).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{${parts.join(", ")}}`;
}

/** Записать строки в .dat (один JSON-объект на строку, UTF-8).
 *
 * Запись атомарная (`.part` → rename): обрыв не оставит половину словаря.
 * Байты те же, что у прямой записи (паритет с po2dat.py не страдает).
 */
export function writeDat(rows: DatRow[], outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  const body = rows.map(toJsonLine).join("\n");
  const part = `${outPath}.part`;
  try {
    writeFileSync(part, rows.length ? body + "\n" : "", "utf8");
    renameSync(part, outPath);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}

function main(argv: string[]): number {
  const lang = argv[0] ?? "ru";
  const { rows, report } = buildDat(lang);
  const out = join(REPO_ROOT, "runtime", `patch_${lang}.dat`);
  writeDat(rows, out);

  console.error(`patch_${lang}.dat: ${rows.length} rows -> ${out}`);
  console.error(
    `  po entries: ${report.poEntries}, filled: ${report.filled}, no rich_text: ${report.noRich}`,
  );
  console.error(`  gated auto-normalized (awaiting human): ${report.gatedAutoNormalized}`);
  for (const [text, variants] of report.dupes) {
    console.error(`  DUPE ${JSON.stringify(text)}: ${JSON.stringify(variants)}`);
  }
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
