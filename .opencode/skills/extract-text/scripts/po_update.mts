/**
 * po_update.mts — аналог `msgmerge -U`: перенос переводов в новый `template.pot`.
 *
 * Порт `extract-text/scripts/po_update.py` (поведение 1:1). Цикл обновления
 * (GNU gettext: def.po + ref.pot → updated def.po):
 *   - точное совпадение (msgid, msgctxt) → перевод переносится, refs/comments
 *     обновляются из POT;
 *   - ключ исчез, но текст жив под другим ctxt → ретаргет (спасение: рантайм
 *     всё равно ключует по голому тексту; примеры — слияние ui-двойника,
 *     переклассификация спикера);
 *   - текст пропал из POT целиком → запись остаётся живой с флагом `legacy`
 *     (устаревшая строка в .dat безвредна, потеря живого перевода — регрессия);
 *   - запись POT с `#, skip` («перевод не нужен»): пустого ключа в PO НЕ
 *     появляется, а уже существующий перевод сохраняется (и остаётся помечен);
 *   - новый ключ в POT → пустая запись в конце;
 *   - комментарии переводчика всегда переносятся;
 *   - никаких fuzzy-догадок (эвристики миграции — у prefill).
 *
 * Странности оригинала сохранены намеренно (см. комментарии в коде):
 * дубликаты msgid в PO — побеждает последний, «заголовок» = первый блок
 * файла до первой пустой строки (в PO без заголовка туда попадает весь файл).
 *
 * CLI: node .opencode/skills/extract-text/scripts/po_update.mts [lang] [--po-dir <dir>]
 * Out: po/<lang>.po перезаписан на месте (+ .bak).
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { compareCodePoints } from "./inventory.mts";
import { parsePo, poEscape, type PoEntry } from "./po_file.mts";
import { writeAtomic } from "./potgen.mts";

/** Корень репозитория: .../extract-text/scripts → вверх 4 уровня. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
export const DEFAULT_PO_DIR = join(REPO_ROOT, "po");

/** Запись в render_merged может нести архивный флаг `obsolete` (стиль gettext). */
export type MergedEntry = PoEntry & { obsolete?: boolean };

/** Статистика слияния — имена полей как в Python-версии. */
export interface MergeStats {
  carried: number;
  new: number;
  obsolete: number;
  retargeted: number;
  legacyKept: number;
  /**
   * Ключи POT с `#, skip`: в PO их нет вовсе (ни пустых, ни переведённых).
   *
   * Решение владельца 2026-11-23: инфошум не должен попадать в PO даже как
   * «уже переведённая» строка. Потери нет: у 2 695 таких строк в `ru` перевод
   * был либо копией `msgid`, либо транслитерацией мусора (`-APG` → `-АПГ`).
   */
  skipped: number;
  /** Переводы, чей текст в POT остался только под `#, skip`: в PO не перенесены. */
  skipDropped: number;
  /** Переводы вырезанных политикой текстов (ассеты): в PO не перенесены. */
  cutDropped: number;
}

/** Ключ каталога PO: пара (msgid, msgctxt), как tuple в Python. */
export type PoKey = readonly [string, string];

function keyId(key: PoKey): string {
  return JSON.stringify(key);
}

function keyOf(e: PoEntry): PoKey {
  return [e.msgid, e.msgctxt];
}

/** Порядок Python `sorted()` для кортежей строк — по code points. */
function compareKeys(a: PoKey, b: PoKey): number {
  return compareCodePoints(a[0], b[0]) || compareCodePoints(a[1], b[1]);
}

/** Копия записи (Python делает `dict(old)` — массивы остаются общими ссылками). */
function cloneEntry(e: PoEntry): PoEntry {
  return {
    ...e,
    refs: [...e.refs],
    comments: [...e.comments],
    flags: [...e.flags],
    translator: [...e.translator],
  };
}

/**
 * Слить переводы вперёд. Возвращает записи в порядке POT + хвост legacy.
 *
 * Порядок операций важен: сначала собираются ретаргеты по всем исчезнувшим
 * ключам (в отсортированном порядке, поэтому при двух кандидатах на один
 * целевой ключ побеждает последний по сортировке — как в Python), затем POT
 * рендерится построчно, затем хвост исчезнувших переводов.
 */
export function mergePot(
  poEntries: PoEntry[],
  potEntries: PoEntry[],
  /**
   * Тексты, вырезанные политикой отбора (журнал `pot-excluded.jsonl`).
   * Их переводы не сохраняются как `legacy`: это имена ассетов, а не текст.
   */
  cutTexts: ReadonlySet<string> = new Set(),
): { merged: MergedEntry[]; stats: MergeStats } {
  const poMap = new Map<string, PoEntry>();
  for (const e of poEntries) {
    if (e.msgid) poMap.set(keyId(keyOf(e)), e);
  }

  const potKeys: PoKey[] = [];
  const potByText = new Map<string, PoEntry[]>();
  for (const e of potEntries) {
    if (!e.msgid) continue;
    potKeys.push(keyOf(e));
    const group = potByText.get(e.msgid);
    if (group) group.push(e);
    else potByText.set(e.msgid, [e]);
  }
  const potKeyIds = new Set(potKeys.map(keyId));

  const stats: MergeStats = {
    carried: 0,
    new: 0,
    obsolete: 0,
    retargeted: 0,
    legacyKept: 0,
    skipped: 0,
    skipDropped: 0,
    cutDropped: 0,
  };
  const merged: MergedEntry[] = [];

  /** Ключи POT с `#, skip`: перевод не нужен (решение политики в potgen). */
  const skipIds = new Set<string>();
  /** Тексты, которые в POT есть ТОЛЬКО как skip (без живого ключа). */
  const skipTexts = new Set<string>();
  for (const pe of potEntries) {
    if (pe.msgid && pe.flags.includes("skip")) {
      skipIds.add(keyId(keyOf(pe)));
      skipTexts.add(pe.msgid);
    }
  }
  /** Живые (не skip) записи по тексту: только они — кандидаты ретаргета. */
  const liveByText = new Map<string, PoEntry[]>();
  for (const [text, group] of potByText) {
    const live = group.filter((e) => !skipIds.has(keyId(keyOf(e))));
    if (live.length) liveByText.set(text, live);
    else skipTexts.add(text);
  }

  /** Целевой ключ → (msgstr, translator), спасённые с исчезнувшего ключа. */
  const retargetFill = new Map<string, { msgstr: string; translator: string[] }>();

  const vanished = [...poMap.entries()]
    .filter(([id]) => !potKeyIds.has(id))
    .sort((a, b) => compareKeys(keyOf(a[1]), keyOf(b[1])));

  for (const [, old] of vanished) {
    if (!old.msgstr || old.flags.includes("legacy")) continue;
    const cands = liveByText.get(old.msgid) ?? [];
    // Если хоть один одноимённый ключ уже переведён, спасать некуда:
    // текст жив и без этого ретаргета.
    const live = cands.some((c) => Boolean(poMap.get(keyId(keyOf(c)))?.msgstr));
    if (cands.length && !live) {
      const sorted = [...cands].sort((a, b) => compareCodePoints(a.msgctxt, b.msgctxt));
      retargetFill.set(keyId(keyOf(sorted[0])), {
        msgstr: old.msgstr,
        translator: [...old.translator],
      });
      stats.retargeted += 1;
    }
  }

  for (const pe of potEntries) {
    if (!pe.msgid) continue;
    const id = keyId(keyOf(pe));
    const old = poMap.get(id);

    // «Перевод не нужен»: в PO не заводим ни пустую строку, ни «уже
    // переведённую». Старый перевод такого ключа — копия `msgid` или
    // транслитерация мусора, терять нечего (замер 2026-11-23: 2 695 строк в
    // `ru`, 1 382 из них = `msgid`, 1 226 — транслит вроде `-APG` → `-АПГ`).
    // При выключении правила `po_update` создаст строку заново (pустую).
    if (skipIds.has(id)) {
      stats.skipped += 1;
      continue;
    }

    const fill = retargetFill.get(id);
    let base = old;
    if (fill && !(base && base.msgstr)) {
      // Python: `dict(old) if old else {}` — у пустой записи флагов нет,
      // поэтому флаги берём только у реального старого перевода.
      const empty = base ?? {
        msgid: pe.msgid,
        msgctxt: pe.msgctxt,
        msgstr: "",
        refs: [],
        comments: [],
        flags: [],
        translator: [],
      };
      base = { ...empty, msgstr: fill.msgstr, translator: [...fill.translator] };
    }
    merged.push({
      msgid: pe.msgid,
      msgctxt: pe.msgctxt,
      msgstr: base ? base.msgstr : "",
      refs: [...pe.refs],
      comments: [...pe.comments],
      // `auto-normalized` — машинная догадка prefill: в новый POT не едет.
      // `skip` снимается: POT больше не помечает ключ, метке в PO не место.
      flags: (base ? base.flags : []).filter((f) => f !== "auto-normalized" && f !== "skip"),
      translator: base ? [...base.translator] : [],
    });
    if (base && base.msgstr) stats.carried += 1;
    else stats.new += 1;
  }

  // Хвост: переводы, чьих ключей нет в POT (и которых не спас ретаргет).
  for (const [, old] of vanished) {
    if (!old.msgstr) continue;
    // Вырезано политикой (ассет) — не важно, помечено ли уже `legacy`:
    // такой перевод в PO не нужен (иначе очистка не сработает на повторном
    // прогоне, проверено 2026-11-23).
    if (cutTexts.has(old.msgid)) {
      stats.cutDropped += 1;
      continue;
    }
    if (old.flags.includes("legacy")) {
      // Уже мигрированные триаж-переводы: их нет в POT по замыслу, в архив не уходят.
      merged.push(old);
      continue;
    }
    if (liveByText.has(old.msgid)) {
      // Текст жив под другим ctxt — спасён ретаргетом (или уже заполнен дубль).
      continue;
    }
    if (skipTexts.has(old.msgid)) {
      // Текст в POT остался только как skip: перевод не нужен (решение
      // 2026-11-23), в PO его не тянем даже хвостом `legacy`.
      stats.skipDropped += 1;
      continue;
    }
    const keep = cloneEntry(old);
    if (!keep.flags.includes("legacy")) {
      keep.flags = [...keep.flags, "legacy"];
      keep.translator = [
        ...keep.translator,
        "legacy: text vanished from POT, kept for runtime lookup",
      ];
    }
    merged.push(keep);
    stats.legacyKept += 1;
  }

  return { merged, stats };
}

/**
 * Отрендерить слияние: записи с `obsolete` — закомментированные блоки `#~`
 * (стиль gettext). `parsePo` такие строки при повторном чтении пропускает —
 * это документированное ограничение оригинала: архив читаем глазами.
 */
export function renderMerged(entries: MergedEntry[], header: string[]): string {
  const out: string[] = [...header, ""];
  for (const e of entries) {
    const prefix = e.obsolete ? "#~ " : "";
    for (const ref of e.refs) out.push(`${prefix}#: ${ref}`);
    for (const c of e.comments) out.push(`${prefix}#. ${c}`);
    for (const t of e.translator) out.push(`${prefix}# ${t}`.replace(/\s+$/, ""));
    const flags = e.flags.filter(Boolean);
    if (flags.length) out.push(`${prefix}#, ${flags.join(", ")}`);
    if (e.msgctxt) out.push(`${prefix}msgctxt "${poEscape(e.msgctxt)}"`);
    out.push(`${prefix}msgid "${poEscape(e.msgid)}"`);
    out.push(`${prefix}msgstr "${poEscape(e.msgstr)}"`);
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Заголовок = ПЕРВЫЙ блок файла до первой пустой строки, без пустых строк.
 *
 * `\r\n`/`\r` нормализуются в `\n`: Python читает текст в universal-newline
 * режиме, иначе в шапку попал бы `\r` (в репозиторных `po/*.po` EOL = CRLF).
 */
export function extractHeader(rawText: string): string[] {
  const universal = rawText.replace(/\r\n?/g, "\n");
  return universal
    .split("\n\n", 1)[0]
    .split("\n")
    .filter((line) => line !== "");
}

export interface PoUpdateOptions {
  lang?: string;
  /** Каталог с `template.pot` и `<lang>.po` (по умолчанию `po/` репозитория). */
  poDir?: string;
  /**
   * Журнал вырезанных политикой строк (`tmp/pot-excluded.jsonl`). Если файл
   * есть, переводы вырезанных текстов НЕ сохраняются как `legacy`: это имена
   * ассетов, их перевод — мусор в PO. По умолчанию ищется рядом с `poDir`
   * (`<root>/tmp/pot-excluded.jsonl`).
   */
  excludedPath?: string | null;
}

export interface PoUpdateResult {
  poPath: string;
  backupPath: string;
  stats: MergeStats;
}

/** Ядро: прочитать POT/PO, слить, записать PO (+ бэкап). Метаданные не нужны. */
export function runPoUpdate(options: PoUpdateOptions = {}): PoUpdateResult {
  const lang = options.lang ?? "ru";
  const poDir = options.poDir ?? DEFAULT_PO_DIR;

  const potRaw = readFileSync(join(poDir, "template.pot"), "utf8");
  const poPath = join(poDir, `${lang}.po`);
  if (!existsSync(poPath)) {
    throw new Error(`${poPath} missing (seed it from template.pot first)`);
  }

  const excludedPath =
    options.excludedPath === undefined
      ? join(poDir, "..", "tmp", "pot-excluded.jsonl")
      : options.excludedPath;
  const cutTexts = new Set<string>();
  if (excludedPath && existsSync(excludedPath)) {
    const journal = readFileSync(excludedPath, "utf8");
    for (const line of journal.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { msgid?: string };
        if (typeof row.msgid === "string") cutTexts.add(row.msgid);
      } catch {
        // Битые строки журнала не должны ломать слияние.
      }
    }
  }

  const poRaw = readFileSync(poPath, "utf8");
  const header = extractHeader(poRaw);
  const pot = parsePo(potRaw);
  const old = parsePo(poRaw);
  const { merged, stats } = mergePot(
    old.filter((e) => e.msgid),
    pot.filter((e) => e.msgid),
    cutTexts,
  );

  const backupPath = `${poPath}.bak`;
  copyFileSync(poPath, backupPath);
  writeAtomic(poPath, renderMerged(merged, header));
  return { poPath, backupPath, stats };
}

const USAGE = `Usage: node po_update.mts [lang] [--po-dir <dir>]

  lang            язык перевода (по умолчанию ru)
  --po-dir <dir>  каталог с template.pot и <lang>.po (по умолчанию po/)
  -h, --help      эта справка`;

interface Cli {
  lang: string;
  poDir?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { lang: "ru", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") cli.help = true;
    else if (arg === "--po-dir") {
      const value = argv[i + 1];
      if (!value) throw new Error("--po-dir требует путь");
      i += 1;
      cli.poDir = value;
    } else if (arg.startsWith("--po-dir=")) cli.poDir = arg.slice("--po-dir=".length);
    else if (arg.startsWith("-")) throw new Error(`неизвестный аргумент: ${arg}`);
    else cli.lang = arg;
  }
  return cli;
}

/** CLI: 0 — успех, 1 — ошибка обработки, 2 — ошибка аргументов. */
export function main(argv: string[]): number {
  let cli: Cli;
  try {
    cli = parseArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (cli.help) {
    console.error(USAGE);
    return 0;
  }
  try {
    const { poPath, stats } = runPoUpdate({ lang: cli.lang, poDir: cli.poDir });
    console.error(
      `${cli.lang}.po updated: carried=${stats.carried}, new=${stats.new}, ` +
        `obsolete=${stats.obsolete}, retargeted=${stats.retargeted}, ` +
        `legacy_kept=${stats.legacyKept}, skipped=${stats.skipped}, ` +
        `skip_dropped=${stats.skipDropped}, cut_dropped=${stats.cutDropped} ` +
        `(backup .bak) [${poPath}]`,
    );
    return 0;
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
