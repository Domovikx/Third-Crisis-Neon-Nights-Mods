/**
 * Паритет QA: Rust-ядро (`tools/rust-qa`) против TS-эталона (`qa_translate.mts`).
 *
 * Гейт из `docs/qa-scaling.md`: набор находок и сводка должны совпадать на реальных данных.
 * Без собранного `rust-qa` тесты пропускаются (как в `rust_parity.test.mts` для дампера).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { check } from "../.opencode/skills/translate-qa/scripts/qa_translate.mts";
import { rustQaBinary } from "./qa.mts";

const REPO = resolve(import.meta.dirname, "..");
const bin = rustQaBinary(REPO);
const skip = bin ? false : "rust-qa не собран (npm run qa:build)";

let tmp: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  tmp = mkdtempSync(join(REPO, "tmp", "qa-parity-"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function rustReport(lang: string): {
  summary: { total: number; filled: number; errors: number; warnings: number };
  findings: Array<{ level: string; rule: string; rel: string; text: string; detail: string }>;
} {
  const out = join(tmp, `${lang}.json`);
  const run = spawnSync(bin as string, ["--root", REPO, "--lang", lang, "--json", out, "--quiet"], {
    stdio: "ignore",
  });
  // Код 1 — «найдены ошибки» (как у TS-реализации), а не падение.
  assert.ok(run.status === 0 || run.status === 1, `rust-qa упал на ${lang} (код ${run.status})`);
  assert.ok(existsSync(out), `rust-qa не создал ${out}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

for (const lang of ["ru", "de"]) {
  test(`паритет QA на ${lang}: находки и сводка совпадают с TS`, { skip }, () => {
    const ts = check(lang, REPO);
    const rust = rustReport(lang);

    assert.equal(rust.summary.total, ts.summary.total, "всего записей");
    assert.equal(rust.summary.filled, ts.summary.filled, "переведено");
    assert.equal(rust.summary.errors, ts.summary.errors, "ошибок");
    assert.equal(rust.summary.warnings, ts.summary.warnings, "предупреждений");

    assert.deepEqual(
      rust.findings.map((f) => [f.level, f.rule, f.rel, f.text, f.detail]),
      ts.findings.map((f) => [f.level, f.rule, f.rel, f.text, f.detail]),
      "набор находок должен совпадать побайтово",
    );
  });
}
