/**
 * assemble_parity.test.mts — сборка дампа: Rust-ассемблер против TS-эталона.
 *
 * Оракул тот же, что у паритета декодера: два исполнителя одного контракта
 * обязаны дать ПОБАЙТОВО одинаковый каталог (`summaries.jsonl`,
 * `<asset>.jsonl`, `index.md`). Иначе «ускорение» куплено смыслом.
 *
 * Фикстура — rd1 от `rust-decoder` (в git его нет: 0,2–530 МБ). Тест
 * пропускается, если дампа нет или `rust-l10n` не собран; путь можно задать
 * через `TCNN_RD1`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  dumpAssetsFromRaw,
  defaultDumpOptions,
} from "../.opencode/skills/dump-assets/scripts/dump_assets.mts";
import { l10nBinary } from "./text_cli.mts";

const REPO = resolve(import.meta.dirname, "..");

/** Маленькая фикстура (1,6 МБ): хватает, чтобы проверить все ветки записей. */
function fixture(): string | null {
  const explicit = process.env.TCNN_RD1;
  if (explicit && existsSync(explicit)) return resolve(explicit);
  const candidates = [
    join(REPO, "tmp", "raw", "dump-limit-smoke2.rd1.jsonl"),
    join(REPO, "tmp", "raw", "dump-limit-smoke.rd1.jsonl"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

const rd1 = fixture();
const binary = l10nBinary(REPO);
const skipReason =
  rd1 === null
    ? "нет rd1-фикстуры (tmp/raw/dump-limit-smoke*.rd1.jsonl); задайте TCNN_RD1"
    : binary === null
      ? "rust-l10n не собран (npm run l10n:build)"
      : false;

test("assemble: Rust и TS дают побайтово одинаковый дамп", { skip: skipReason }, () => {
  const work = mkdtempSync(join(tmpdir(), "tcnn-assemble-"));
  const tsDir = join(work, "ts");
  const rustDir = join(work, "rust");
  try {
    // TS-эталон печатает строку на каждый ассет — для теста это шум.
    const savedError = console.error;
    console.error = () => {};
    try {
      dumpAssetsFromRaw(rd1 as string, tsDir, defaultDumpOptions());
    } finally {
      console.error = savedError;
    }

    const run = spawnSync(binary as string, ["dump_assemble", rd1 as string, rustDir, "--json"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr?.slice(0, 400));

    const tsFiles = readdirSync(tsDir).sort();
    const rustFiles = readdirSync(rustDir).sort();
    assert.deepEqual(rustFiles, tsFiles, "состав файлов дампа разошёлся");

    for (const name of tsFiles) {
      const expected = readFileSync(join(tsDir, name));
      const actual = readFileSync(join(rustDir, name));
      if (!expected.equals(actual)) {
        let at = 0;
        while (at < expected.length && at < actual.length && expected[at] === actual[at]) at += 1;
        assert.fail(
          `${name}: расхождение на байте ${at}\n` +
            `TS  : ${JSON.stringify(expected.subarray(Math.max(0, at - 60), at + 80).toString())}\n` +
            `Rust: ${JSON.stringify(actual.subarray(Math.max(0, at - 60), at + 80).toString())}`,
        );
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
