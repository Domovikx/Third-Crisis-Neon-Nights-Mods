/**
 * find_source.mts — провенанс: из какого объекта дампа пришёл msgid.
 *
 * Порт `extract-text/scripts/find_source.py` (поведение 1:1). POT/PO не несут
 * `#: refs` (мёртвый вес, ~50 % файла), поэтому источник строки — `tmp/dump`
 * (сканируется через `inventory.scanDump()`, тот же порядок, что у potgen).
 * Печатает каждое вхождение:
 *
 *   [kind:source#idx] speaker=X :: text
 *
 * Python-оригинал импортировал удалённый `potgen.py`; здесь используется
 * `potgen.mts`/`inventory.mts` (та же читающая половина).
 *
 * CLI: node .opencode/skills/extract-text/scripts/find_source.mts "msgid text"
 *        [--first] [--dump <dir>]
 * Exit 1, если ничего не найдено (или дампа нет).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { findChunks, findSummaries, scanDump, type InventoryItem } from "./inventory.mts";

/** Корень репозитория: .../extract-text/scripts → вверх 4 уровня. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
export const DEFAULT_DUMP_DIR = join(REPO_ROOT, "tmp", "dump");

/** Точный скан дампа: все записи с текстом, равным `text`. */
export async function find(
  text: string,
  options: { first?: boolean; dumpDir?: string } = {},
): Promise<InventoryItem[]> {
  const dumpDir = options.dumpDir ?? DEFAULT_DUMP_DIR;
  const inventory = await scanDump(dumpDir);
  const hits: InventoryItem[] = [];
  for (const item of inventory.items) {
    if (item.text === text) {
      hits.push(item);
      if (options.first) break;
    }
  }
  return hits;
}

/** Срез по code points (Python `s[:n]`), не по UTF-16 units. */
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** Строка отчёта: `[kind:source#idx] speaker=X :: text[:120]`. */
export function fmt(item: InventoryItem): string {
  let base = `${item.kind}:${item.source}`;
  if (item.idx !== null) base += `#${item.idx}`;
  const sp = item.speaker ? ` speaker=${item.speaker}` : "";
  return `[${base}]${sp} :: ${cpSlice(item.text, 120)}`;
}

const USAGE = `Usage: node find_source.mts "msgid text" [--first] [--dump <dir>]

  --first        остановиться на первом вхождении
  --dump <dir>   каталог JSONL-дампа (по умолчанию tmp/dump)
  -h, --help     эта справка`;

interface Cli {
  text?: string;
  first: boolean;
  dumpDir?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { first: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--first") cli.first = true;
    else if (arg === "--help" || arg === "-h") cli.help = true;
    else if (arg === "--dump") {
      const value = argv[i + 1];
      if (!value) throw new Error("--dump требует путь");
      i += 1;
      cli.dumpDir = value;
    } else if (arg.startsWith("--dump=")) cli.dumpDir = arg.slice("--dump=".length);
    else if (arg.startsWith("--"))
      continue; // как Python: любой флаг игнорируется
    else if (cli.text === undefined) cli.text = arg;
  }
  return cli;
}

/** CLI: 0 — найдено, 1 — нет/дамп пуст, 2 — ошибка аргументов. */
export async function main(argv: string[]): Promise<number> {
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
  if (cli.text === undefined) {
    console.error(USAGE);
    return 2;
  }

  // Python: `not find_chunks() and not find_summaries()` — пустой/отсутствующий
  // дамп. `readdir` на отсутствующем каталоге падает, поэтому явная проверка.
  const dumpDir = cli.dumpDir ?? DEFAULT_DUMP_DIR;
  const hasDump =
    existsSync(dumpDir) && (findChunks(dumpDir).length > 0 || findSummaries(dumpDir).length > 0);
  if (!hasDump) {
    console.error("ERROR: tmp/dump is empty or missing; run dump_assets.py first");
    return 1;
  }

  const hits = await find(cli.text, { first: cli.first, dumpDir });
  for (const h of hits) console.log(fmt(h));
  if (!hits.length) {
    console.error("no occurrences in tmp/dump");
    return 1;
  }
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
