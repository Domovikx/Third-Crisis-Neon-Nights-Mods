/**
 * Тесты очереди ревью. `review_queue.py` зависел от удалённого
 * `output/stable_index.json`; здесь проверяем честную замену:
 * строки из `po/<lang>.po`, группировка по спикеру, соседи по файлу.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildQueue, groupLabel, kindOf, renderHtml, speakerOf } from "../scripts/review_queue.mts";

const REPO = resolve(import.meta.dirname, "../../../..");

const PO = `# Russian seed.
msgid ""
msgstr ""
"Language: ru\\n"

msgctxt "speaker:Zoey"
msgid "Hello there"
msgstr ""

msgctxt "speaker:Zoey"
msgid "How are you"
msgstr "Как ты"

msgctxt "speaker:Zoey"
msgid "I am fine"
msgstr ""

msgctxt "ui"
msgid "New Game"
msgstr ""

msgctxt "ui"
msgid "TalkToKlaudia - 1_Agree"
msgstr ""

#, auto-normalized
msgctxt "ui"
msgid "000 Aw ...! 2"
msgstr "Ах ...! 2"

msgctxt "ui"
msgid "<b>Bold</b> title"
msgstr ""
`;

function fixture(): string {
  const dir = mkdtempSync(join(REPO, "tmp", "rq-"));
  mkdirSync(join(dir, "po"), { recursive: true });
  writeFileSync(join(dir, "po", "ru.po"), PO, "utf8");
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("buildQueue: AUTO-секция и missing по спикерам", () => {
  const dir = fixture();
  try {
    const q = buildQueue("ru", dir, 100);
    assert.equal(q.auto.length, 1);
    assert.equal(q.auto[0].num, "A1");
    assert.equal(q.auto[0].text, "000 Aw ...! 2");
    assert.equal(q.auto[0].proposed, "Ах ...! 2");

    const labels = q.groups.map((g) => g.label);
    assert.deepEqual(labels, ["speaker: Zoey", "без спикера (ui)"], "диалоги выше ui");
    const zoey = q.groups[0].items.map((r) => r.text);
    assert.deepEqual(zoey, ["Hello there", "I am fine"], "заполненные в missing не попадают");
    assert.equal(q.missingTotal, 5);
    assert.equal(q.shown, 5);
    assert.deepEqual(
      q.groups[1].items.map((r) => r.text),
      ["New Game", "TalkToKlaudia - 1_Agree", "<b>Bold</b> title"],
    );
  } finally {
    cleanup(dir);
  }
});

test("buildQueue: соседи по файлу со своими переводами, номера M*", () => {
  const dir = fixture();
  try {
    const q = buildQueue("ru", dir, 100);
    const zoey = q.groups[0].items;
    assert.equal(zoey[0].num, "M1");
    assert.equal(zoey[0].prev, undefined, "первая строка группы");
    assert.deepEqual(zoey[0].next, { text: "How are you", translation: "Как ты" });
    assert.deepEqual(zoey[1].prev, { text: "How are you", translation: "Как ты" });
    assert.equal(zoey[1].next, undefined, "последняя строка группы");
  } finally {
    cleanup(dir);
  }
});

test("buildQueue: limit делится по группам, порядок стабилен", () => {
  const dir = fixture();
  try {
    const q = buildQueue("ru", dir, 2);
    assert.equal(q.shown, 2);
    assert.equal(q.groups.length, 2);
    assert.equal(q.groups[0].items.length, 1);
    assert.equal(q.groups[1].items.length, 1);
    assert.equal(q.missingTotal, 5, "всего missing считается до лимита");
  } finally {
    cleanup(dir);
  }
});

test("buildQueue: нет po — понятная ошибка", () => {
  const dir = mkdtempSync(join(REPO, "tmp", "rq-miss-"));
  try {
    assert.throws(() => buildQueue("ru", dir, 10), /missing .*ru\.po/);
  } finally {
    cleanup(dir);
  }
});

test("renderHtml: документ, группы, экранирование текста", () => {
  const dir = fixture();
  try {
    const html = renderHtml(buildQueue("ru", dir, 100));
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.trimEnd().endsWith("</html>"));
    assert.ok(html.includes("AUTO-normalized"));
    assert.ok(html.includes("speaker: Zoey"));
    assert.ok(html.includes("&lt;b&gt;Bold&lt;/b&gt; title"), "текст экранирован");
    assert.ok(!html.includes("<b>Bold</b>"), "сырого HTML из po нет");
    assert.ok(html.includes("stable_index"), "честно сказано про потерю сцен");
  } finally {
    cleanup(dir);
  }
});

test("хелперы: спикер, метка группы, тип строки", () => {
  assert.equal(speakerOf("speaker:Zoey"), "Zoey");
  assert.equal(speakerOf("speaker:  "), null);
  assert.equal(speakerOf("ui"), null);
  assert.equal(groupLabel("ui"), "без спикера (ui)");
  assert.equal(kindOf("TalkToKlaudia - 1_Agree", [], "ui"), "quest/fsm");
  assert.equal(kindOf("Hi", [], "speaker:Zoey"), "dialogue");
  assert.equal(kindOf("Hi", [], "ui"), "ui");
});
