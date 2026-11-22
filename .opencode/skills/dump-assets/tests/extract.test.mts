/**
 * extract.test.mts — извлечение строки JSONL из объекта и FSM-строки.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { collectTypedFields, extractObject, parseFsmStrings } from "../scripts/extract.mts";
import { PyFloat, type TypeTreeNode } from "../scripts/typetree.mts";
import type { SerializedObject } from "../scripts/serialized.mts";

const encoder = new TextEncoder();

function objectOf(pathId: bigint, data: Uint8Array): SerializedObject {
  return { pathId, typeId: 0, classId: 114, byteStart: 0, byteSize: data.length };
}

function node(partial: Partial<TypeTreeNode>): TypeTreeNode {
  return {
    level: 0,
    type: "",
    name: "",
    byteSize: 0,
    index: 0,
    metaFlag: 0,
    version: 0,
    flags: 0,
    refTypeHash: 0n,
    children: [],
    ...partial,
  };
}

test("parseFsmStrings: value без useVariable + stringParams", () => {
  const typed = {
    fsm: {
      states: [
        {
          events: [
            { value: "Ask about her Arm", useVariable: false },
            { value: "VariableName", useVariable: true },
          ],
          stringParams: ["Param One", 42],
        },
      ],
    },
    Ignored: { nested: [{ value: "Nested Value" }] },
  };
  // Порядок обхода эталона: stringParams узла встречается раньше вложенных events.
  assert.deepEqual(parseFsmStrings(typed), ["Param One", "Ask about her Arm", "Nested Value"]);
});

test("parseFsmStrings: пути переменных, line_* и короткие строки отброшены", () => {
  const typed = {
    list: [
      { value: "GlowingHoleKeys/X" },
      { value: "line_018" },
      { value: "a" },
      { value: "Yes" },
      { value: "Yes" },
    ],
  };
  assert.deepEqual(parseFsmStrings(typed), ["Yes"]);
});

test("parseFsmStrings: лимит 500 строк", () => {
  const list = Array.from({ length: 600 }, (_, i) => ({ value: `Value number ${i}` }));
  assert.equal(parseFsmStrings({ list }).length, 500);
});

test("collectTypedFields: строки, pptr, списки; служебные поля пропущены", () => {
  const typed: Record<string, unknown> = {
    m_Name: "PlayMakerFSM",
    m_Script: { m_FileID: 0, m_PathID: 1n },
    m_GameObject: { m_FileID: 0, m_PathID: 2n },
    m_Enabled: true,
    m_Items: [1, 2],
    m_Ptrs: [{ m_FileID: 0, m_PathID: 3n }],
    m_Structs: [{ inner: 1 }],
    m_Scale: new PyFloat(2.5),
    m_Long: 5n,
    m_Empty: "",
    fsm: {},
  };
  const result = collectTypedFields(typed);
  assert.deepEqual(result.strings, { m_Name: "PlayMakerFSM" });
  assert.deepEqual(Object.keys(result.fields).sort(), [
    "m_Enabled",
    "m_Items",
    "m_Long",
    "m_Ptrs",
    "m_Scale",
  ]);
  assert.deepEqual(result.fields.m_Ptrs, [{ file_id: 0, path_id: 3n }]);
  assert.equal(result.isFsm, true);
});

test("extractObject: без type tree — read_failed, dialogues и raw_strings на месте", () => {
  const raw = encoder.encode(
    'pad{"Speaker":"Zoey","Text":"Hello <b>there</b>!"}\u0000Raw Label\u0000',
  );
  const row = extractObject(objectOf(10n, raw), raw, null);
  assert.equal(row.path_id, 10n);
  assert.equal(row.type, "MonoBehaviour");
  assert.equal(row.error, "read_failed");
  assert.deepEqual(
    row.dialogues?.map((d) => [d.speaker, d.text]),
    [["Zoey", "Hello there!"]],
  );
  assert.deepEqual(row.raw_strings, [
    'pad{"Speaker":"Zoey","Text":"Hello <b>there</b>!"}',
    "Raw Label",
  ]);
});

test("extractObject: ColorParserList спасает строку от read_failed", () => {
  const names = "perversion";
  const chunks: number[] = [];
  const pushU32 = (n: number): void => {
    for (let i = 0; i < 4; i++) chunks.push((n >> (i * 8)) & 0xff);
  };
  const pushF32 = (v: number): void => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    chunks.push(...b);
  };
  pushU32(1);
  pushU32(names.length);
  for (const b of encoder.encode(names)) chunks.push(b);
  while (chunks.length % 4 !== 0) chunks.push(0);
  pushF32(1);
  pushF32(0);
  pushF32(1);
  pushF32(1);
  for (let i = 0; i < 8; i++) chunks.push(0);
  const nameBytes = encoder.encode("ColorParserList");
  const raw = new Uint8Array([...nameBytes, 0, ...chunks]);

  const row = extractObject(objectOf(11n, raw), raw, null);
  assert.equal(row.error, undefined);
  assert.deepEqual(row.color_parser_list, { perversion: "#FF00FF" });
});

test("extractObject: с type tree — strings/fields/fsm_strings", () => {
  // Сырые байты: m_Name "FSM" (4+3+pad=8), затем fsm.value "Ask" (4+3+pad=8),
  // затем fsm.useVariable (1 байт + выравнивание fsm до 4 = 4).
  const raw = new Uint8Array(20);
  const view = new DataView(raw.buffer);
  view.setInt32(0, 3, true);
  raw.set(encoder.encode("FSM"), 4);
  view.setInt32(8, 3, true);
  raw.set(encoder.encode("Ask"), 12);
  raw[16] = 0;
  // Узел дерева: MonoBehaviour → m_Name:string, fsm:{value:string,useVariable:bool}
  const tree = node({
    type: "MonoBehaviour",
    children: [
      node({ type: "string", name: "m_Name", level: 1 }),
      node({
        type: "fsm",
        name: "fsm",
        level: 1,
        metaFlag: 0x4000,
        children: [
          node({ type: "string", name: "value", level: 2 }),
          node({ type: "bool", name: "useVariable", level: 2 }),
        ],
      }),
    ],
  });
  const row = extractObject(objectOf(12n, raw), raw, tree);
  assert.equal(row.error, undefined);
  assert.deepEqual(row.strings, { m_Name: "FSM" });
  assert.deepEqual(row.fsm_strings, ["Ask"]);
  assert.equal(row.dialogues, undefined);
});
