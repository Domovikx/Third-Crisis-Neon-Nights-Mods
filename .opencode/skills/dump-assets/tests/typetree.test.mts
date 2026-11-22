/**
 * typetree.test.mts — разбор type tree из blob и generic-чтение объекта.
 *
 * Блоб собирается синтетически (как в SerializedFile): заголовок
 * [nodeCount][stringBuffer], затем узлы по 32 байта и строковый буфер.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTypeTree,
  PyFloat,
  readObjectTypetree,
  readValue,
  type TypeTreeNode,
} from "../scripts/typetree.mts";
import { ByteReader } from "../scripts/binary.mts";
import { testTreeNode } from "./helpers.mts";

interface NodeSpec {
  type: string;
  name: string;
  level: number;
  metaFlag?: number;
}

/** Собрать blob type tree и вернуть байты + границы для parseTypeTree. */
function buildTree(nodes: NodeSpec[]): {
  bytes: Uint8Array;
  info: { nodeCount: number; stringBufferSize: number; blobStart: number; blobEnd: number };
} {
  const strings = new Map<string, number>();
  const chunks: number[] = [];
  let length = 0;
  const addString = (value: string): number => {
    const existing = strings.get(value);
    if (existing !== undefined) return existing;
    const offset = length;
    for (const b of new TextEncoder().encode(value)) {
      chunks.push(b);
      length += 1;
    }
    chunks.push(0);
    length += 1;
    strings.set(value, offset);
    return offset;
  };
  const typeOffsets = nodes.map((node) => addString(node.type));
  const nameOffsets = nodes.map((node) => addString(node.name));

  const nodeBytes: number[] = [];
  nodes.forEach((node, index) => {
    nodeBytes.push(
      ...testTreeNode({
        level: node.level,
        typeOffset: typeOffsets[index],
        nameOffset: nameOffsets[index],
        metaFlag: node.metaFlag ?? 0,
      }),
    );
  });

  const header = new Uint8Array(8);
  new DataView(header.buffer).setInt32(0, nodes.length, true);
  new DataView(header.buffer).setInt32(4, chunks.length, true);
  const bytes = new Uint8Array([...header, ...nodeBytes, ...chunks]);
  return {
    bytes,
    info: {
      nodeCount: nodes.length,
      stringBufferSize: chunks.length,
      blobStart: 8,
      blobEnd: 8 + nodeBytes.length + chunks.length,
    },
  };
}

test("parseTypeTree: иерархия по m_Level, строки из буфера", () => {
  const { bytes, info } = buildTree([
    { type: "GameObject", name: "Base", level: 0 },
    { type: "string", name: "m_Name", level: 1 },
    { type: "vector", name: "m_Items", level: 1 },
    { type: "Array", name: "Array", level: 2, metaFlag: 0x4000 },
    { type: "int", name: "size", level: 3 },
    { type: "int", name: "data", level: 3 },
  ]);
  const root = parseTypeTree(bytes, info, "le");
  assert.equal(root.type, "GameObject");
  assert.deepEqual(
    root.children.map((child) => child.name),
    ["m_Name", "m_Items"],
  );
  assert.equal(root.children[1].children[0].type, "Array");
});

test("parseTypeTree: общие строки Unity (старший бит смещения)", () => {
  // 49 — смещение "Array" в таблице общих строк (стабильные данные TPK).
  const header = new Uint8Array(8);
  new DataView(header.buffer).setInt32(0, 1, true);
  new DataView(header.buffer).setInt32(4, 1, true);
  const node = testTreeNode({ level: 0, typeOffset: 0x80000000 | 49, nameOffset: 0 });
  const bytes = new Uint8Array([...header, ...node, 0]);
  const root = parseTypeTree(
    bytes,
    { nodeCount: 1, stringBufferSize: 1, blobStart: 8, blobEnd: bytes.length },
    "le",
  );
  assert.equal(root.type, "Array");
  assert.equal(root.name, "");
});

test("readValue: примитивы, строка с выравниванием, вектор int", () => {
  const { bytes, info } = buildTree([
    { type: "GameObject", name: "Base", level: 0 },
    { type: "string", name: "m_Name", level: 1 },
    { type: "int", name: "m_Layer", level: 1 },
    { type: "vector", name: "m_Items", level: 1 },
    { type: "Array", name: "Array", level: 2, metaFlag: 0x4000 },
    { type: "int", name: "size", level: 3 },
    { type: "int", name: "data", level: 3 },
  ]);
  const root = parseTypeTree(bytes, info, "le");

  const raw = new Uint8Array(32);
  const view = new DataView(raw.buffer);
  view.setInt32(0, 5, true); // длина "Hello"
  raw.set(new TextEncoder().encode("Hello"), 4);
  // 4 + 5 = 9 → выравнивание до 12
  view.setInt32(12, 7, true); // m_Layer
  view.setInt32(16, 3, true); // количество элементов
  view.setInt32(20, 1, true);
  view.setInt32(24, 2, true);
  view.setInt32(28, 3, true);

  assert.deepEqual(readObjectTypetree(root, raw, "le"), {
    m_Name: "Hello",
    m_Layer: 7,
    m_Items: [1, 2, 3],
  });
});

test("readObjectTypetree: лишние байты — null (у эталона read_failed)", () => {
  const { bytes, info } = buildTree([
    { type: "GameObject", name: "Base", level: 0 },
    { type: "int", name: "m_Layer", level: 1 },
  ]);
  const root = parseTypeTree(bytes, info, "le");
  const raw = new Uint8Array(8);
  new DataView(raw.buffer).setInt32(0, 5, true);
  assert.equal(readObjectTypetree(root, raw, "le"), null);
});

test("readValue: float оборачивается в PyFloat (repr как у Python)", () => {
  const { bytes, info } = buildTree([
    { type: "Sprite", name: "Base", level: 0 },
    { type: "float", name: "m_PixelsToUnits", level: 1 },
  ]);
  const root = parseTypeTree(bytes, info, "le");
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setFloat32(0, 2.5, true);
  const reader = new ByteReader(raw, { endian: "le" });
  const value = readValue(root, reader) as Record<string, unknown>;
  assert.ok(value.m_PixelsToUnits instanceof PyFloat);
  assert.equal(String(value.m_PixelsToUnits), "2.5");
});

test("parseTypeTree: пустое дерево — понятная ошибка", () => {
  const header = new Uint8Array(8);
  const bytes = new Uint8Array([...header, 0]);
  assert.throws(
    () =>
      parseTypeTree(bytes, { nodeCount: 0, stringBufferSize: 1, blobStart: 8, blobEnd: 9 }, "le"),
    /пустое дерево/,
  );
});

/** Экспорт типа для читаемости файла. */
export type { TypeTreeNode };
