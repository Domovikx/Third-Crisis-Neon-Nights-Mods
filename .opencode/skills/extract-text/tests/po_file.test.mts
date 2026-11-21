/**
 * Тесты PO-парсера. Паритет с `po_file.test.py`: разбор, эскейпы,
 * сохранение refs с пробелами и детерминированный round-trip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { newEntry, parsePo, poEscape, poUnescape, renderPo } from "../scripts/po_file.mts";

const HEADER = [
  'msgid ""',
  'msgstr ""',
  '"Content-Type: text/plain; charset=UTF-8\\n"',
  '"Content-Transfer-Encoding: 8bit\\n"',
];

test("parsePo: простая запись", () => {
  const [e] = parsePo('msgid "Hello"\nmsgstr "Привет"\n');
  assert.equal(e.msgid, "Hello");
  assert.equal(e.msgstr, "Привет");
  assert.equal(e.msgctxt, "");
});

test("parsePo: заголовочная запись и продолжения строк", () => {
  const [e] = parsePo(HEADER.join("\n"));
  assert.equal(e.msgid, "");
  assert.equal(
    e.msgstr,
    "Content-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n",
  );
});

test("parsePo: msgctxt", () => {
  const [e] = parsePo('msgctxt "speaker:Zoey"\nmsgid "Hi"\nmsgstr "Привет"\n');
  assert.equal(e.msgctxt, "speaker:Zoey");
});

test("parsePo: ref с пробелом внутри НЕ режется", () => {
  const [e] = parsePo('#: [spk:Cartel Guy]\nmsgid "Hi"\nmsgstr "Привет"\n');
  assert.deepEqual(e.refs, ["[spk:Cartel Guy]"]);
});

test("parsePo: флаги по запятой, комментарии и комментарии переводчика", () => {
  const [e] = parsePo(
    [
      "#: translations/dialogues.x.yaml",
      "#. rich_text: <color=#fff>Hi</color>",
      "# rich: <color=#fff>Привет</color>",
      "#, fuzzy, legacy",
      'msgid "Hi"',
      'msgstr "Привет"',
    ].join("\n"),
  );
  assert.deepEqual(e.flags, ["fuzzy", "legacy"]);
  assert.deepEqual(e.comments, ["rich_text: <color=#fff>Hi</color>"]);
  assert.deepEqual(e.translator, ["rich: <color=#fff>Привет</color>"]);
  assert.deepEqual(e.refs, ["translations/dialogues.x.yaml"]);
});

test("parsePo: несколько записей разделяются пустой строкой", () => {
  const entries = parsePo('msgid "A"\nmsgstr "a"\n\nmsgid "B"\nmsgstr "b"\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].msgid, "B");
});

test("poEscape/poUnescape: взаимно обратны", () => {
  const s = 'line1\nline2\t"quoted"\\back';
  assert.equal(poUnescape(poEscape(s)), s);
});

test("poEscape: детерминированный однострочный вид", () => {
  assert.equal(poEscape('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  assert.equal(poEscape(""), "");
});

test("renderPo: round-trip parse → render → parse", () => {
  const src = [
    ...HEADER,
    "",
    "#: [spk:Cartel Guy]",
    "#. rich_text: <color=#EB83FF>Yesss...!~</color>",
    "#, legacy",
    'msgctxt "speaker:Zoey"',
    'msgid "Yesss...!~"',
    'msgstr "Да-а-а...!~"',
    "",
  ].join("\n");

  const first = parsePo(src);
  const entries = first.slice(1); // first[0] — заголовок (msgid "")
  const rendered = renderPo(entries, []);
  const second = parsePo(rendered);

  assert.deepEqual(second, entries);
});

test("renderPo: завершается ровно одним переводом строки", () => {
  const e = newEntry();
  e.msgid = "Hi";
  e.msgstr = "Привет";
  const out = renderPo([e], []);
  assert.ok(out.endsWith("\n"));
  assert.ok(!out.endsWith("\n\n"));
});

test("parsePo: CRLF и CR не ломают разбор", () => {
  const entries = parsePo('msgid "Hi"\r\nmsgstr "Привет"\r\n\r\nmsgid "Bye"\rmsgstr "Пока"\r');
  assert.deepEqual(
    entries.map((e) => [e.msgid, e.msgstr]),
    [
      ["Hi", "Привет"],
      ["Bye", "Пока"],
    ],
  );
});

test("parsePo: пустой ввод и файл только с комментариями — пустой список", () => {
  assert.deepEqual(parsePo(""), []);
  // Запись без msgid/msgstr/refs не существует: комментарий-сирота не всплывает.
  assert.deepEqual(parsePo("#. только комментарий\n"), []);
});

test("poUnescape: неизвестный escape теряет обратный слэш (поведение po_file.py)", (t) => {
  // gettext знает \a\b\f\v\ooo; парсер их не поддерживает и отдаёт голый символ.
  // Фиксируем как есть: на наших данных таких эскейпов нет, но менять молча нельзя.
  assert.equal(poUnescape("a\\qb"), "aqb");
  t.diagnostic("если появятся \\a/\\b/\\ooo — расширять ESCAPES вместе с паритетом");
});

test("poEscape: кавычка и обратный слэш экранируются до round-trip", () => {
  const src = 'He said "hi" \\ bye';
  assert.equal(poUnescape(poEscape(src)), src);
});
