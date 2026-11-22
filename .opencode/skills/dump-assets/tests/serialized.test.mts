/**
 * Тесты SerializedFile на синтетических файлах версии 22.
 *
 * Покрываем: type tree off/on, пустую таблицу объектов, 64-битные path_id,
 * externals, чтение объекта сырыми байтами и понятные ошибки.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BinaryFormatError } from "../scripts/binary.mts";
import {
  isSerializedFile,
  peekSerializedHeader,
  readObjectRaw,
  readSerializedFile,
} from "../scripts/serialized.mts";
import { buildSerializedFile, testTreeNode } from "./helpers.mts";

const data = (...values: number[]): Uint8Array => new Uint8Array(values);

function simpleFile(
  overrides: Partial<Parameters<typeof buildSerializedFile>[0]> = {},
): Uint8Array {
  return buildSerializedFile({
    types: [{ classId: 1 }, { classId: 114 }],
    objects: [
      { pathId: 1n, data: data(0xaa, 0xbb), typeId: 0 },
      { pathId: 777n, data: data(0xcc), typeId: 1 },
    ],
    externals: ["sharedassets0.assets", "Library/unity default resources"],
    ...overrides,
  });
}

test("SerializedFile: заголовок и таблица типов", () => {
  const file = readSerializedFile(simpleFile());
  assert.equal(file.header.version, 22);
  assert.equal(file.header.unityVersion, "2022.3.62f3");
  assert.equal(file.header.endian, "le");
  assert.equal(file.header.enableTypeTree, false);
  assert.equal(file.header.targetPlatform, 19);
  assert.equal(file.types.length, 2);
  assert.deepEqual(
    file.types.map((t) => t.classId),
    [1, 114],
  );
  // У MonoBehaviour (114) в type table есть script_id (16 байт).
  assert.equal(file.types[1].scriptId?.length, 16);
});

test("SerializedFile: объекты, byteStart со dataOffset и classId по typeId", () => {
  const raw = simpleFile();
  const file = readSerializedFile(raw);
  assert.equal(file.objects.length, 2);
  assert.equal(file.objects[0].pathId, 1n);
  assert.equal(file.objects[0].typeId, 0);
  assert.equal(file.objects[0].classId, 1);
  assert.equal(file.objects[0].byteSize, 2);
  assert.deepEqual([...readObjectRaw(file, 1n)], [0xaa, 0xbb]);
  assert.deepEqual([...readObjectRaw(file, file.objects[1])], [0xcc]);
  // byteStart абсолютный: данные лежат после метаданных.
  assert.ok(file.objects[0].byteStart >= file.header.dataOffset);
  assert.equal(readObjectRaw(file, file.objects[0]).length, 2);
});

test("SerializedFile: 64-битные и отрицательные path_id", () => {
  const big = 9007199254740993n; // 2^53 + 1 — не влезает в number
  const negative = -5271052525308704166n;
  const file = readSerializedFile(
    simpleFile({
      types: [{ classId: 1 }],
      objects: [
        { pathId: big, data: data(1), typeId: 0 },
        { pathId: negative, data: data(2), typeId: 0 },
      ],
    }),
  );
  assert.equal(file.objects[0].pathId, big);
  assert.equal(file.objects[1].pathId, negative);
  assert.deepEqual([...readObjectRaw(file, negative)], [2]);
});

test("SerializedFile: пустая таблица объектов", () => {
  const file = readSerializedFile(simpleFile({ objects: [] }));
  assert.equal(file.objects.length, 0);
  assert.throws(() => readObjectRaw(file, 1n), /не найден/);
});

test("SerializedFile: type tree включён — blob пропускается, парсинг идёт дальше", () => {
  // Один узел: type="Base" (offset 0), name="m_Name" (offset 5).
  const strings = new TextEncoder().encode("Base\0m_Name\0");
  const nodes = testTreeNode({ typeOffset: 0, nameOffset: 5, byteSize: 4 });
  const raw = buildSerializedFile({
    enableTypeTree: true,
    types: [{ classId: 1, typeTree: { nodes, strings } }],
    objects: [{ pathId: 5n, data: data(9, 9, 9, 9), typeId: 0 }],
  });
  const file = readSerializedFile(raw);
  assert.equal(file.header.enableTypeTree, true);
  assert.equal(file.types.length, 1);
  assert.equal(file.types[0].typeTree?.nodeCount, 1);
  assert.equal(file.types[0].typeTree?.stringBufferSize, strings.length);
  assert.deepEqual(file.types[0].typeDependencies, []);
  assert.equal(file.objects.length, 1);
  assert.deepEqual([...readObjectRaw(file, 5n)], [9, 9, 9, 9]);
});

test("SerializedFile: externals читаются с путями", () => {
  const file = readSerializedFile(simpleFile());
  assert.deepEqual(
    file.externals.map((e) => e.path),
    ["sharedassets0.assets", "Library/unity default resources"],
  );
});

test("SerializedFile: big-endian файл тоже разбирается", () => {
  const raw = buildSerializedFile({
    endian: "be",
    types: [{ classId: 4 }],
    objects: [{ pathId: -2n, data: data(1, 2, 3, 4), typeId: 0 }],
  });
  const file = readSerializedFile(raw);
  assert.equal(file.header.endian, "be");
  assert.equal(file.objects[0].pathId, -2n);
  assert.deepEqual([...readObjectRaw(file, -2n)], [1, 2, 3, 4]);
});

test("SerializedFile: typeId вне type table — ошибка", () => {
  const raw = simpleFile({
    types: [{ classId: 1 }],
    objects: [{ pathId: 1n, data: data(1), typeId: 7 }],
  });
  assert.throws(() => readSerializedFile(raw), /typeId 7 вне type table/);
});

test("SerializedFile: версия 21 не поддерживается — явная ошибка", () => {
  const raw = simpleFile();
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  view.setUint32(8, 21, false); // версия в legacy-префиксе (BE)
  assert.throws(() => readSerializedFile(raw), /версии 21 не поддерживается/);
});

test("SerializedFile: усечённые данные — BinaryFormatError", () => {
  const raw = simpleFile().subarray(0, 60);
  assert.throws(
    () => readSerializedFile(raw),
    (err: unknown) => {
      assert.ok(err instanceof BinaryFormatError);
      return true;
    },
  );
});

test("peekSerializedHeader: валидный файл и мусор", () => {
  const raw = simpleFile();
  assert.equal(isSerializedFile(raw), true);
  assert.equal(peekSerializedHeader(raw)?.version, 22);
  assert.equal(isSerializedFile(new TextEncoder().encode("just some text.....")), false);
  assert.equal(isSerializedFile(new Uint8Array(0)), false);
});
