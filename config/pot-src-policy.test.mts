/**
 * pot-src-policy.test.mts — JSON-артефакт обязан совпадать с модулем.
 *
 * Источник истины — `config/pot-src-policy.mts`; JSON читают potgen (Rust) и
 * TS-проверки. Метки правят в модуле, артефакт перегенерируют.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { POT_SRC_POLICY } from "./pot-src-policy.mts";

const JSON_PATH = join(import.meta.dirname, "pot-src-policy.json");
const REGEN = "node config/pot-src-policy.mts > config/pot-src-policy.json";

test("config/pot-src-policy.json = экспорт config/pot-src-policy.mts", () => {
  const artifact = JSON.parse(readFileSync(JSON_PATH, "utf8")) as unknown;
  assert.deepEqual(
    artifact,
    POT_SRC_POLICY,
    `config/pot-src-policy.json разошёлся с модулем — перегенерируй: ${REGEN}`,
  );
});
