/**
 * qa_judge.test.mts — детерминированная часть судьи (без модели).
 *
 * Проверяем: разбор бинарного вердикта (включая rubric-форму и болтливый
 * ответ), равномерную выборку с фазой, фильтр кандидатов и список ключей.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  candidates,
  judgeSystem,
  parseConfirm,
  parseVerdict,
  readDoneKeys,
  sampleIndexes,
  verifySystem,
} from "./qa_judge.mts";
import { inKeys, readKeys } from "../.opencode/skills/pipeline-common/scripts/qa_keys.mts";
import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";

test("parseVerdict: бинарная форма и rubric-форма", () => {
  assert.deepEqual(parseVerdict('{"verdict":"ok","reason":"same meaning"}'), {
    score: 10,
    bad: false,
    reason: "same meaning",
    dims: { content: undefined, grammar: undefined, gender: undefined },
  });
  const bad = parseVerdict(
    'Вот:\n```json\n{"content":"bad","grammar":"ok","gender":"ok","verdict":"bad","reason":"wrong line"}\n```',
  );
  assert.equal(bad?.bad, true);
  assert.equal(bad?.score, 2);
  assert.equal(bad?.dims?.content, "bad");
});

test("parseVerdict: без вердикта — null, а не «всё хорошо»", () => {
  assert.equal(parseVerdict("нет json"), null);
  assert.equal(parseVerdict('{"reason":"нет вердикта"}'), null);
});

test("parseVerdict: rubric без verdict считается по размерностям", () => {
  assert.equal(parseVerdict('{"content":"ok","grammar":"bad"}')?.bad, true);
  assert.equal(parseVerdict('{"content":"ok","grammar":"ok"}')?.bad, false);
});

test("parseConfirm: вторая ступень снимает придирки", () => {
  assert.equal(parseConfirm('{"verdict":"confirmed","reason":"wrong line"}'), true);
  assert.equal(parseConfirm('{"verdict":"dismissed","reason":"paraphrase"}'), false);
  assert.equal(parseConfirm('{"reason":"нет вердикта"}'), null);
  assert.equal(parseConfirm("нет json"), null);
});

test("sampleIndexes: размер соблюдается, фаза сдвигает окно", () => {
  const a = sampleIndexes(300, 10, 0);
  const b = sampleIndexes(300, 10, 1);
  assert.equal(a.length, 10);
  assert.notDeepEqual(a, b, "вторая волна берёт другие строки");
  assert.equal(sampleIndexes(5, 0).length, 0);
});

test("candidates: skip, пустые и числовой мусор не судим", () => {
  const po = [
    'msgid ""',
    'msgstr ""',
    "",
    "#, skip",
    'msgid "Bark 2"',
    'msgstr "Гав 2"',
    "",
    'msgid "Hello there, friend."',
    'msgstr "Привет, друг."',
    "",
    'msgid "12345"',
    'msgstr "12345"',
    "",
  ].join("\n");
  const got = candidates(parsePo(po).filter((e) => e.msgid)).map((e) => e.msgid);
  assert.deepEqual(got, ["Hello there, friend."]);
});

test("readKeys: JSONL с контекстом и простые строки", () => {
  const keys = readKeys('{"c":"speaker:Zoey","m":"Hello"}\nПривет, мир\n');
  assert.equal(inKeys({ msgctxt: "speaker:Zoey", msgid: "Hello" }, keys), true);
  assert.equal(inKeys({ msgctxt: "ui", msgid: "Hello" }, keys), false, "контекст различается");
  assert.equal(
    inKeys({ msgctxt: "ui", msgid: "Привет, мир" }, keys),
    true,
    "простая строка — любой контекст",
  );
});

test("judgeSystem: язык — параметр, а не хардкод «Russian»", () => {
  // До 2026-11-23 промпт был жёстко русским, и на zh судья проверял бы
  // китайский текст по русским правилам.
  assert.match(judgeSystem("ru"), /its Russian TRANSLATION/);
  assert.match(judgeSystem("zh"), /its Chinese TRANSLATION/);
  assert.doesNotMatch(judgeSystem("zh"), /Russian/);
  assert.match(judgeSystem("zh"), /NO articles/, "в китайском артиклей нет");
  assert.doesNotMatch(judgeSystem("de"), /NO articles/, "в немецком артикли есть");
});

test("verifySystem: вторая ступень тоже знает язык", () => {
  assert.match(verifySystem("zh"), /against a Chinese translation/);
  assert.match(verifySystem("ru"), /against a Russian translation/);
});

test("readDoneKeys: дозапуск после падения сервера", () => {
  // Долгий прогон умирает, если GPU освобождает другой агент (2026-11-23 дважды).
  // Поэтому судья пишет построчно, а при старте пропускает уже отсуженные ключи.
  const jsonl = [
    JSON.stringify({ c: "speaker:Zoey", m: "Hello", verdict: { bad: false } }),
    JSON.stringify({ c: "ui", m: "Menu", verdict: { bad: true } }),
    "битая строка",
    "",
  ].join("\n");
  const done = readDoneKeys(jsonl);
  assert.equal(done.size, 2);
  assert.ok(done.has("speaker:Zoey\u0000Hello"));
  assert.ok(done.has("ui\u0000Menu"));
});
