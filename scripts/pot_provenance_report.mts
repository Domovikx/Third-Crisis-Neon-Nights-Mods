/**
 * pot_provenance_report.mts — распределение POT по провенансу (`#. src:`).
 *
 * Главный артефакт задачи `tasks/2026-11-22-pot-provenance.md`: по числам
 * видно, ЧТО именно генератор отбирает, а что нет. Ничего не фильтрует и не
 * меняет — только читает дамп и POT-каталог.
 *
 * Вход: JSONL-дамп (`tmp/dump-after` по умолчанию) и тот же `scanDump`,
 * которым собирается POT. Ничего в `po/` не пишется.
 *
 * Понятия отчёта (совпадают с `docs/pot-provenance.md`):
 *   - `в инвентаре` — вхождений строк с этой меткой (до дедупа ключей);
 *   - `ключей` — уникальных `(msgid, msgctxt)`, которым метка досталась
 *     первой (правило «первое вхождение побеждает»);
 *   - `в POT` — из них дожили до каталога (ui-двойники удалены);
 *   - `проза` — мягкий тест `looksLikeProse` (МЕТРИКА, не фильтр).
 *
 * Запуск: `node scripts/pot_provenance_report.mts --dump tmp/dump-after`
 * (без `--out` печатает markdown в stdout).
 */
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

import {
  ctxtOf,
  REPO_ROOT,
  buildCatalog,
  srcOf,
  type PotSlot,
} from "../.opencode/skills/extract-text/scripts/pot_rules.mts";
import {
  SRC_LABELS,
  scanDump,
  type InventoryItem,
} from "../.opencode/skills/extract-text/scripts/inventory.mts";

export type SrcCatalog = Map<string, Map<string, PotSlot>>;

/** Ранг метки: фиксированный список первым, параметры (`field:`, `raw:`) — по имени. */
const PREFIX_RANK: Readonly<Record<string, number>> = {
  dialog: 0,
  bundle: 1,
  "field:": 2,
  settings: 3,
  us: 4,
  "raw:": 5,
  global: 6,
};

/** Порядок меток в отчёте: стабильный и читаемый. */
export function compareSrc(a: string, b: string): number {
  const rank = (src: string): number => {
    for (const label of SRC_LABELS) if (src === label) return PREFIX_RANK[label];
    if (src.startsWith("field:")) return PREFIX_RANK["field:"];
    if (src.startsWith("raw:")) return PREFIX_RANK["raw:"];
    return 99;
  };
  const ra = rank(a);
  const rb = rank(b);
  return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Мягкий тест «похоже на прозу» — метрика отчёта, НЕ фильтр отбора.
// ---------------------------------------------------------------------------

/** Символы, обычные для предложения (буквы/цифры проверяются отдельно). */
const PROSE_OK_RX = /^[\p{L}\p{N} .,!?'"…:;\-–—()[\]/]$/u;

/**
 * Похоже ли строка на прозу (предложение/лейбл, а не обрывок блоба).
 *
 * Порог мягкий и объяснимый: ≥3 слов, ≥3 слова содержат ≥2 букв, ≥50 %
 * символов — буквы, ≤5 % символов вне «обычной» пунктуации. Это МЕТРИКА для
 * отчёта: решение об отборе принимается по `src`, а не по внешнему виду
 * (приказ владельца 2026-11-22 — «кракозябры могут быть замыслом»).
 */
export function looksLikeProse(text: string): boolean {
  const chars = [...text];
  if (!chars.length) return false;
  let bad = 0;
  let letters = 0;
  for (const ch of chars) {
    if (!PROSE_OK_RX.test(ch)) bad += 1;
    if (/\p{L}/u.test(ch)) letters += 1;
  }
  if (bad / chars.length > 0.05) return false;
  if (letters / chars.length < 0.5) return false;
  const words = text.split(/[\s]+/).filter((w) => w.length > 0);
  const rich = words.filter((w) => [...w].filter((c) => /\p{L}/u.test(c)).length >= 2);
  return words.length >= 3 && rich.length >= 3;
}

// ---------------------------------------------------------------------------
// Распределение
// ---------------------------------------------------------------------------

export interface SrcExample {
  text: string;
  ctxt: string;
}

export interface SrcStat {
  src: string;
  /** Вхождений в инвентаре. */
  items: number;
  /** Уникальных ключей, которым метка досталась первой. */
  keys: number;
  /** Из них дожили до POT. */
  pot: number;
  /** POT-записей, похожих на прозу (мягкий тест). */
  prose: number;
  /** До 10 примеров POT-записей этого источника. */
  examples: SrcExample[];
}

function itemKey(item: InventoryItem): string {
  return JSON.stringify([item.text, ctxtOf(item)]);
}

/** Равномерная детерминированная выборка до `limit` элементов. */
function sampleEvenly<T>(list: readonly T[], limit = 10): T[] {
  if (list.length <= limit) return [...list];
  const step = list.length / limit;
  return Array.from({ length: limit }, (_, i) => list[Math.floor(i * step)]);
}

/**
 * Распределение инвентаря и каталога по `src`.
 *
 * `items` — инвентарь в порядке `finish()` (порядок важен: метка ключа — от
 * первого вхождения), `catalog` — итоговый каталог POT.
 */
export function distribution(items: readonly InventoryItem[], catalog: SrcCatalog): SrcStat[] {
  const itemCounts = new Map<string, number>();
  const keySrc = new Map<string, string>();
  for (const item of items) {
    itemCounts.set(item.src, (itemCounts.get(item.src) ?? 0) + 1);
    const key = itemKey(item);
    if (!keySrc.has(key)) keySrc.set(key, item.src);
  }
  const keyCounts = new Map<string, number>();
  for (const src of keySrc.values()) keyCounts.set(src, (keyCounts.get(src) ?? 0) + 1);

  const potSrc = srcOf(catalog);
  const potCounts = new Map<string, number>();
  const proseCounts = new Map<string, number>();
  const samples = new Map<string, SrcExample[]>();
  for (const [key, src] of potSrc) {
    const [text, ctxt] = JSON.parse(key) as [string, string];
    potCounts.set(src, (potCounts.get(src) ?? 0) + 1);
    if (looksLikeProse(text)) proseCounts.set(src, (proseCounts.get(src) ?? 0) + 1);
    const list = samples.get(src) ?? [];
    list.push({ text, ctxt });
    samples.set(src, list);
  }

  const all = new Set<string>([...itemCounts.keys(), ...potCounts.keys(), ...keyCounts.keys()]);
  return [...all].sort(compareSrc).map((src) => {
    const list = (samples.get(src) ?? []).sort((a, b) =>
      a.text < b.text ? -1 : a.text > b.text ? 1 : a.ctxt < b.ctxt ? -1 : 1,
    );
    return {
      src,
      items: itemCounts.get(src) ?? 0,
      keys: keyCounts.get(src) ?? 0,
      pot: potCounts.get(src) ?? 0,
      prose: proseCounts.get(src) ?? 0,
      examples: sampleEvenly(list),
    };
  });
}

// ---------------------------------------------------------------------------
// Источники, которые инвентарь не читает (`global`)
// ---------------------------------------------------------------------------

export interface GlobalStats {
  /** Уникальных строк в `global_strings` дампа. */
  candidates: number;
  /** Сколько из них уже есть в POT (как msgid, любым путём доставки). */
  inPot: number;
  /** Из `inPot` похожих на прозу. */
  prose: number;
  examples: string[];
}

/** `global_strings` из `summaries.jsonl`: кандидаты и пересечение с POT. */
export async function globalStats(dumpDir: string, catalog: SrcCatalog): Promise<GlobalStats> {
  const seen = new Set<string>();
  const path = join(dumpDir, "summaries.jsonl");
  if (existsSync(path)) {
    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj === null || typeof obj !== "object") continue;
      const strings = (obj as { global_strings?: unknown }).global_strings;
      if (!Array.isArray(strings)) continue;
      for (const s of strings) if (typeof s === "string" && s) seen.add(s);
    }
  }
  let inPot = 0;
  let prose = 0;
  const examples: string[] = [];
  for (const text of seen) {
    if (!catalog.has(text)) continue;
    inPot += 1;
    if (looksLikeProse(text)) {
      prose += 1;
      if (examples.length < 10) examples.push(text);
    }
  }
  return { candidates: seen.size, inPot, prose, examples };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const pct = (part: number, total: number): string =>
  total ? `${((part / total) * 100).toFixed(1)} %` : "—";

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Сократить пример для markdown: длинные строки режутся по code points. */
export function truncate(text: string, limit = 72): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
}

export function formatReport(stats: readonly SrcStat[], globals: GlobalStats): string {
  const totalItems = stats.reduce((n, s) => n + s.items, 0);
  const totalKeys = stats.reduce((n, s) => n + s.keys, 0);
  const totalPot = stats.reduce((n, s) => n + s.pot, 0);
  const totalProse = stats.reduce((n, s) => n + s.prose, 0);

  const lines: string[] = [];
  lines.push("## Распределение");
  lines.push("");
  lines.push("| `src` | в инвентаре | ключей | в POT | доля POT | проза | проза в классе |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const s of stats) {
    lines.push(
      `| \`${cell(s.src)}\` | ${s.items} | ${s.keys} | ${s.pot} | ${pct(s.pot, totalPot)} | ` +
        `${s.prose} | ${pct(s.prose, s.pot)} |`,
    );
  }
  lines.push(
    `| **итого** | **${totalItems}** | **${totalKeys}** | **${totalPot}** | 100 % | ` +
      `**${totalProse}** | ${pct(totalProse, totalPot)} |`,
  );
  lines.push("");
  lines.push(
    "`global` в инвентаре 0: этот источник сегодня НЕ читается (см. раздел ниже). " +
      "Сумма «ключей» больше «в POT» на удалённые ui-двойники.",
  );

  lines.push("");
  lines.push("## Примеры (равномерная выборка до 10 записей из POT)");
  for (const s of stats) {
    lines.push("");
    lines.push(`### \`${s.src}\` — ${s.pot} в POT, проза ${s.prose}`);
    if (!s.examples.length) {
      lines.push("- (нет записей в POT)");
      continue;
    }
    for (const e of s.examples) {
      lines.push(`- \`${truncate(e.text)}\` — \`${cell(e.ctxt)}\``);
    }
  }

  lines.push("");
  lines.push("## `global` — кандидаты, которые инвентарь не читает");
  lines.push("");
  lines.push(
    `- уникальных строк в \`global_strings\`: **${globals.candidates}**; ` +
      `из них в POT (любым путём): **${globals.inPot}**; похожих на прозу: ${globals.prose}.`,
  );
  if (globals.examples.length) {
    lines.push("");
    lines.push("Примеры (уже в POT через другой источник):");
    for (const text of globals.examples) lines.push(`- \`${truncate(text)}\``);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ReportResult {
  stats: SrcStat[];
  globals: GlobalStats;
  markdown: string;
}

/** Полный прогон: дамп → инвентарь → каталог → распределение. */
export async function runReport(dumpDir: string): Promise<ReportResult> {
  const inventory = await scanDump(dumpDir);
  const { catalog } = buildCatalog(inventory.items);
  const stats = distribution(inventory.items, catalog);
  const globals = await globalStats(dumpDir, catalog);
  return { stats, globals, markdown: formatReport(stats, globals) };
}

const USAGE = `Usage: node pot_provenance_report.mts [--dump <dir>] [--out <file>] [--json]

  --dump <dir>   каталог JSONL-дампа (по умолчанию tmp/dump-after)
  --out <file>   записать markdown в файл (без флага — stdout)
  --json         машинный вывод вместо markdown
  -h, --help     справка`;

interface Cli {
  dumpDir: string;
  outPath?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { dumpDir: join(REPO_ROOT, "tmp", "dump-after"), json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") cli.help = true;
    else if (arg === "--json") cli.json = true;
    else if (arg === "--dump" || arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} требует путь`);
      i += 1;
      if (arg === "--dump") cli.dumpDir = value;
      else cli.outPath = value;
    } else if (arg.startsWith("--dump=")) cli.dumpDir = arg.slice("--dump=".length);
    else if (arg.startsWith("--out=")) cli.outPath = arg.slice("--out=".length);
    else throw new Error(`неизвестный аргумент: ${arg}`);
  }
  return cli;
}

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
  try {
    const result = await runReport(cli.dumpDir);
    const out = cli.json
      ? JSON.stringify({ stats: result.stats, globals: result.globals }, null, 2)
      : result.markdown;
    if (cli.outPath) writeFileSync(cli.outPath, `${out}\n`, "utf8");
    else console.log(out);
    return 0;
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
