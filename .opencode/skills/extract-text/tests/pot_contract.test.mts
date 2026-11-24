/**
 * E2E контракта POT: дамп → `potgen` → `checkPot`.
 *
 * Проверяет то, что юнит-тесты проверить не могут: генератор и проверки
 * сходятся на живом входе (синтетический дамп в `tmp/`), битые строки дампа
 * не ломают ни генерацию, ни учёт, а повторный прогон байт-в-байтовый.
 *
 * Реальный дамп — opt-in: `TCNN_DUMP_DIR` или `tmp/dump-new`, если он есть
 * (в git данных игры нет). Паритет TS↔Rust здесь НЕ дублируется — он живёт
 * в `scripts/text_parity.test.mts` (мини-дамп + реальный дамп).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { checkPot, summarizePot } from "../../../../scripts/pot_invariants.mts";
import { parsePotText } from "../../../../scripts/pot_invariants.mts";
import { l10nBinary } from "../../../../scripts/text_cli.mts";
import { spawnSync } from "node:child_process";
import process from "node:process";

const REPO = resolve(import.meta.dirname, "../../../..");
const CREATED = "2026-01-02 03:04+0000";
const FIXTURE = join(import.meta.dirname, "..", "test_data", "tiny-dump");
const CLI = join(REPO, "scripts", "text_cli.mts");
const bin = l10nBinary(REPO);

let root: string;
before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "pot-contract-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

/** POT рабочей Rust-реализации (публичная обёртка `scripts/text_cli.mts`). */
function generatePot(dumpDir: string, outPath: string): void {
  const run = spawnSync(
    process.execPath,
    [CLI, "potgen", "--root", REPO, "--dump", dumpDir, "--out", outPath, "--created", CREATED],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`text_cli potgen: ${run.stderr}`);
}

/** Скопировать коммитимый mini-дамп в tmp (проверки не пишут в фикстуру). */
function copyFixture(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const file of ["level0.jsonl", "bundle_tiny_assets_all_abc123.jsonl", "summaries.jsonl"]) {
    writeFileSync(join(dir, file), readFileSync(join(FIXTURE, file), "utf8"), "utf8");
  }
  return dir;
}

function keysOf(text: string): string[] {
  return parsePotText(text)
    .entries.slice(1)
    .map((e) => JSON.stringify([e.fields.msgid?.value, e.fields.msgctxt?.value ?? ""]))
    .sort();
}

test(
  "E2E синтетика: дамп → POT → инварианты, нарушений нет",
  { skip: bin ? false : "rust-l10n не собран (npm run l10n:build)" },
  async () => {
    const dir = copyFixture("synthetic");
    const pot = join(dir, "template.pot");
    generatePot(dir, pot);
    const summary = summarizePot(readFileSync(pot, "utf8"));
    assert.ok(summary.entries > 0);

    const violations = await checkPot(pot, { dumpPath: dir });
    assert.deepEqual(violations, [], `нарушения: ${JSON.stringify(violations, null, 2)}`);

    assert.ok(summary.rich > 0, "rich_text из дампа доходит до POT");
  },
);

test(
  "E2E идемпотентность: повторный прогон не меняет файл",
  { skip: bin ? false : "rust-l10n не собран (npm run l10n:build)" },
  async () => {
    const dir = copyFixture("idempotent");
    const pot = join(dir, "template.pot");
    generatePot(dir, pot);
    const first = readFileSync(pot, "utf8");
    generatePot(dir, pot);
    const second = readFileSync(pot, "utf8");
    assert.equal(second, first);
    assert.deepEqual(await checkPot(pot, { dumpPath: dir }), []);
  },
);

test(
  "E2E устойчивость: битая JSONL-строка не роняет и не порождает записей",
  { skip: bin ? false : "rust-l10n не собран (npm run l10n:build)" },
  async () => {
    const clean = copyFixture("robust-clean");
    const cleanPot = join(clean, "template.pot");
    generatePot(clean, cleanPot);
    const expected = keysOf(readFileSync(cleanPot, "utf8"));

    const noisy = copyFixture("robust-noisy");
    const level = join(noisy, "level0.jsonl");
    // Обрезанная строка + не-объект + мусор посреди валидных строк.
    writeFileSync(
      level,
      `${readFileSync(level, "utf8")}{"asset": "level0", "dialogues": [\nnull\n0.5\n`,
      "utf8",
    );
    const noisyPot = join(noisy, "template.pot");
    generatePot(noisy, noisyPot);

    assert.deepEqual(keysOf(readFileSync(noisyPot, "utf8")), expected, "фантомных записей нет");
    const violations = await checkPot(noisyPot, { dumpPath: noisy });
    assert.equal(violations.filter((v) => v.severity === "error").length, 0);
    assert.ok(
      violations.some((v) => v.invariant === 13 && v.code === "dump-ignored-lines"),
      "битые строки должны попадать в отчёт (иначе потеря данных незаметна)",
    );
  },
);

// Дамп, из которого собран текущий po/template.pot: сначала актуальный (после снятия
// лимитов и политики), затем прежний. Переопределяется TCNN_DUMP_DIR.
const dumpDir =
  process.env.TCNN_DUMP_DIR ??
  (existsSync(join(REPO, "tmp", "dump-after"))
    ? join(REPO, "tmp", "dump-after")
    : join(REPO, "tmp", "dump-new"));
const potPath = join(REPO, "po", "template.pot");
const realSkip =
  existsSync(dumpDir) && existsSync(potPath)
    ? false
    : `нет реального дампа (${dumpDir}) или po/template.pot — opt-in тест`;

test(
  "E2E реальный дамп: po/template.pot проходит контракт (opt-in)",
  { skip: realSkip },
  async (t) => {
    // POT перегенерирован вместе с skip-политикой (2026-11-23), поэтому
    // проверка берёт политику по умолчанию: `#, skip` обязаны совпадать с
    // правилами, а перегенерация — с файлом.
    const violations = await checkPot(potPath, { dumpPath: dumpDir });
    const errors = violations.filter((v) => v.severity === "error");
    const warns = violations.filter((v) => v.severity === "warn");
    t.diagnostic(
      `POT ${summarizePot(readFileSync(potPath, "utf8")).entries} записей; ` +
        `ошибок ${errors.length}, предупреждений ${warns.length}: ${warns.map((v) => v.code).join(", ")}`,
    );
    // Известные дефекты ДАННЫХ (2026-11-22): перекрещенные теги в rich_text, чистка —
    // отдельная задача. Фиксируем класс и потолок, чтобы новые классы падали тестом,
    // а не «нормализовались» как фон.
    const knownErrors: Record<string, number> = {};
    const byCode = new Map<string, number>();
    for (const v of errors) byCode.set(v.code, (byCode.get(v.code) ?? 0) + 1);
    for (const [code, count] of byCode) {
      assert.ok(knownErrors[code] !== undefined, `новый класс ошибок: ${code}`);
      assert.ok(count <= knownErrors[code], `ошибок ${code} стало больше: ${count}`);
    }
    // Предупреждения — известные дефекты генерации (задачи pot-noise-cleanup и
    // отчёт 2026-11-22); новые коды должны появляться осознанно.
    const known = new Set([
      "order-dependent",
      "rich-counter",
      "noise-entries",
      "rich-nesting", // данные игры: незакрытые/перекрещенные теги в самом rich_text
      "rich-fragment", // данные игры: обрывки text=хвост rich_text (docs/pot-skip.md)
    ]);
    const unexpected = warns.filter((v) => !known.has(v.code));
    assert.deepEqual(
      unexpected,
      [],
      `новые предупреждения: ${JSON.stringify(unexpected, null, 2)}`,
    );
  },
);
