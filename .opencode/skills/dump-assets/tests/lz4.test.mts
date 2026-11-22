/**
 * Тесты LZ4-декодера: векторы собраны байтами в самих тестах.
 *
 * Покрываем: пустой блок, только литералы, расширение длины, повторы
 * (включая перекрывающийся матч), границу окна и битые данные.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BinaryFormatError } from "../scripts/binary.mts";
import { lz4BlockDecompress } from "../scripts/lz4.mts";
import { lz4Literals } from "./helpers.mts";

const bytes = (...values: Array<number | string>): Uint8Array => {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === "number") out.push(value);
    else for (const ch of value) out.push(ch.charCodeAt(0));
  }
  return new Uint8Array(out);
};

const text = (data: Uint8Array): string => new TextDecoder().decode(data);

test("LZ4: пустой блок", () => {
  assert.deepEqual(lz4BlockDecompress(new Uint8Array([0x00]), 0), new Uint8Array(0));
});

test("LZ4: только литералы", () => {
  const out = lz4BlockDecompress(bytes(0x50, "hello"), 5);
  assert.equal(text(out), "hello");
});

test("LZ4: расширение длины литералов (15 + остаток)", () => {
  const payload = new TextEncoder().encode("0123456789abcdefgh"); // 18 байт
  const block = lz4Literals(payload);
  assert.deepEqual(lz4BlockDecompress(block, payload.length), payload);
});

test("LZ4: матч с offset 1 (aaaaa)", () => {
  const out = lz4BlockDecompress(bytes(0x10, "a", 0x01, 0x00), 5);
  assert.equal(text(out), "aaaaa");
});

test("LZ4: перекрывающийся матч с offset 2 (ababababab)", () => {
  const out = lz4BlockDecompress(bytes(0x24, "a", "b", 0x02, 0x00), 10);
  assert.equal(text(out), "ababababab");
});

test("LZ4: расширение длины матча", () => {
  // 1 литерал + матч 15+4+2 = 21 байт => 22 байта 'a'
  const out = lz4BlockDecompress(bytes(0x1f, "a", 0x01, 0x00, 0x02), 22);
  assert.equal(text(out), "a".repeat(22));
});

test("LZ4: offset 0 — ошибка формата", () => {
  assert.throws(
    () => lz4BlockDecompress(bytes(0x10, "a", 0x00, 0x00), 5),
    (err: unknown) => {
      assert.ok(err instanceof BinaryFormatError);
      assert.match(err.message, /offset матча равен 0/);
      return true;
    },
  );
});

test("LZ4: offset больше окна — ошибка формата", () => {
  assert.throws(
    () => lz4BlockDecompress(bytes(0x10, "a", 0x05, 0x00), 5),
    /больше распакованного окна/,
  );
});

test("LZ4: литералы переполняют выход — ошибка формата", () => {
  assert.throws(() => lz4BlockDecompress(bytes(0x50, "hello"), 3), /переполняют выход/);
});

test("LZ4: обрезанный литерал — ошибка формата", () => {
  assert.throws(() => lz4BlockDecompress(bytes(0x50, "he"), 5), /выходит за конец блока/);
});

test("LZ4: обрезанное расширение длины — ошибка формата", () => {
  assert.throws(() => lz4BlockDecompress(bytes(0xf0), 20), /длина литералов обрывается/);
});

test("LZ4: обрезанный offset — ошибка формата", () => {
  assert.throws(() => lz4BlockDecompress(bytes(0x10, "a", 0x01), 5), /обрезан offset/);
});

test("LZ4: размер результата не совпал — ошибка формата", () => {
  assert.throws(() => lz4BlockDecompress(bytes(0x10, "a", 0x01, 0x00), 99), /вместо 99/);
});

test("LZ4: некорректный ожидаемый размер — ошибка", () => {
  assert.throws(() => lz4BlockDecompress(bytes(0x00), -1), /некорректный ожидаемый размер/);
});
