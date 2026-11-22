/**
 * Тесты LZMA-декодера (фолбэк для бандлов, сжатых LZMA).
 *
 * Векторы сжаты эталонным xz/LZMA1 и лежат в helpers.mts как base64 —
 * содержимое синтетическое, не игровое.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BinaryFormatError } from "../scripts/binary.mts";
import { lzmaRawDecompress } from "../scripts/lzma.mts";
import { LZMA_TEXT, lzmaVectorBytes } from "./helpers.mts";

test("LZMA: raw-поток декодируется побайтово", () => {
  const out = lzmaRawDecompress(lzmaVectorBytes(), LZMA_TEXT.length);
  assert.equal(new TextDecoder().decode(out), LZMA_TEXT);
});

test("LZMA: обрезанный заголовок свойств — ошибка", () => {
  assert.throws(
    () => lzmaRawDecompress(new Uint8Array([0x5d, 0x00]), 10),
    /заголовок свойств обрезан/,
  );
});

test("LZMA: битые свойства — ошибка", () => {
  assert.throws(
    () => lzmaRawDecompress(new Uint8Array([0xff, 0, 0, 0, 0, 0]), 10),
    /битые свойства/,
  );
});

test("LZMA: первый байт потока должен быть 0", () => {
  const bytes = lzmaVectorBytes();
  bytes[5] = 1;
  assert.throws(() => lzmaRawDecompress(bytes, LZMA_TEXT.length), /первый байт потока/);
});

test("LZMA: заявленный размер больше потока — ошибка", () => {
  assert.throws(
    () => lzmaRawDecompress(lzmaVectorBytes(), LZMA_TEXT.length + 500),
    (err: unknown) => {
      assert.ok(err instanceof BinaryFormatError);
      return true;
    },
  );
});

test("LZMA: некорректный ожидаемый размер — ошибка", () => {
  assert.throws(() => lzmaRawDecompress(lzmaVectorBytes(), -5), /некорректный ожидаемый размер/);
});
