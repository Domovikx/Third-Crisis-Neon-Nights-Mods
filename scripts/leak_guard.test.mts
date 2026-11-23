/**
 * leak_guard.test.mts — утечка промпта ловится, обычные реплики про
 * инструкции — нет.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isPromptLeak, leakHits } from "./leak_guard.mts";

test("leakHits: реальная утечка промпта из корпуса", () => {
  const line =
    "Перевод каждой строки. Отвечайте ровно одной строкой в формате «N. перевод». Никогда не повторяйте тег говорящего в переводах.";
  assert.equal(isPromptLeak(line), true);
  assert.equal(leakHits(line).length >= 2, true);
});

test("leakHits: английские формы и JSON-инструкция", () => {
  assert.equal(
    isPromptLeak('Translate each line. Reply with exactly 5 lines in format "N. translation".'),
    true,
  );
  assert.equal(isPromptLeak('Answer ONLY JSON {"verdict":"ok"}'), true);
});

test("leakHits: реплики героев об инструкциях не флагаются", () => {
  assert.equal(isPromptLeak("Он прочитал инструкцию и перевёл каждую строку договора."), false);
  assert.equal(isPromptLeak("Переведи это, пожалуйста, на нормальный язык."), false);
  assert.equal(isPromptLeak("Ты никогда не повторяешь дважды, да?"), false);
});
