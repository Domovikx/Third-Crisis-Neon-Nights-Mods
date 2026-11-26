/**
 * pot-skip-policy.test.mts — JSON-артефакт обязан совпадать с модулем.
 *
 * Источник истины — `config/pot-skip-policy.mts`; JSON читают potgen (Rust) и
 * TS-проверки. Правила правят в модуле, артефакт перегенерируют.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { POT_SKIP_POLICY } from "./pot-skip-policy.mts";

const JSON_PATH = join(import.meta.dirname, "pot-skip-policy.json");
const REGEN = "node config/pot-skip-policy.mts > config/pot-skip-policy.json";

test("config/pot-skip-policy.json = экспорт config/pot-skip-policy.mts", () => {
  const artifact = JSON.parse(readFileSync(JSON_PATH, "utf8")) as unknown;
  assert.deepEqual(
    artifact,
    POT_SKIP_POLICY,
    `config/pot-skip-policy.json разошёлся с модулем — перегенерируй: ${REGEN}`,
  );
});
