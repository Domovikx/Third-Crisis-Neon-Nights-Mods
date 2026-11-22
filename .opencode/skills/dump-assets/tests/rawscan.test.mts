/**
 * rawscan.test.mts — границы raw-сканеров (паритет с Python-эталоном).
 *
 * Фикстуры — синтетические байты: строки игры в тесты не кладём.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  extractJsonString,
  isGlobalStringCandidate,
  parseColorParserList,
  parseDialogueFromRaw,
  parsePlaymakerDialogues,
  scanGlobalStrings,
  scanRawStrings,
  scanSettingsKeys,
  uiPriority,
} from "../scripts/rawscan.mts";

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

test("scanRawStrings: пустой буфер и слишком короткие строки", () => {
  assert.deepEqual(scanRawStrings(new Uint8Array(0)), []);
  // 2 символа — меньше MIN_RAW_LEN
  assert.deepEqual(
    scanRawStrings(ascii("ab")).map((r) => r.text),
    [],
  );
  // 3 символа, но одна буква — letters < 2
  assert.deepEqual(
    scanRawStrings(ascii("a12")).map((r) => r.text),
    [],
  );
  assert.deepEqual(
    scanRawStrings(ascii("abcd")).map((r) => r.text),
    ["abcd"],
  );
});

test("scanRawStrings: пробелы по краям срезаются, но прогон начинается раньше", () => {
  // Пробел входит в диапазон 32..126; эталон делает .strip() и начинает
  // отсчёт offset с начала прогона (до strip).
  const raw = new Uint8Array([0x01, 0x20, ...ascii("Hello World"), 0x20, 0x00]);
  const [first] = scanRawStrings(raw, 100);
  assert.equal(first.text, "Hello World");
  assert.equal(first.offset, 101);
  assert.equal(first.letters, 10);
  assert.equal(first.flags, "null_term");
});

test("scanRawStrings: разные места — разные записи, letters считается по ASCII", () => {
  const raw = ascii("City\u0000City");
  const found = scanRawStrings(raw);
  assert.deepEqual(
    found.map((r) => r.text),
    ["City", "City"],
  );
  assert.deepEqual(
    found.map((r) => r.offset),
    [0, 5],
  );
});

test("extractJsonString: экранирование как в эталоне (\\n → буква n)", () => {
  const raw = ascii('a\\nb\\"c\\u0041"tail');
  const [value, next] = extractJsonString(raw, 0);
  // ВНИМАНИЕ: `\n` даёт байт 0x6E — это причуда Python-эталона, не баг порта.
  assert.equal(value, 'anb"cA');
  assert.equal(next, 14);
});

test("extractJsonString: незакрытая строка — null", () => {
  const [value] = extractJsonString(ascii("no quote"), 0);
  assert.equal(value, null);
});

test("parseDialogueFromRaw: пары speaker/text, rich снимается в text", () => {
  const raw = ascii(
    'x{"Speaker":"Zoey","Text":"Hello <color=red>there</color>!"}' +
      '{"Speaker":"Zoey","Text":"Hello <color=red>there</color>!"}' +
      '{"Speaker":"Maxx","Text":"Second"}',
  );
  const found = parseDialogueFromRaw(raw, 10);
  assert.equal(found.length, 2, "дубль (speaker, clean text) отбрасывается");
  assert.deepEqual(
    found.map((d) => [d.speaker, d.text]),
    [
      ["Zoey", "Hello there!"],
      ["Maxx", "Second"],
    ],
  );
  assert.equal(found[0].rich_text, "Hello <color=red>there</color>!");
  assert.equal(found[0].offset, 12);
});

test("parseDialogueFromRaw: пустой текст не попадает", () => {
  const raw = ascii('{"Speaker":"Zoey","Text":""}');
  assert.deepEqual(parseDialogueFromRaw(raw), []);
});

test("parsePlaymakerDialogues: line_X + текст + спикер", () => {
  const found = parsePlaymakerDialogues([
    "line_01",
    "line_01",
    "Hello there!",
    "Zoey",
    "art/prefab",
    "Second line here",
  ]);
  assert.deepEqual(found, [{ speaker: "Zoey", text: "Hello there!", rich_text: "" }]);
});

test("parsePlaymakerDialogues: skip-префиксы, короткие строки, скобки", () => {
  const found = parsePlaymakerDialogues([
    "line_02",
    "expressions/angry",
    "ab",
    "nospace",
    "{json}",
    "[marker]",
    "Real line of text",
    "lowercase speaker",
  ]);
  assert.deepEqual(found, [{ speaker: "", text: "Real line of text", rich_text: "" }]);
});

test("parsePlaymakerDialogues: rich-разметка сохраняется в rich_text", () => {
  const found = parsePlaymakerDialogues(["line_03", "<b>Bold</b> words here"]);
  assert.equal(found.length, 1);
  assert.equal(found[0].text, "Bold words here");
  assert.equal(found[0].rich_text, "<b>Bold</b> words here");
});

test("scanSettingsKeys: ключ + UTF-8 подпись", () => {
  const key = "Settings.VideoTab";
  const display = "Video Tab";
  const buf: number[] = [];
  const push = (n: number): void => {
    buf.push(n & 0xff);
  };
  const pushU32 = (n: number): void => {
    for (let i = 0; i < 4; i++) push(n >> (i * 8));
  };
  pushU32(key.length);
  for (const b of ascii(key)) push(b);
  pushU32(display.length);
  for (const b of ascii(display)) push(b);
  // Шум вокруг: сканер ищет байты "Settings." где угодно.
  const data = new Uint8Array([0xff, ...buf, 0x00, 0x00]);

  assert.deepEqual(scanSettingsKeys(data), [{ key, display }]);
});

test("scanColorParserList: синтетический список имён и цветов", () => {
  // Раскладка эталона: [count] затем на запись [len][имя][pad][16 байт RGBA]
  // и ШАГ 24 байта (эталон пропускает 8 байт — так в оригинале).
  const chunks: number[] = [];
  const pushU32 = (n: number): void => {
    for (let i = 0; i < 4; i++) chunks.push((n >> (i * 8)) & 0xff);
  };
  const pushF32 = (v: number): void => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    chunks.push(...b);
  };
  pushU32(2);
  const entries: Array<[string, number[]]> = [
    ["red", [1, 0, 0]],
    ["blue", [0, 0, 1]],
  ];
  for (const [name, color] of entries) {
    pushU32(name.length);
    for (const b of new TextEncoder().encode(name)) chunks.push(b);
    while (chunks.length % 4 !== 0) chunks.push(0);
    for (const v of color) pushF32(v);
    pushF32(1);
    for (let i = 0; i < 8; i++) chunks.push(0);
  }
  const raw = new Uint8Array(chunks);
  assert.deepEqual(parseColorParserList(raw), { red: "#FF0000", blue: "#0000FF" });
  assert.equal(parseColorParserList(new Uint8Array(0)), null);
});

test("isGlobalStringCandidate: лейблы проходят, пути и символы нет", () => {
  assert.equal(isGlobalStringCandidate("New Game"), true);
  assert.equal(isGlobalStringCandidate("MENU"), true);
  assert.equal(isGlobalStringCandidate("Back"), true);
  // Эталон пропускает snake_case и m_Script (это его поведение, не наше решение).
  assert.equal(isGlobalStringCandidate("this_is_a_field"), true);
  assert.equal(isGlobalStringCandidate("m_Script"), true);
  assert.equal(isGlobalStringCandidate("Assets/Textures/foo"), false);
  assert.equal(isGlobalStringCandidate("{}"), false);
});

test("scanGlobalStrings: сортировка по приоритету и лимит 500", () => {
  const raw = ascii("New Game\u0000MENU\u0000Resolution\u0000_gloss");
  const found = scanGlobalStrings(raw);
  assert.deepEqual(found, ["New Game", "MENU", "Resolution"]);
  assert.ok(uiPriority("New Game") > uiPriority("Resolution"));
  assert.equal(uiPriority("_gloss"), -50);
});
