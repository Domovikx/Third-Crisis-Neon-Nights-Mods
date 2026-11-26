/**
 * emotion_tag.test.mts — гарды разметчика тона: кто кандидат, выборка,
 * промпт, чистка ответа модели. Live-LLM не вызывается (fake fetch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  askLlm,
  buildPrompt,
  choiceMsgids,
  normalizeEmotion,
  sampleEntries,
  tagAll,
  toneFamily,
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
  assert.deepEqual(new Set(first.map((e) => e.kind)), new Set(["dialog", "narration"]));
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
  assert.ok(prompt.includes('NEVER reply "none"'), "none запрещён");
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

test("choiceMsgids: техническая строка List<DialogueLineLogic> выдаёт группу выборов", () => {
  const dir = mkdtempSync(join(tmpdir(), "emo-choices-"));
  const typeLine =
    "System.Collections.Generic.List`1[[Asuna.Dialogues.DialogueLineLogic, Assembly-CSharp]]";
  const objects = [
    {
      dialogues: [
        { speaker: "SaveKey", text: typeLine },
        { speaker: "", text: "Ask about Arm" },
        { speaker: "", text: "Work as waitress" },
      ],
    },
    {
      dialogues: [
        { speaker: "Klaudia", text: "My arm? I cut it off." },
        { speaker: "", text: "Not a choice." },
      ],
    },
  ];
  writeFileSync(join(dir, "level.jsonl"), objects.map((o) => JSON.stringify(o)).join("\n") + "\n");
  writeFileSync(join(dir, "summaries.jsonl"), JSON.stringify({ dialogues: [] }) + "\n");

  const choices = choiceMsgids(dir);
  assert.deepEqual([...choices].sort(), ["Ask about Arm", "Work as waitress"]);
});

test("toneFamily и buildPrompt: семья «Playful/teasing» распознаётся, повтор запрещается", () => {
  assert.equal(toneFamily("Playful and teasing"), "playful/teasing");
  assert.equal(toneFamily("Cheerfully teasing"), "playful/teasing");
  assert.equal(toneFamily("Quietly observing"), null);

  const [zoey] = voicedEntries(POT);
  assert.ok(!buildPrompt(zoey).includes("Avoid the"));
  assert.ok(
    buildPrompt(zoey, { avoidFamily: "playful/teasing" }).includes(
      "Avoid the playful/teasing register",
    ),
  );
});

test("tagAll: семья переполнилась — один повтор с запретом, затем берётся другой тон", async () => {
  const lines = ["One.", "Two.", "Three.", "Four."];
  const pot = lines
    .map((text) => `#. src: dialog\nmsgctxt "speaker:Zoey"\nmsgid "${text}"\nmsgstr ""\n`)
    .join("\n");
  const candidates = voicedEntries(`${pot}\n`);

  const bodies: string[] = [];
  let call = 0;
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? "");
    call += 1;
    // Первые 3 строки — «playful», на 4-й модели велено уйти из семьи.
    const content = call <= 4 ? "Playful and teasing" : "Warmly curious";
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  }) as unknown as typeof fetch;

  const result = await tagAll(candidates, {
    baseUrl: "http://fake",
    model: "m",
    fetchImpl,
  });

  assert.equal(result.retries, 1, "повтор из-за семьи — один");
  assert.equal(result.fallbacks, 0);
  assert.equal(Object.keys(result.emotions).length, 4);
  assert.equal(result.emotions["Four."], "Warmly curious");
  assert.equal(bodies.length, 5, "4 строки + один повтор");
  assert.ok(bodies[4].includes("Avoid the playful/teasing register"), bodies[4]);
});
