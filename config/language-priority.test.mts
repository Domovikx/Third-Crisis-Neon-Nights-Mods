/**
 * language-priority.test.mts — JSON-артефакт обязан совпадать с модулем.
 *
 * Источник истины — `config/language-priority.mts`; JSON
 * (`config/language-priority.json`) читают Rust (`tools/rust-lint`) и скрипты.
 * Правили модуль и забыли перегенерировать (или наоборот, руками поправили
 * JSON) — тест падает.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LANGUAGE_PRIORITY } from "./language-priority.mts";

const JSON_PATH = join(import.meta.dirname, "language-priority.json");
const REGEN = "node config/language-priority.mts > config/language-priority.json";

test("config/language-priority.json = экспорт config/language-priority.mts", () => {
  const artifact = JSON.parse(readFileSync(JSON_PATH, "utf8")) as unknown;
  assert.deepEqual(
    artifact,
    LANGUAGE_PRIORITY,
    `config/language-priority.json разошёлся с модулем — перегенерируй: ${REGEN}`,
  );
});
