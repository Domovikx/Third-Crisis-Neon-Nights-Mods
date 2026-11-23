/**
 * text_golden.test.mts — слепки выхода текстового пайплайна (одна реализация).
 *
 * После миграции на Rust TS-эталоны удалены (`docs/rust-vs-ts.md`), поэтому
 * смысл стерегут два механизма: тесты Rust (`tools/rust-l10n/tests/`) и эти
 * **слепки** — байты, снятые с рабочей реализации и закоммиченные. Любое
 * изменение выхода падает тестом и требует осознанного обновления слепка
 * (`GOLDEN_UPDATE=1 npm run test:golden`), которое видно в диффе.
 *
 * Покрыто то, что является контрактом с потребителями:
 *   - `po2dat`: `.dat` (его читает игра; формат = JSON-строка на перевод);
 *   - `find_source`: человекочитаемый вывод провенанса;
 *   - `prefill`: итоговый `<lang>.po` (шапка, порядок, флаги).
 *
 * Без собранного `rust-l10n` тесты пропускаются: `npm run l10n:build`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { l10nBinary } from "./text_cli.mts";

const REPO = resolve(import.meta.dirname, "..");
const GOLDEN = join(import.meta.dirname, "golden");
const UPDATE = process.env.GOLDEN_UPDATE === "1";
const bin = l10nBinary(REPO);
const skip = bin ? false : "rust-l10n не собран (npm run l10n:build)";

let tmp: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  tmp = mkdtempSync(join(REPO, "tmp", "golden-"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

/** Прогнать `rust-l10n`, вернуть stdout (CRLF → LF). */
function rust(args: string[]): string {
  const run = spawnSync(bin as string, args, { encoding: "utf8" });
  assert.equal(run.status, 0, `rust-l10n ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.replace(/\r\n/g, "\n");
}

/** Сравнить байты с закоммиченным слепком (или обновить его). */
function expectGolden(name: string, actual: Buffer | string, what: string): void {
  const path = join(GOLDEN, name);
  if (UPDATE) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, actual);
    console.log(`GOLDEN_UPDATE: ${name}`);
    return;
  }
  assert.ok(existsSync(path), `нет слепка ${name}: GOLDEN_UPDATE=1 npm run test:golden`);
  const expected = typeof actual === "string" ? readFileSync(path, "utf8") : readFileSync(path);
  assert.deepEqual(actual, expected, `${what}: выход не совпал со слепком ${name}`);
}

test("слепок po2dat: .dat из фикстуры (rich, перевод, legacy)", { skip }, () => {
  const dir = join(tmp, "po2dat");
  cpSync(join(GOLDEN, "po2dat"), dir, { recursive: true });
  const out = join(dir, "patch_ru.dat");
  rust(["po2dat", "ru", "--root", dir, "--out", out]);
  expectGolden("patch_ru.dat", readFileSync(out), "po2dat");
});

test("слепок find_source: вывод провенанса на мини-дампе", { skip }, () => {
  const dump = join(REPO, ".opencode", "skills", "extract-text", "test_data", "tiny-dump");
  const queries = ["Where are you going now, my dear friend?", "Zoey", "Dialogue Log"];
  const out = queries.map((q) => `# ${q}\n${rust(["find_source", q, "--dump", dump])}`).join("");
  expectGolden("find_source.txt", out, "find_source");
});

test("слепок prefill: <lang>.po после переноса переводов", { skip }, () => {
  const dir = join(tmp, "prefill");
  cpSync(join(GOLDEN, "prefill"), dir, { recursive: true });
  rust(["prefill", "ru", "--po-dir", join(dir, "po"), "--created", "2026-01-02 03:04+0000"]);
  expectGolden("prefill_ru.po", readFileSync(join(dir, "po", "ru.po"), "utf8"), "prefill");
});
