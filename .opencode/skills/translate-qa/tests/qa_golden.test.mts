/**
 * Золотой оракул QA: Rust-движок (`tools/rust-qa`) против замороженного отчёта.
 *
 * Золото (`test_data/qa-golden-<lang>.json`) снято с TS-эталона
 * (`qa_translate.mts`) 2026-11-24, коммит `ed8657e`, и тогда же подтверждено
 * побайтовое совпадение с Rust. После удаления TS-эталона золото — единственный
 * оракул: любой дрейф правил, сводки или ПОРЯДКА находок виден как дифф.
 *
 * Вход — срез реального корпуса (`test_data/fixture-<lang>/`): в нём все строки,
 * дававшие находки на момент снятия, плюс сэмпл «чистых» строк (статистика
 * покрытия). Поэтому тест не зависит от текущего `po/` — тот меняется каждый день.
 *
 * Без собранного `rust-qa` тест пропускается (как остальные Rust-паритеты).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { REPO_ROOT } from "../../../../scripts/languages.mts";
import { rustQaBinary } from "../../../../scripts/qa.mts";

const DATA = join(import.meta.dirname, "..", "test_data");
const bin = rustQaBinary(REPO_ROOT);
const skip = bin ? false : "rust-qa не собран (npm run qa:build)";
mkdirSync(join(REPO_ROOT, "tmp"), { recursive: true }); // под mkdtemp

const LANGS = ["ru", "de"];

for (const lang of LANGS) {
  test(`золотой отчёт QA на фикстуре ${lang}: находки и сводка совпадают`, { skip }, () => {
    const goldenPath = join(DATA, `qa-golden-${lang}.json`);
    const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
      lang: string;
      summary: { errors: number };
      findings: unknown[];
    };

    const root = join(DATA, `fixture-${lang}`);
    assert.ok(existsSync(join(root, "po", "template.pot")), `нет фикстуры ${root}`);
    assert.ok(existsSync(join(root, "po", `${lang}.po`)), `нет po/${lang}.po в фикстуре`);

    const tmp = mkdtempSync(join(REPO_ROOT, "tmp", "qa-golden-"));
    try {
      const out = join(tmp, `${lang}.json`);
      const run = spawnSync(
        bin as string,
        ["--root", root, "--lang", lang, "--json", out, "--quiet"],
        { stdio: "ignore" },
      );
      // Код 1 = «есть error-находки», это не падение.
      assert.ok(run.status === 0 || run.status === 1, `rust-qa упал на ${lang}`);
      assert.equal(run.status, golden.summary.errors > 0 ? 1 : 0, "код выхода по errors");
      assert.ok(existsSync(out), `rust-qa не создал ${out}`);

      const report = JSON.parse(readFileSync(out, "utf8"));
      // Полное сравнение: сводка, by_speaker/by_dir и находки В ПОРЯДКЕ —
      // порядок находок часть контракта (правила идут по записям POT, дубли — в конце).
      assert.deepEqual(report, golden, `отчёт ${lang} разошёлся с золотом`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("золото не пустое: находки на фикстурах есть", { skip }, () => {
  for (const lang of LANGS) {
    const golden = JSON.parse(readFileSync(join(DATA, `qa-golden-${lang}.json`), "utf8")) as {
      findings: unknown[];
    };
    assert.ok(golden.findings.length > 0, `золото ${lang} без находок — фикстура выродилась`);
  }
});
