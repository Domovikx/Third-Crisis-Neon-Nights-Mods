/**
 * assemble_parity.test.mts — Rust-ассемблер дампа против ЗОЛОТЫХ фикстур.
 *
 * Золото снято с TS-эталона перед его удалением (2026-11-24, решение
 * владельца «всё TS-легаси выпиливаем»). Оракул теперь — байты, а не второй
 * исполнитель:
 *
 *   - `test_data/assemble-golden-small/` — весь каталог дампа на маленьком rd1
 *     (фикстура рядом: `test_data/assemble-fixture-smoke2.rd1.jsonl`, 183 КБ);
 *   - `test_data/assemble-golden-full.json` — SHA-256 всех файлов полного дампа
 *     (149 файлов, только имена + хэши).
 *
 * Маленький прогон идёт всегда (быстрый, без игры). Полный — под
 * `TCNN_FULL_GOLDEN=1`; rd1 берётся из `TCNN_RD1` или `tmp/raw/dump.rd1.jsonl`
 * (523 МБ, в git его нет).
 *
 * Обновление золота — команды в `.opencode/skills/dump-assets/SKILL.md`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { l10nBinary } from "./text_cli.mts";

const REPO = resolve(import.meta.dirname, "..");
const TEST_DATA = join(REPO, ".opencode", "skills", "dump-assets", "test_data");
const GOLDEN_SMALL = join(TEST_DATA, "assemble-golden-small");
const GOLDEN_FULL = join(TEST_DATA, "assemble-golden-full.json");

const binary = l10nBinary(REPO);
const noBinary = binary === null ? "rust-l10n не собран (npm run l10n:build)" : false;

/** rd1 маленькой фикстуры: env → git-фикстура → рабочий `tmp/`. */
function smallFixture(): string | null {
  const explicit = process.env.TCNN_RD1;
  if (explicit && existsSync(explicit)) return resolve(explicit);
  const candidates = [
    join(TEST_DATA, "assemble-fixture-smoke2.rd1.jsonl"),
    join(REPO, "tmp", "raw", "dump-limit-smoke2.rd1.jsonl"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** rd1 полного дампа: env → `tmp/raw/dump.rd1.jsonl`. */
function fullFixture(): string | null {
  const explicit = process.env.TCNN_RD1;
  if (explicit && existsSync(explicit)) return resolve(explicit);
  const fallback = join(REPO, "tmp", "raw", "dump.rd1.jsonl");
  return existsSync(fallback) ? fallback : null;
}

/** Прогнать `rust-l10n dump_assemble` в свежий каталог и вернуть его путь. */
function assemble(rd1: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tcnn-assemble-"));
  const run = spawnSync(binary as string, ["dump_assemble", rd1, dir, "--json"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr?.slice(0, 400));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const sha256 = (body: Buffer): string => createHash("sha256").update(body).digest("hex");

test(
  "assemble: маленький rd1 — байты совпадают с золотом",
  { skip: noBinary || smallFixture() === null ? noBinary || "нет rd1-фикстуры" : false },
  () => {
    const { dir, cleanup } = assemble(smallFixture() as string);
    try {
      const expected = readdirSync(GOLDEN_SMALL).sort();
      const actual = readdirSync(dir).sort();
      assert.deepEqual(actual, expected, "состав файлов дампа разошёлся с золотом");

      for (const name of expected) {
        const want = readFileSync(join(GOLDEN_SMALL, name));
        const got = readFileSync(join(dir, name));
        if (want.equals(got)) continue;
        let at = 0;
        while (at < want.length && at < got.length && want[at] === got[at]) at += 1;
        assert.fail(
          `${name}: расхождение на байте ${at}\n` +
            `золото: ${JSON.stringify(want.subarray(Math.max(0, at - 60), at + 80).toString())}\n` +
            `Rust  : ${JSON.stringify(got.subarray(Math.max(0, at - 60), at + 80).toString())}`,
        );
      }
    } finally {
      cleanup();
    }
  },
);

test(
  "assemble: полный rd1 — SHA-256 совпадают с золотом (TCNN_FULL_GOLDEN=1)",
  {
    skip:
      noBinary ||
      process.env.TCNN_FULL_GOLDEN !== "1" ||
      fullFixture() === null ||
      !existsSync(GOLDEN_FULL)
        ? noBinary ||
          (process.env.TCNN_FULL_GOLDEN !== "1"
            ? "полный прогон только с TCNN_FULL_GOLDEN=1"
            : "нет полного rd1 (TCNN_RD1 или tmp/raw/dump.rd1.jsonl)")
        : false,
  },
  () => {
    const golden = JSON.parse(readFileSync(GOLDEN_FULL, "utf8")) as Record<string, string>;
    const { dir, cleanup } = assemble(fullFixture() as string);
    try {
      const actual = readdirSync(dir).sort();
      const expected = Object.keys(golden).sort();
      assert.deepEqual(actual, expected, "состав файлов полного дампа разошёлся с золотом");

      const broken: string[] = [];
      for (const name of expected) {
        const want = golden[name];
        const got = sha256(readFileSync(join(dir, name)));
        if (got !== want) broken.push(`${name}: золото ${want}, Rust ${got}`);
      }
      assert.deepEqual(broken, [], `хэши разошлись с золотом:\n${broken.join("\n")}`);
    } finally {
      cleanup();
    }
  },
);
