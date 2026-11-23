/**
 * pot_llm_skip.test.mts — тесты LLM-классификатора мусора в POT.
 *
 * Два уровня:
 *   1. Юнит: отбор кандидатов и разбор ответа (без сети, детерминированно).
 *   2. E2E: настоящая модель + эталонный набор с человеческой этикеткой
 *      (`scripts/fixtures/llm-skip-golden.json`). Требуем точность ≥90% и
 *      полный формат (ни одного пропуска). Без живого сервера тест
 *      пропускается: `npm run test:e2e:llm` при поднятой модели.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  batchPrompt,
  parseVerdicts,
  pickCandidates,
  type Candidate,
} from "../scripts/pot_llm_skip.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
const GOLDEN = join(REPO, "scripts", "fixtures", "llm-skip-golden.json");

const POT = `msgid ""
msgstr ""

#. src: raw:MonoBehaviour
msgctxt "ui"
msgid "BUUYC"
msgstr ""

#. src: raw:MonoBehaviour
msgctxt "ui"
msgid "ACCESS"
msgstr ""

#. src: dialog
msgctxt "speaker:Zoey"
msgid "BUUYC"
msgstr ""

#. src: raw:MonoBehaviour
#. skip: short-token
#, skip
msgctxt "ui"
msgid "BVU"
msgstr ""

#. src: raw:MonoBehaviour
msgctxt "ui"
msgid "Two words here"
msgstr ""
`;

test("pickCandidates: только короткие raw-токены, без skip и дублей", () => {
  const got = pickCandidates(POT).map((c) => [c.msgid, c.src]);
  assert.deepEqual(got, [
    ["BUUYC", "raw:MonoBehaviour"],
    ["ACCESS", "raw:MonoBehaviour"],
  ]);
});

test("parseVerdicts: числовая нумерация, буквальное «N.» и порядок", () => {
  assert.deepEqual(parseVerdicts("1. JUNK\n2. TEXT", 2), ["JUNK", "TEXT"]);
  assert.deepEqual(parseVerdicts("N. JUNK\nN. TEXT\nN. TEXT", 3), ["JUNK", "TEXT", "TEXT"]);
  assert.equal(parseVerdicts("1. JUNK", 2), null, "неполный ответ — ретрай");
  assert.equal(parseVerdicts("no idea", 2), null, "мусор вместо формата — ретрай");
});

test("batchPrompt: номер, строка и провенанс", () => {
  const items: Candidate[] = [{ msgid: "BUUYC", src: "raw:MonoBehaviour", ctxt: "ui" }];
  const prompt = batchPrompt(items);
  assert.match(prompt, /^Classify these 1 strings\./);
  assert.match(prompt, /1\. BUUYC {4}\[src: raw:MonoBehaviour\]/);
});

interface Golden {
  cases: { text: string; verdict: "TEXT" | "JUNK" }[];
}

/** Доступен ли LM Studio (иначе E2E пропускается). */
async function llmReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

test("E2E: классификатор на эталонном наборе (порог точности 90%)", async (t) => {
  const url = process.env.TSSR_LLM_URL ?? "http://127.0.0.1:1234";
  const model = process.env.TSSR_SKIP_MODEL ?? "qwen/qwen3.5-9b";
  if (!(await llmReady(url))) {
    t.skip("нет LM Studio на " + url + " (подними модель и повтори)");
    return;
  }
  const { cases } = JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;
  const items: Candidate[] = cases.map((c) => ({
    msgid: c.text,
    src: "raw:MonoBehaviour",
    ctxt: "ui",
  }));

  const res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: `You classify short strings from a Unity game build.
For each numbered input reply with exactly one line, using the item number:
"1. TEXT" or "1. JUNK". TEXT = a human-readable word or short label a player could see.
JUNK = random binary artifact, hash, internal identifier, parameter name.
Reply with exactly as many lines as inputs, nothing else.`,
        },
        {
          role: "user",
          content: `Classify these ${items.length} strings.\n${items
            .map((c, i) => `${i + 1}. ${c.msgid}    [src: ${c.src}]`)
            .join("\n")}`,
        },
      ],
      temperature: 0,
      max_tokens: 1200,
      reasoning_effort: "none",
    }),
    signal: AbortSignal.timeout(180_000),
  });
  assert.ok(res.ok, `HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const parsed = parseVerdicts(json.choices?.[0]?.message?.content ?? "", items.length);
  assert.ok(parsed, "модель обязана ответить в формате N. VERDICT");

  let correct = 0;
  const wrong: string[] = [];
  cases.forEach((c, i) => {
    if (parsed[i] === c.verdict) correct += 1;
    else wrong.push(`${JSON.stringify(c.text)}: ждали ${c.verdict}, получили ${parsed[i]}`);
  });
  const accuracy = correct / cases.length;
  t.diagnostic(`точность ${(accuracy * 100).toFixed(1)}% (${correct}/${cases.length})`);
  assert.ok(
    accuracy >= 0.9,
    `точность ${(accuracy * 100).toFixed(1)}% ниже 90%. Ошибки:\n${wrong.slice(0, 10).join("\n")}`,
  );
});
