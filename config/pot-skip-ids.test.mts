/**
 * pot-skip-ids.test.mts — JSON-артефакт обязан совпадать с модулем.
 *
 * Источник истины — `config/pot-skip-ids.mts`; JSON читает potgen (Rust).
 * Список правят в модуле, артефакт перегенерируют.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { POT_SKIP_IDS } from "./pot-skip-ids.mts";

const JSON_PATH = join(import.meta.dirname, "pot-skip-ids.json");
const REGEN = "node config/pot-skip-ids.mts > config/pot-skip-ids.json";

test("config/pot-skip-ids.json = экспорт config/pot-skip-ids.mts", () => {
  const artifact = JSON.parse(readFileSync(JSON_PATH, "utf8")) as unknown;
  assert.deepEqual(
    artifact,
    POT_SKIP_IDS,
    `config/pot-skip-ids.json разошёлся с модулем — перегенерируй: ${REGEN}`,
  );
});
