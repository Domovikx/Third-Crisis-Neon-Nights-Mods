/**
 * speaker_gender.test.mts — карта пола: счёт наблюдений, порог, нейтральность.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGenderMap,
  loadGenderMap,
  renderGenderModule,
  SPEAKER_GENDER,
} from "./speaker_gender.mts";
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

test("loadGenderMap: читает конфиг, null-пол не попадает в промпт", () => {
  const map = loadGenderMap();
  assert.equal(map.get("Zoey"), "female");
  assert.equal(map.get("Trov"), "male");
  assert.equal(map.has("Max"), false, "пол не выведен — подсказки нет");
});

test("SPEAKER_GENDER: счётчики не противоречат решению", () => {
  const entries = Object.entries(SPEAKER_GENDER.speakers);
  assert.ok(entries.length > 0, "карта пуста — потерян снимок корпуса");
  assert.ok(SPEAKER_GENDER.min_evidence >= 1);
  for (const [name, e] of entries) {
    if (e.gender === "female") assert.ok(e.fem > e.masc, `${name}: female при fem<=masc`);
    if (e.gender === "male") assert.ok(e.masc > e.fem, `${name}: male при masc<=fem`);
  }
});

test("renderGenderModule: типизированный модуль, ключи отсортированы, null сохранён", async () => {
  const src = await renderGenderModule({
    Trov: { gender: "male", fem: 1, masc: 9 },
    Cypher: { gender: null, fem: 1, masc: 0 },
  });
  assert.match(src, /export const SPEAKER_GENDER = \{/);
  assert.match(src, /as const satisfies SpeakerGenderConfig;/);
  assert.ok(src.indexOf("Cypher:") < src.indexOf("Trov:"), "список отсортирован");
  assert.match(src, /Cypher: \{ gender: null, fem: 1, masc: 0 \},/);
  assert.match(src, /Trov: \{ gender: "male", fem: 1, masc: 9 \},/);
});
