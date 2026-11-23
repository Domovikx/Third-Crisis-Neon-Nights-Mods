/**
 * rt_audit.test.mts — правило «есть rich_text → должен быть rich_translation».
 *
 * Проверяем три вещи: inline-разметку отличаем от обёртки, старый алиас `# rich:`
 * считается, и «нет перевода → нет и требования rt» (пустая строка ещё не
 * потеряла оформление, её просто не переводили).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { auditLang, hasRichTranslation, isInlineRich } from "./rt_audit.mts";
import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";

const HEADER = 'msgid ""\nmsgstr ""\n\n';

test("isInlineRich: обёртка — можно собрать, теги внутри — нет", () => {
  assert.equal(isInlineRich("<i>(Hello there.)</i>"), false);
  assert.equal(isInlineRich("<color=#EB83FF>Whole line</color>"), false);
  assert.equal(isInlineRich("Hehe- That sounds- <color=#EB83FF>fun...</color>"), true);
  assert.equal(isInlineRich("<i>(Heh- <color=#EB83FF>naughty</color> boy.)</i>"), true);
  assert.equal(isInlineRich(""), false);
});

test("hasRichTranslation: новое имя и старый алиас считаются", () => {
  const [a, b, c] = parsePo(
    HEADER +
      '# rich_translation: <color=#fff>Да</color>\nmsgid "Yes"\nmsgstr "Да"\n\n' +
      '# rich: <color=#fff>Да</color>\nmsgid "Yes2"\nmsgstr "Да"\n\n' +
      '# заметка\nmsgid "Yes3"\nmsgstr "Да"\n',
  ).filter((e) => e.msgid);
  assert.equal(hasRichTranslation(a), true);
  assert.equal(hasRichTranslation(b), true);
  assert.equal(hasRichTranslation(c), false);
});

test("auditLang: считает только переведённые inline-строки", () => {
  // 1) обёртка + перевод — rt не нужен;
  // 2) inline + перевод без rt — НАРУШЕНИЕ;
  // 3) inline + перевод с rt — ок;
  // 4) inline без перевода — ещё не потеря.
  const po =
    HEADER +
    '#. rich_text: <i>Wrapped</i>\nmsgid "Wrapped"\nmsgstr "Обёрнуто"\n\n' +
    '#. rich_text: A <b>bold</b> word\nmsgid "A bold word"\nmsgstr "Жирное слово"\n\n' +
    '# rich_translation: A <b>жирное</b> слово\n#. rich_text: A <b>bold</b> word 2\nmsgid "A bold word 2"\nmsgstr "Жирное слово 2"\n\n' +
    '#. rich_text: Not <b>translated</b> yet\nmsgid "Not translated yet"\nmsgstr ""\n';
  const s = auditLang("xx", po);
  assert.equal(s.rich, 4);
  assert.equal(s.inline, 3);
  assert.equal(s.inlineTranslated, 2);
  assert.equal(s.inlineWithRt, 1);
  assert.equal(s.missing, 1, "только переведённая inline без rt — нарушение");
});
