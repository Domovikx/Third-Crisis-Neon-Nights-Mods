/**
 * rt_audit.test.mts — правило «есть rich_text → должен быть rich_translation».
 *
 * Проверяем три вещи: inline-разметку отличаем от обёртки, старый алиас `# rich:`
 * считается, и «нет перевода → нет и требования rt» (пустая строка ещё не
 * потеряла оформление, её просто не переводили).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

test("auditLang: теги в msgstr при чистом оригинале — отдельный счётчик", () => {
  const po = [
    'msgid ""',
    'msgstr ""',
    "",
    "#. rich_text: <color=#EB83FF>Peek</color>",
    'msgid "Peek"',
    'msgstr "<color=пerversия>Смотреть</color>"',
    "",
    "#. rich_text: <color=#EB83FF>Look</color>",
    'msgid "Look"',
    'msgstr "Смотреть"',
    "",
  ].join("\n");
  const s = auditLang("xx", po);
  assert.equal(s.tagsInMsgstr, 1, "теги в msgstr — дефект, их место в rt");
  assert.equal(s.rich, 2);
});

/**
 * Гейт на РЕАЛЬНЫХ данных: где есть `rich_text`, там обязан быть
 * `rich_translation`. Правило проекта, а не пожелание: без `rt` игрок видит
 * перевод без цвета/курсива (теги внутрь фразы через Replace не доходят).
 *
 * Тест читает настоящий `po/<lang>.po`, поэтому работает и в CI: добавили
 * строку с inline-разметкой и не заполнили `rt` — сборка красная.
 *
 * Список языков под гейтом — не «все»: у унаследованных переводов (de, pl и
 * остальные) `rt` пока нет вовсе (0 из 287 на 2026-11-23), их сначала лечат,
 * потом добавляют сюда. Новый язык = починить данные + дописать в список.
 */
const GATED_LANGS = ["ru"] as const;

for (const lang of GATED_LANGS) {
  test(`po/${lang}.po: rich_text без rich_translation — 0`, () => {
    const text = readFileSync(join(import.meta.dirname, "..", "po", `${lang}.po`), "utf8");
    const stat = auditLang(lang, text);
    assert.equal(
      stat.missing,
      0,
      `есть rich_text, но нет rich_translation: ${stat.missing} из ${stat.inline} inline-строк`,
    );
    assert.equal(stat.tagsInMsgstr, 0, "теги должны жить в rich_translation, а не в msgstr");
  });
}
