/**
 * pot_skip_review.mts — отчёт для человека: по каждому правилу skip-политики
 * сколько записей и 20 примеров (`tmp/pot-skip-review.md`).
 *
 * Считает то же, что запишет `potgen`: правило берётся из
 * `config/pot-skip-policy.json`, условия — из `pot_skip.mts` (одна
 * реализация). POT читается как есть (`#. src:` и `#. rich_text:`), поэтому
 * отчёт работает и на файле, сгенерированном ДО появления skip-меток.
 *
 * `--dump` добавляет провенанс примеров (файл дампа + path_id): владелец
 * может открыть объект и глазами проверить, что это действительно мусор.
 *
 * CLI: node .opencode/skills/extract-text/scripts/pot_skip_review.mts
 *        [--pot <path>] [--policy <path>] [--dump <dir>] [--out <md>]
 *        [--examples 20]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { readJsonl } from "./inventory.mts";
import {
  classifyRich,
  FRAGMENT_MIN_CHARS,
  FRAGMENT_MIN_WORDS,
  isMeaningfulText,
  skipConditionMatches,
} from "./pot_skip.mts";
import { parsePo } from "./po_file.mts";
import {
  discoverSkipPolicyPath,
  loadSkipPolicy,
  POT_PATH,
  SKIP_POLICY_PATH,
  srcMatchesPattern,
  writeAtomic,
  type SkipPolicy,
  type SkipRule,
} from "./potgen.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

interface Row {
  msgid: string;
  msgctxt: string;
  src: string;
  rich: string;
}

/** Прочитать POT как строки отчёта (без интерпретаций). */
export function readRows(potText: string): Row[] {
  return parsePo(potText)
    .filter((e) => e.msgid)
    .map((e) => ({
      msgid: e.msgid,
      msgctxt: e.msgctxt,
      src: e.comments.find((c) => c.startsWith("src: "))?.slice("src: ".length) ?? "",
      rich: e.comments.find((c) => c.startsWith("rich_text: "))?.slice("rich_text: ".length) ?? "",
    }));
}

/** Первое подходящее правило политики (порядок — данные). */
export function matchRule(policy: SkipPolicy, row: Row): SkipRule | null {
  for (const rule of policy.rules) {
    if (!rule.enabled) continue;
    if (
      srcMatchesPattern(rule.src, row.src) &&
      !rule.srcExclude.some((pattern) => srcMatchesPattern(pattern, row.src)) &&
      skipConditionMatches(rule.when, { msgid: row.msgid, rich: row.rich })
    ) {
      return rule;
    }
  }
  return null;
}

/** Сводка: сколько записей даёт каждое правило + примеры. */
export function review(
  rows: Row[],
  policy: SkipPolicy,
): { byRule: Array<{ rule: SkipRule; rows: Row[] }>; fragment: Row[] } {
  const byRule = new Map<string, Row[]>(policy.rules.map((r) => [r.id, []]));
  for (const row of rows) {
    const rule = matchRule(policy, row);
    if (rule) byRule.get(rule.id)?.push(row);
  }
  const fragment = rows.filter(
    (row) => row.rich && classifyRich(row.msgid, row.rich).relation !== "ok",
  );
  return {
    byRule: policy.rules.map((rule) => ({ rule, rows: byRule.get(rule.id) ?? [] })),
    fragment,
  };
}

/**
 * Записи, которые правило ПРОПУСТИЛО бы, но политика их не трогает
 * (`srcExclude` или отсутствие правила). Это список на ревью человеку:
 * `short-token` намеренно исключает `raw:MonoBehaviour`, поэтому его короткие
 * токены остаются переводимыми, пока их не подтвердят построчно.
 */
export function deferredReview(rows: Row[], policy: SkipPolicy): Row[] {
  // Список = записи, которые правило пометило бы, если бы не `srcExclude`.
  // Провенанс правила учитывается: `dialog`/`field:`/`settings` в него не
  // попадают, потому что `short-token` объявлен для `raw:*`. Исключение
  // (`srcExclude`) намеренно игнорируется — именно оно и создаёт список.
  const out: Row[] = [];
  for (const row of rows) {
    if (matchRule(policy, row)) continue;
    const wouldMatch = policy.rules.some(
      (rule) =>
        rule.enabled &&
        rule.when === "shortToken" &&
        srcMatchesPattern(rule.src, row.src) &&
        skipConditionMatches(rule.when, { msgid: row.msgid, rich: row.rich }),
    );
    if (wouldMatch) out.push(row);
  }
  return out;
}

/** Текст списка на ревью: метка и ключ по строке, порядок POT. */
export function renderDeferredReview(rows: Row[]): string {
  return rows.map((row) => `${row.src}\t${row.msgid}`).join("\n") + (rows.length ? "\n" : "");
}

/** Ключ провенанса: ключ + полный текст без тегов (разные «>» не сливаются). */
function originKey(msgid: string, rich: string): string {
  return `${msgid}\u0000${classifyRich(msgid, rich).plain}`;
}

/** `msgid+plain` → где живёт в дампе (файл, path_id, index) — для примеров. */
export async function dumpOrigins(dumpDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const files = readdirSync(dumpDir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort();
  for (const name of files) {
    for await (const { obj } of readJsonl(join(dumpDir, name))) {
      const dialogues = obj.dialogues;
      if (!Array.isArray(dialogues)) continue;
      const pid = String(obj.path_id ?? "?");
      dialogues.forEach((raw, idx) => {
        const d = raw as Record<string, unknown>;
        if (typeof d.text !== "string" || !d.text.trim()) return;
        const text = d.text.trim();
        const rich = typeof d.rich_text === "string" ? d.rich_text.trim() : "";
        const key = originKey(text, rich);
        if (!out.has(key)) out.set(key, `${name} path_id=${pid} idx=${idx}`);
      });
    }
  }
  return out;
}

/** Срез по code points (как Python `s[:n]`). */
function cut(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : `${chars.slice(0, n).join("")}…`;
}

function mdCell(s: string): string {
  return `\`${cut(s.replace(/`/g, "'").replace(/\|/g, "\\|"), 90)}\``;
}

export interface ReviewOptions {
  potText: string;
  policy: SkipPolicy;
  origins?: Map<string, string>;
  examples?: number;
  label?: string;
}

/** Markdown-отчёт для владельца. */
export function renderReview(opts: ReviewOptions): string {
  const rows = readRows(opts.potText);
  const { byRule, fragment } = review(rows, opts.policy);
  const limit = opts.examples ?? 20;
  const lines: string[] = [
    "# POT: теги «перевод не нужен» — что помечено и что решать",
    "",
    `Источник: ${opts.label ?? "POT"}; политика: ${opts.policy.path}.`,
    "Записи не удалены: в POT стоят `#, skip` + `#. skip: <id>`; в `po/*.po` они не идут,",
    "в модель не отправляются. Выключить правило — правка JSON (`enabled: false` или удалить).",
    "",
    "## Сколько записей даёт каждое правило",
    "",
    "| правило | src | условие | записей | доля POT |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const { rule, rows: hits } of byRule) {
    const share = rows.length ? ((100 * hits.length) / rows.length).toFixed(1) : "0.0";
    lines.push(
      `| \`${rule.id}\` | \`${rule.src}\` | \`${rule.when}\` | ${hits.length} | ${share} % |`,
    );
  }
  const total = byRule.reduce((n, r) => n + r.rows.length, 0);
  lines.push(`| **итого** | | | **${total}** | из ${rows.length} записей |`, "");

  for (const { rule, rows: hits } of byRule) {
    lines.push(`## Правило \`${rule.id}\` — ${hits.length}`, "");
    lines.push(
      `Условие \`${rule.when}\`, метка \`${rule.src}\`. Примеры (${Math.min(limit, hits.length)}):`,
      "",
    );
    if (hits.length === 0) lines.push("- (совпадений нет)", "");
    for (const row of hits.slice(0, limit)) {
      const where = opts.origins?.get(originKey(row.msgid, row.rich));
      lines.push(
        `- ${mdCell(row.msgid)} — \`src: ${row.src}\`${where ? `; ${where}` : ""}` +
          `${row.msgctxt !== "ui" ? `; ctx \`${row.msgctxt}\`` : ""}`,
      );
    }
    if (rule.when === "shortToken") {
      const words = hits.filter((row) => /^\p{L}+$/u.test(row.msgid));
      lines.push(
        "",
        `Из них чисто буквенных токенов: **${words.length}** — здесь и лежит риск ` +
          "(настоящие подписи без пробела вроде `ACCESS`, `ACHIEVEMENTS`, `ALWAYS`):",
        ...words.slice(0, 10).map((row) => `- ${mdCell(row.msgid)} — \`src: ${row.src}\``),
      );
    }
    lines.push("");
  }

  lines.push("## Обрывки `rich_text` (инвариант 7, `rich-fragment`)", "");
  const relationOf = (row: Row): string => classifyRich(row.msgid, row.rich).relation;
  const byRel = new Map<string, Row[]>();
  for (const row of fragment) {
    const rel = relationOf(row);
    byRel.set(rel, [...(byRel.get(rel) ?? []), row]);
  }
  lines.push(
    `Порог «осмысленности»: ≥${FRAGMENT_MIN_CHARS} символов и ≥${FRAGMENT_MIN_WORDS} слов.`,
    "",
  );
  for (const rel of ["suffix", "mismatch", "noise"]) {
    const list = byRel.get(rel) ?? [];
    lines.push(`- \`${rel}\` — ${list.length}`);
  }
  lines.push("");
  for (const rel of ["suffix", "mismatch", "noise"]) {
    const list = byRel.get(rel) ?? [];
    if (!list.length) continue;
    lines.push(`### \`${rel}\` (${list.length})`, "");
    for (const row of list.slice(0, limit)) {
      const check = classifyRich(row.msgid, row.rich);
      const where = opts.origins?.get(originKey(row.msgid, row.rich));
      lines.push(
        `- ключ ${mdCell(row.msgid)}${where ? ` — ${where}` : ""}`,
        `  - полный текст: ${mdCell(cut(check.plain, 200))}`,
        `  - ${isMeaningfulText(row.msgid) ? "осмысленный обрывок" : "ниже порога (не диагноз)"}`,
      );
    }
    lines.push("");
  }

  const deferred = deferredReview(rows, opts.policy);
  if (deferred.length) {
    const bySrc = new Map<string, Row[]>();
    for (const row of deferred) bySrc.set(row.src, [...(bySrc.get(row.src) ?? []), row]);
    lines.push(
      `## Отложено на ревью — ${deferred.length} (правило пропустило, политика не трогает)`,
      "",
      "Это записи, которые `short-token` пометил бы, но `srcExclude` их защищает.",
      "Полный список (метка + ключ) — `tmp/review-skip-deferred.txt`; порядок — как в POT.",
      "",
      "| src | записей |",
      "| --- | --- |",
      ...[...bySrc]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([src, list]) => `| \`${src}\` | ${list.length} |`),
      "",
      `Примеры (${Math.min(limit, deferred.length)}):`,
      "",
      ...deferred.slice(0, limit).map((row) => `- ${mdCell(row.msgid)} — \`src: ${row.src}\``),
      "",
    );
  }

  lines.push(
    "## Что осталось решить владельцу",
    "",
    "- `short-token` сужен решением владельца 2026-11-23: `raw:MonoBehaviour` исключён",
    "  (`srcExclude`), потому что там лежат настоящие подписи (`ACCESS`, `ACHIEVEMENTS`).",
    "  Остаток — раздел «Отложено на ревью»: его надо вычитать и решить, что мусор.",
    "- `fragment` помечает только `suffix` (ключ = хвост полного текста). `mismatch` —",
    "  отдельный класс (расхождение на символы), он в POT остаётся и переводится.",
    "- Примеры владельца `w? |b` и `wK Ax` закрыты правилом `no-word` (нет ни одного",
    "  токена из ≥3 букв); настоящие подписи оно не трогает — у них есть слово.",
    "- `suffix` найдено два, а не один: `your comfort, hon. …` тоже хвост — из текста",
    "  пропало начало «It's all about». Оба живут в одном объекте `sharedassets7.jsonl`,",
    "  `path_id=1205` (idx 1 и 3).",
    "",
  );
  return lines.join("\n");
}

const USAGE = `Usage: node pot_skip_review.mts [--pot <path>] [--policy <path>] [--dump <dir>]
       [--out <md>] [--examples 20]

  --pot <path>    POT (по умолчанию po/template.pot)
  --policy <path> skip-политика (по умолчанию config/pot-skip-policy.json)
  --dump <dir>    дамп для провенанса примеров (файл + path_id)
  --out <md>      куда писать (по умолчанию tmp/pot-skip-review.md)
  --examples <n>  примеров на правило (по умолчанию 20)`;

interface Cli {
  pot: string;
  policy: string;
  dump?: string;
  out: string;
  examples: number;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    pot: POT_PATH,
    policy: SKIP_POLICY_PATH,
    out: join(REPO_ROOT, "tmp", "pot-skip-review.md"),
    examples: 20,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") cli.help = true;
    else if (["--pot", "--policy", "--dump", "--out", "--examples"].includes(arg)) {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} требует значение`);
      i += 1;
      if (arg === "--pot") cli.pot = value;
      else if (arg === "--policy") cli.policy = value;
      else if (arg === "--dump") cli.dump = value;
      else if (arg === "--out") cli.out = value;
      else cli.examples = Number(value);
    } else if (arg.startsWith("--pot=")) cli.pot = arg.slice("--pot=".length);
    else if (arg.startsWith("--policy=")) cli.policy = arg.slice("--policy=".length);
    else if (arg.startsWith("--dump=")) cli.dump = arg.slice("--dump=".length);
    else if (arg.startsWith("--out=")) cli.out = arg.slice("--out=".length);
    else if (arg.startsWith("--examples=")) cli.examples = Number(arg.slice("--examples=".length));
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
    const policyPath = cli.policy || discoverSkipPolicyPath();
    if (!policyPath || !existsSync(policyPath)) throw new Error(`нет skip-политики: ${cli.policy}`);
    const policy = loadSkipPolicy(policyPath, { required: true }) as SkipPolicy;
    if (!existsSync(cli.pot)) throw new Error(`нет POT: ${cli.pot}`);
    const origins = cli.dump ? await dumpOrigins(cli.dump) : undefined;
    const text = renderReview({
      potText: readFileSync(cli.pot, "utf8"),
      policy,
      origins,
      examples: cli.examples,
      label: cli.pot,
    });
    writeAtomic(cli.out, text);
    const rows = readRows(readFileSync(cli.pot, "utf8"));
    const { byRule } = review(rows, policy);
    const deferred = deferredReview(rows, policy);
    const deferredPath = join(dirname(cli.out), "review-skip-deferred.txt");
    writeAtomic(deferredPath, renderDeferredReview(deferred));
    console.log(`отчёт: ${cli.out}`);
    for (const { rule, rows: hits } of byRule) console.log(`  ${rule.id}: ${hits.length}`);
    console.log(`  отложено на ревью: ${deferred.length} -> ${deferredPath}`);
    return 0;
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
