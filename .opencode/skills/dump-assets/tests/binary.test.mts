/**
 * Тесты ByteReader: LE/BE, строки, выравнивание, понятные ошибки усечения.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BinaryFormatError, ByteReader, i64ToNumber } from "../scripts/binary.mts";

test("ByteReader: little-endian и big-endian читаются одним и тем же буфером", () => {
  const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  assert.equal(new ByteReader(data, { endian: "le" }).u32(), 0x04030201);
  assert.equal(new ByteReader(data, { endian: "be" }).u32(), 0x01020304);
});

test("ByteReader: i16/i32/i64 знаковые", () => {
  const r = new ByteReader(new Uint8Array([0xff, 0xff, 0xff, 0xff]), { endian: "le" });
  assert.equal(r.i16(), -1);
  assert.equal(r.i16(), -1);
  const r2 = new ByteReader(new Uint8Array(8).fill(0xff), { endian: "le" });
  assert.equal(r2.i64(), -1n);
});

test("ByteReader: cstring останавливается на нуле и двигает позицию", () => {
  const r = new ByteReader(new TextEncoder().encode("CAB-abc\0next\0"));
  assert.equal(r.cstring(), "CAB-abc");
  assert.equal(r.cstring(), "next");
});

test("ByteReader: cstring без терминатора — ошибка с позицией", () => {
  const r = new ByteReader(new TextEncoder().encode("no-null"));
  assert.throws(
    () => r.cstring(),
    (err: unknown) => {
      assert.ok(err instanceof BinaryFormatError);
      assert.match(err.message, /терминатор/);
      return true;
    },
  );
});

test("ByteReader: align выравнивает позицию", () => {
  const r = new ByteReader(new Uint8Array(32));
  r.skip(3);
  r.align(16);
  assert.equal(r.pos, 16);
  r.skip(1);
  r.align(4);
  assert.equal(r.pos, 20);
});

test("ByteReader: чтение за границей — BinaryFormatError, а не RangeError", () => {
  const r = new ByteReader(new Uint8Array([1, 2]));
  assert.throws(
    () => r.u32(),
    (err: unknown) => {
      assert.ok(err instanceof BinaryFormatError);
      assert.match(err.message, /усечённые данные/);
      return true;
    },
  );
});

test("i64ToNumber: безопасные значения и явный отказ на 64-битных", () => {
  assert.equal(i64ToNumber(42n, "x"), 42);
  assert.throws(() => i64ToNumber(9007199254740993n, "x"), /безопасное целое/);
});
