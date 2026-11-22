/** jsonl.test.mts — формат JSONL: BigInt, float как в Python, разделители. */

import assert from "node:assert/strict";
import test from "node:test";

import { jsonlStringify } from "../scripts/jsonl.mts";
import { pyFloatRepr, pyStrip, pyRound } from "../scripts/pystr.mts";
import { PyFloat } from "../scripts/typetree.mts";

test("jsonlStringify: порядок ключей и разделители json.dumps", () => {
  assert.equal(
    jsonlStringify({ asset: "level1", path_id: 5n, type: "GameObject" }),
    '{"asset": "level1", "path_id": 5, "type": "GameObject"}',
  );
});

test("jsonlStringify: 64-битные path_id без потери точности", () => {
  assert.equal(
    jsonlStringify({ path_id: -9118446906516876123n }),
    '{"path_id": -9118446906516876123}',
  );
});

test("jsonlStringify: float печатается как Python (60.0, 1e-05)", () => {
  assert.equal(jsonlStringify({ value: new PyFloat(60) }), '{"value": 60.0}');
  assert.equal(jsonlStringify({ value: new PyFloat(2.5) }), '{"value": 2.5}');
  assert.equal(jsonlStringify({ value: new PyFloat(0.00001) }), '{"value": 1e-05}');
  assert.equal(pyFloatRepr(1.5e21), "1.5e+21");
});

test("jsonlStringify: вложенные массивы, юникод, undefined отбрасывается", () => {
  assert.equal(
    jsonlStringify({ dialogues: [{ speaker: "Zoey", text: "Привет" }], skip: undefined }),
    '{"dialogues": [{"speaker": "Zoey", "text": "Привет"}]}',
  );
});

test("pyStrip: пробелы Python (NEL, NBSP), но не BOM", () => {
  assert.equal(pyStrip("\u0000 текст \u0085"), "\u0000 текст");
  assert.equal(pyStrip("\u00a0 x \u3000"), "x");
  assert.equal(pyStrip("\ufeffx"), "\ufeffx");
});

test("pyRound: банковское округление как round() в Python", () => {
  assert.equal(pyRound(0.5), 0);
  assert.equal(pyRound(1.5), 2);
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(2.5000001), 3);
});
