/**
 * speaker_gender.test.mts — карта пола: счёт наблюдений, порог, нейтральность.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGenderMap, loadGenderMap, renderGenderConfig } from "./speaker_gender.mts";
import { newEntry, type PoEntry } from "../.opencode/skills/extract-text/scripts/po_file.mts";

function line(speaker: string, text: string): PoEntry {
  const e = newEntry();
  e.msgctxt = `speaker:${speaker}`;
  e.msgid = text;
  e.msgstr = text;
  return e;
}

test("buildGenderMap: перевес форм задаёт пол, счётчики сохраняются", () => {
  const entries = [
    line("Zoey", "Я пришла домой и увидела его."),
    line("Zoey", "Я знала, что так будет."),
    line("Zoey", "Я подумала и ушла."),
    line("Trov", "Я пришёл и увидел её."),
    line("Trov", "Я сказал правду."),
    line("Trov", "Я хотел остаться."),
  ];
  const map = buildGenderMap(entries, 3);
  assert.equal(map["Zoey"].gender, "female");
  assert.equal(map["Zoey"].fem, 3);
  assert.equal(map["Trov"].gender, "male");
  assert.equal(map["Trov"].masc, 3);
});

test("buildGenderMap: мало наблюдений — null, а не догадка", () => {
  const map = buildGenderMap([line("Customer", "Я пришёл.")]);
  assert.equal(map["Customer"].gender, null, "одного наблюдения мало");
  assert.equal(map["Customer"].masc, 1, "но счётчик виден");
});

test("buildGenderMap: смешанные формы без перевеса — null", () => {
  const entries = [
    line("Alex", "Я пришёл."),
    line("Alex", "Я пришла."),
    line("Alex", "Я сказал."),
    line("Alex", "Я сказала."),
  ];
  assert.equal(buildGenderMap(entries)["Alex"].gender, null);
});

test("buildGenderMap: строки без спикера не участвуют", () => {
  const e = newEntry();
  e.msgid = "Я пришёл.";
  e.msgstr = "Я пришёл.";
  const map = buildGenderMap([e]);
  assert.deepEqual(map, {}, "у нарратива спикера нет — пол не выводим");
});

test("loadGenderMap: нет файла — пустая карта, промпт живёт без подсказки", () => {
  const map = loadGenderMap("C:/definitely/no/such/root");
  assert.equal(map.size, 0);
});

test("renderGenderConfig: null-пол не попадает в промпт, список отсортирован", () => {
  const cfg = JSON.parse(
    renderGenderConfig({
      Trov: { gender: "male", fem: 1, masc: 9 },
      Cypher: { gender: null, fem: 1, masc: 0 },
    }),
  ) as {
    speakers: Record<string, { gender: string | null }>;
  };
  assert.deepEqual(Object.keys(cfg.speakers), ["Cypher", "Trov"]);
  assert.equal(cfg.speakers["Cypher"].gender, null);
});
