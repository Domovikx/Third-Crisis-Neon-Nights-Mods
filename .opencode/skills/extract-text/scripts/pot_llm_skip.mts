/**
 * pot_llm_skip.mts — LLM-классификатор мусора в POT: «текст для игрока» или
 * «мусор/идентификатор».
 *
 * Зачем. Структурные правила (`shortToken`, `identifier`, `noWord`…) не
 * отличают `ACCESS` от `BUUYC`: и то и другое — короткий токен без пробела из
 * `raw:MonoBehaviour`. Человек отличает мгновенно, локальная модель — почти
 * так же, если спросить по одной строке с провенансом. Модель НЕ правит POT:
 * она предлагает вердикт, человек подтверждает, и только подтверждённый список
 * попадает в `config/pot-skip-ids.json` (его читает potgen).
 *
 * CLI:
 *   node .opencode/skills/extract-text/scripts/pot_llm_skip.mts [--pot <p>]
 *        [--url http://127.0.0.1:1234] [--model index-translate-9b]
 *        [--batch 20] [--limit N] [--dry-run]
 *
 * Выход:
 *   tmp/llm-skip.jsonl      — {msgid, src, verdict, reason, model}
 *   tmp/llm-skip-review.md  — сводка + примеры (для ревью человеком)
 *   tmp/llm-skip-ids.json   — готовый кандидат для config/pot-skip-ids.json
 */
import { appendFileSync, writeFileSync } from "node:fs";
import process from "node:process";

import { pyStrip } from "./inventory.mts";
import { parsePo } from "./po_file.mts";
import { POT_PATH, writeAtomic } from "./potgen.mts";
import { readFileSync } from "node:fs";

/** Кандидат: что показываем модели. */
export interface Candidate {
  msgid: string;
  src: string;
  ctxt: string;
}

export type Verdict = "TEXT" | "JUNK";

/** Единая точка отбора кандидатов: короткие raw-токены без пробелов. */
export function pickCandidates(potText: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const e of parsePo(potText)) {
    if (!e.msgid || e.flags.includes("skip")) continue;
    const src = e.comments.find((c) => c.startsWith("src: "))?.slice(5) ?? "";
    if (!src.startsWith("raw:")) continue;
    const text = pyStrip(e.msgid);
    if (/\s/.test(text) || [...text].length > 12) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ msgid: text, src, ctxt: e.msgctxt });
  }
  return out;
}

const SYS = `You classify short strings extracted from a Unity game build.
For each numbered input reply with exactly one line, using the item number:
"1. TEXT" or "1. JUNK", "2. TEXT" and so on.
TEXT = a human-readable word or short label a player could see in the interface
       (examples: ACCESS, ACHIEVEMENTS, Accept, Leave, Save, Yes, Committee).
JUNK = anything else: random binary artifacts ($2CUU, BVU]C, ADDDDD), hashes,
       internal identifiers, camera/shader/animator parameter names, asset names.
When a string is a real English word or a plausible UI label, answer TEXT.
Reply with exactly as many lines as inputs, nothing else. No explanation.`;

/**
 * Разбор ответа: ровно n вердиктов, иначе null (нужен ретрай).
 *
 * Модель иногда понимает «N.» буквально (проверено 2026-11-23: qwen3.5-9b
 * отвечает `N. JUNK` дословно), поэтому такие строки принимаем ПО ПОРЯДКУ.
 * Числовые номера имеют приоритет: они привязывают вердикт к строке явно.
 */
export function parseVerdicts(text: string, n: number): (Verdict | null)[] | null {
  const out: (Verdict | null)[] = Array.from({ length: n }, () => null);
  let seq = 0;
  for (const line of text.split(/\r?\n/)) {
    const numbered = /^\s*(\d+)\s*[.)]\s*(TEXT|JUNK)\b/i.exec(line);
    if (numbered) {
      const i = Number(numbered[1]) - 1;
      if (i >= 0 && i < n) out[i] = numbered[2].toUpperCase() as Verdict;
      continue;
    }
    const literal = /^\s*N\s*[.)]\s*(TEXT|JUNK)\b/i.exec(line);
    if (literal && seq < n) {
      out[seq] = literal[1].toUpperCase() as Verdict;
      seq += 1;
    }
  }
  return out.every((v) => v !== null) ? out : null;
}

/** Промпт пачки: номер, строка, провенанс (и контекст, если есть). */
export function batchPrompt(items: Candidate[]): string {
  const lines = items.map((c, i) => `${i + 1}. ${c.msgid}    [src: ${c.src}]`);
  return `Classify these ${items.length} strings.\n${lines.join("\n")}`;
}

async function classify(
  url: string,
  model: string,
  items: Candidate[],
  timeoutMs: number,
): Promise<(Verdict | null)[] | null> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `/no_think ${batchPrompt(items)}` },
      ],
      temperature: 0,
      max_tokens: 800,
      // Без этого модель уходит в размышления и возвращает пустой content
      // (грабли LM Studio, см. AGENTS.md: гасится ТОЛЬКО reasoning_effort).
      reasoning_effort: "none",
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return parseVerdicts(json.choices?.[0]?.message?.content ?? "", items.length);
}

interface Cli {
  pot: string;
  url: string;
  model: string;
  batch: number;
  limit: number;
  dryRun: boolean;
  out: string;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    pot: POT_PATH,
    url: "http://127.0.0.1:1234",
    model: "index-translate-9b",
    batch: 20,
    limit: 0,
    dryRun: false,
    out: "tmp/llm-skip",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`нет значения для ${a}`);
      return v;
    };
    if (a === "--dry-run") cli.dryRun = true;
    else if (a === "--pot") cli.pot = val();
    else if (a === "--url") cli.url = val();
    else if (a === "--model") cli.model = val();
    else if (a === "--batch") cli.batch = Number(val());
    else if (a === "--limit") cli.limit = Number(val());
    else if (a === "--out") cli.out = val();
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return cli;
}

async function main(argv: string[]): Promise<number> {
  let cli: Cli;
  try {
    cli = parseArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 2;
  }
  const candidates = pickCandidates(readFileSync(cli.pot, "utf8"));
  const todo = cli.limit ? candidates.slice(0, cli.limit) : candidates;
  console.log(
    `кандидатов: ${candidates.length}, к классификации: ${todo.length}, модель: ${cli.model}`,
  );
  if (cli.dryRun) {
    for (const c of todo.slice(0, 10)) console.log(`  ${JSON.stringify(c.msgid)}  [${c.src}]`);
    return 0;
  }

  const jsonl = `${cli.out}.jsonl`;
  writeAtomic(jsonl, "");
  const verdicts = new Map<string, { verdict: Verdict; src: string }>();
  let failed = 0;

  for (let i = 0; i < todo.length; i += cli.batch) {
    const chunk = todo.slice(i, i + cli.batch);
    let parsed: (Verdict | null)[] | null = null;
    let rest = chunk;
    for (let attempt = 1; attempt <= 3 && !parsed; attempt += 1) {
      try {
        parsed = await classify(cli.url, cli.model, rest, 120_000);
      } catch (err) {
        if (attempt === 3) console.error(`LLM: ${(err as Error).message}`);
      }
      // Не разобрали формат — дробим пачку и пробуем снова (меньше строк —
      // меньше шансов, что модель собьётся).
      if (!parsed && rest.length > 5) rest = rest.slice(0, Math.ceil(rest.length / 2));
    }
    if (!parsed) {
      failed += chunk.length;
      continue;
    }
    chunk.forEach((c, k) => {
      const v = parsed?.[k];
      if (!v) return;
      verdicts.set(c.msgid, { verdict: v, src: c.src });
      appendFileSync(
        jsonl,
        `${JSON.stringify({ msgid: c.msgid, src: c.src, verdict: v, model: cli.model })}\n`,
        "utf8",
      );
    });
    if ((i / cli.batch) % 5 === 0) {
      console.log(`  ${Math.min(i + cli.batch, todo.length)}/${todo.length}`);
    }
  }

  const junk = [...verdicts].filter(([, v]) => v.verdict === "JUNK");
  const text = [...verdicts].filter(([, v]) => v.verdict === "TEXT");
  writeAtomic(
    `${cli.out}-ids.json`,
    `${JSON.stringify({ skip: junk.map(([m]) => m).sort() }, null, 2)}\n`,
  );
  const md = [
    "# LLM-классификация коротких raw-токенов",
    "",
    `Модель: \`${cli.model}\`. Классифицировано: ${verdicts.size}, TEXT: ${text.length}, JUNK: ${junk.length}, сбоев: ${failed}.`,
    "",
    "## Предложено к skip (примеры)",
    "",
    ...junk.slice(0, 40).map(([m, v]) => `- \`${m}\` — ${v.src}`),
    "",
    "## Оставлено текстом (примеры)",
    "",
    ...text.slice(0, 40).map(([m, v]) => `- \`${m}\` — ${v.src}`),
    "",
    "Полный файл: `tmp/llm-skip.jsonl`, кандидат для политики: `tmp/llm-skip-ids.json`.",
  ].join("\n");
  writeFileSync(`${cli.out}-review.md`, `${md}\n`, "utf8");
  console.log(`готово: ${cli.out}-review.md (JUNK ${junk.length}, TEXT ${text.length})`);
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
