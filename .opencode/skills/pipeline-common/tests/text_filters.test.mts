/**
 * Тесты общих фильтров пайплайна. Паритет с `text_filters.test.py`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KNOWN_NON_SPEAKERS,
  SKIP_RAW_PREFIXES,
  autoTriage,
  isAssetName,
  isGarbageFragment,
  isSkipPrefix,
  stripRich,
} from "../scripts/text_filters.mts";

test("isAssetName: Unity-компоненты распознаются", () => {
  assert.equal(isAssetName("NNHsvRenderer"), true);
  assert.equal(isAssetName("EventSystem"), true);
  assert.equal(isAssetName("NodeLink2"), true);
  assert.equal(isAssetName("AMSController"), true);
  assert.equal(isAssetName("OptionsUI"), true);
});

test("isAssetName: обычные подписи и короткие строки — нет", () => {
  assert.equal(isAssetName("Back"), false);
  assert.equal(isAssetName("New Game"), false);
  assert.equal(isAssetName("Continue"), false);
  assert.equal(isAssetName("UI"), false, "короче 4 символов не проверяется");
  assert.equal(isAssetName(""), false);
});

test("isGarbageFragment: бинарный мусор ловится", () => {
  assert.equal(isGarbageFragment("Bff?D"), true);
  assert.equal(isGarbageFragment("S5?d"), true);
  assert.equal(isGarbageFragment("%IR"), true);
  assert.equal(isGarbageFragment("H\\?d"), true);
});

test("isGarbageFragment: легитимная пунктуация и проценты — нет", () => {
  assert.equal(isGarbageFragment("Really?"), false);
  assert.equal(isGarbageFragment("50%"), false);
  assert.equal(isGarbageFragment("100 %"), false);
  assert.equal(isGarbageFragment("?!"), false);
  assert.equal(isGarbageFragment("?!?"), false);
  assert.equal(isGarbageFragment(""), false);
});

test("autoTriage: пресет только для ассетов и мусора", () => {
  assert.deepEqual(autoTriage("NNHsvRenderer"), {
    translation: "NNHsvRenderer",
    skipTranslation: true,
  });
  assert.deepEqual(autoTriage("Bff?D"), { translation: "Bff?D", skipTranslation: true });
  assert.equal(autoTriage("Hello there, Zoey."), null);
  assert.equal(autoTriage("Back"), null);
});

test("isSkipPrefix: сырые ключи PlayMaker/пресетов", () => {
  assert.equal(isSkipPrefix("line_12"), true);
  assert.equal(isSkipPrefix("expressions/smile"), true);
  assert.equal(isSkipPrefix("Poses/idle"), true);
  assert.equal(isSkipPrefix("Zoey Dialogue Presets"), true);
  assert.equal(isSkipPrefix("Dialogue"), false);
});

test("stripRich: TMP-теги вырезаются, пробелы обрезаются", () => {
  assert.equal(stripRich("<color=#EB83FF>Yesss...!~</color>"), "Yesss...!~");
  assert.equal(stripRich("  <b>x</b>  "), "x");
  assert.equal(stripRich("plain"), "plain");
});

test("константы на месте (единый источник правды)", () => {
  assert.ok(SKIP_RAW_PREFIXES.includes("line_"));
  assert.ok(KNOWN_NON_SPEAKERS.has("Narrator"));
  assert.ok(KNOWN_NON_SPEAKERS.has("Simon"));
});
