/**
 * rich_pass.test.mts — валидатор перевода разметки.
 *
 * Главный урок 2026-11-23: в данных игры 192 строки с **незакрытым** `<i>`
 * (AN обрезал хвост). Такой же незакрытый тег в переводе — правильный ответ, а
 * не ошибка: TMP трактует его как «курсив до конца строки». Поэтому структура
 * сверяется с ОРИГИНАЛОМ, а не с идеальной вложенностью.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRtWithSpans,
  inlineSpans,
  insertRtComments,
  needRt,
  openStack,
  plainOf,
  validateRt,
} from "./rich_pass.mts";
import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";

test("validateRt: обёртка и inline при совпадении текста проходят", () => {
  assert.equal(
    validateRt(
      "Hehe- That sounds- <color=#EB83FF>fun...</color>",
      "Хе-хе- Звучит- весело...",
      "Хе-хе- Звучит- <color=#EB83FF>весело...</color>",
    ),
    null,
  );
});

test("validateRt: незакрытый тег как в оригинале — это норма (данные игры)", () => {
  assert.deepEqual(openStack("<i>> Hahh! No, Ma'am! Never!"), ["i"]);
  assert.equal(
    validateRt("<i>> Hahh! No, Ma'am! Never!", "> Ахх! Нет, госпожа!", "<i>> Ахх! Нет, госпожа!"),
    null,
  );
  // Закрыли там, где в оригинале не закрыто — набор тегов разойдётся.
  assert.equal(validateRt("<i>> Hahh!", "> Ахх!", "<i>> Ахх!</i>"), "tags differ");
});

test("validateRt: перекрещенные теги, чужой параметр и потерянный текст ловятся", () => {
  assert.equal(validateRt("<i>a <b>b</b></i>", "а б", "<i>а <b>б</i></b>"), "nesting differs");
  assert.equal(validateRt("<color=#fff>a</color>", "а", "<color=#000>а</color>"), "tags differ");
  assert.equal(
    validateRt("A <b>bold</b> word", "Жирное слово", "Жирное <b>слово</b>"),
    null,
    "разные слова — валидно, лишь бы теги и чистый текст совпали",
  );
  assert.equal(validateRt("A <b>bold</b> word", "Жирное слово", "<b>Другое</b>"), "plain differs");
});

test("needRt: только переведённые inline без rt", () => {
  const richMap = new Map([
    ["Wrapped", "<i>Wrapped</i>"],
    ["A bold word", "A <b>bold</b> word"],
    ["A bold word 2", "A <b>bold</b> word 2"],
  ]);
  const po = `msgid ""
msgstr ""

#. rich_text: <i>Wrapped</i>
msgid "Wrapped"
msgstr "Обёрнуто"

#. rich_text: A <b>bold</b> word
msgid "A bold word"
msgstr "Жирное слово"

# rich_translation: Жирное <b>слово</b> 2
#. rich_text: A <b>bold</b> word 2
msgid "A bold word 2"
msgstr "Жирное слово 2"

msgid "No rich here"
msgstr "Без разметки"
`;
  const todo = needRt(
    parsePo(po).filter((e) => e.msgid),
    richMap,
  );
  assert.deepEqual(
    todo.map((e) => e.msgid),
    ["A bold word"],
  );
});

test("insertRtComments: комментарий встаёт перед msgctxt, один раз на запись", () => {
  const text = `msgid ""
msgstr ""

#. src: dialog
msgctxt "ui"
msgid "A bold word"
msgstr "Жирное слово"

msgid "Other"
msgstr "Другое"
`;
  const out = insertRtComments(text, new Map([["A bold word", "Жирное <b>слово</b>"]]));
  // Комментарий ставится в НАЧАЛО блока записи: в PO он валиден в любом месте
  // до msgid, а блок-подход не зависит от порядка `#.`/`msgctxt`.
  assert.match(
    out,
    /# rich_translation: Жирное <b>слово<\/b>\n#\. src: dialog\nmsgctxt "ui"\nmsgid "A bold word"/,
  );
  assert.equal((out.match(/rich_translation/g) ?? []).length, 1);
  assert.equal(plainOf("<i>> Hahh!"), "> Hahh!");
});

test("inlineSpans: находит пару тег+текст+закрытие", () => {
  assert.deepEqual(inlineSpans("Hehe- That sounds- <color=#EB83FF>fun...</color>"), [
    { open: "<color=#EB83FF>", inner: "fun...", close: "</color>" },
  ]);
  assert.deepEqual(inlineSpans("<i>(<color=#fff>word</color> tail)</i>"), [
    { open: "<color=#fff>", inner: "word", close: "</color>" },
  ]);
  // Обёртку `inlineSpans` тоже находит — но такие строки отсекает `needRt`
  // (им `rt` не нужен, сборка и так работает).
  assert.equal(inlineSpans("<i>whole line</i>").length, 1);
});

test("buildRtWithSpans: теги ставятся детерминированно, текст не меняется", () => {
  const msgstr = "Хе-хе- Звучит- весело...";
  const spans = inlineSpans("Hehe- That sounds- <color=#EB83FF>fun...</color>");
  const rt = buildRtWithSpans(msgstr, spans, ["весело..."]);
  assert.equal(rt, "Хе-хе- Звучит- <color=#EB83FF>весело...</color>");
  assert.equal(plainOf(rt ?? ""), msgstr, "чистый текст обязан совпасть");
  assert.equal(
    validateRt("Hehe- That sounds- <color=#EB83FF>fun...</color>", msgstr, rt ?? ""),
    null,
  );

  assert.equal(buildRtWithSpans(msgstr, spans, ["нет такого"]), null, "нет фрагмента — отказ");
  assert.equal(buildRtWithSpans(msgstr, spans, []), null, "число фрагментов не совпало");
});

test("buildRtWithSpans: две подсветки подряд не накладываются", () => {
  const msgstr = "Ах! Бля, это отлично!";
  const spans = inlineSpans("<color=#fff>Ah</color> fuck, it's <b>great</b>!");
  assert.equal(spans.length, 2);
  const rt = buildRtWithSpans(msgstr, spans, ["Ах!", "отлично"]);
  assert.ok(rt);
  assert.equal(plainOf(rt as string), msgstr);
  assert.match(rt as string, /^<color=#fff>Ах!<\/color> Бля, это <b>отлично<\/b>!$/);
});
