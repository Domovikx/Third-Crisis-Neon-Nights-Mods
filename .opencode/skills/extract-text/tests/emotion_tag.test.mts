/**
 * emotion_tag.test.mts — гарды разметчика тона: кто кандидат, выборка,
 * промпт, чистка ответа модели. Live-LLM не вызывается (fake fetch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  askLlm,
  buildPrompt,
  normalizeEmotion,
  sampleEntries,
  voicedEntries,
} from "../scripts/emotion_tag.mts";

const POT = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

#. src: dialog
msgctxt "speaker:Zoey"
msgid "A voiced line."
msgstr ""

#. src: dialog
msgctxt "speaker:Rosie"
msgid "Rosie has no original voice."
msgstr ""

#. src: raw:MonoBehaviour
#. skip: no-word
#, skip
msgctxt "ui"
msgid "SHORT"
msgstr ""

#. src: dialog
msgctxt "ui"
msgid "Ahhh..."
msgstr ""

#. src: dialog
msgctxt "ui"
msgid "(A thought in brackets.)"
msgstr ""

#. src: dialog
msgctxt "speaker-name"
msgid "Zoey"
msgstr ""

#. src: dialog
msgctxt "ui"
msgid "Plain narration."
msgstr ""

#. src: raw:MonoBehaviour
msgctxt "ui"
msgid "Not a dialogue line."
msgstr ""
`;

test("voicedEntries: каст с оригинальным голосом + нарратив, без skip/стонов/UI", () => {
  const entries = voicedEntries(POT);
  assert.deepEqual(
    entries.map((e) => e.msgid),
    ["A voiced line.", "(A thought in brackets.)", "Plain narration."],
  );
  const thought = entries.find((e) => e.msgid.startsWith("("));
  assert.equal(thought?.kind, "narration");
  assert.equal(thought?.parenthetical, true);
  assert.equal(entries[0].kind, "dialog");
  assert.equal(entries[0].speaker, "Zoey");
});

test("sampleEntries: детерминирована и берёт оба класса", () => {
  const entries = voicedEntries(POT);
  const first = sampleEntries(entries, 2);
  const second = sampleEntries(entries, 2);
  assert.deepEqual(first, second, "тот же вход = тот же сэмпл");
  assert.equal(first.length, 2);
  assert.deepEqual(
    new Set(first.map((e) => e.kind)),
    new Set(["dialog", "narration"]),
  );
});

test("buildPrompt: спикер/класс/соседи по сцене + правила тона", () => {
  const [zoey] = voicedEntries(POT);
  const prompt = buildPrompt({ ...zoey, prev: "Before.", next: "After." });
  assert.ok(prompt.includes("Speaker: Zoey | kind: dialog"), prompt);
  assert.ok(prompt.includes("Previous line: Before."), prompt);
  assert.ok(prompt.includes("Next line: After."), prompt);
  assert.ok(prompt.includes("Line (EN): A voiced line."), prompt);
  assert.ok(prompt.includes("adult (18+)"), "18+ регистр");
  assert.ok(prompt.includes("NOT a summary"), "состояние, а не пересказ");
  assert.ok(prompt.includes("NEVER reply \"none\""), "none запрещён");
  assert.ok(prompt.includes("2-6 words"), "формат инструкции");

  const narration = voicedEntries(POT)[1];
  assert.ok(
    buildPrompt(narration).includes("Narrator (Zoey's inner voice)"),
    "нарратив подписан как мысль Зои",
  );
});

test("normalizeEmotion: кавычки/точка/регистр, мусор и none отсекаются", () => {
  assert.equal(normalizeEmotion("softly, with a smirk."), "Softly, with a smirk");
  assert.equal(normalizeEmotion('"Quietly observing"'), "Quietly observing");
  assert.equal(normalizeEmotion("  none  "), null);
  assert.equal(normalizeEmotion(""), null);
  assert.equal(normalizeEmotion("Говори злобно"), null, "кириллица недопустима");
  assert.equal(normalizeEmotion("one two three four five six seven"), null, ">6 слов");
});

test("askLlm: reasoning_effort=none, ретрай на пустом ответе, чистый тон", async () => {
  const bodies: string[] = [];
  let call = 0;
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? "");
    call += 1;
    const content = call === 1 ? "" : '"warmly, with relief"';
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  }) as unknown as typeof fetch;

  const emotion = await askLlm("http://fake", "m", "prompt", { fetchImpl, delayMs: 0 });
  assert.equal(emotion, "Warmly, with relief");
  assert.equal(call, 2, "пустой ответ — повтор");
  assert.ok(bodies[0].includes('"reasoning_effort":"none"'), bodies[0]);
  assert.ok(bodies[0].includes('"temperature":0.3'), bodies[0]);
});
