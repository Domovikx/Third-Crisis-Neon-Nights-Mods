/**
 * text_parity.test.mts — POT рабочего Rust-генератора против ЗОЛОТА.
 *
 * TS-эталоны `potgen.mts`/`po_update.mts` удалены 2026-11-24 (решение
 * владельца: «всё TS-легаси выпиливаем»). Оракул теперь — золотые слепки,
 * снятые с TS-эталона ДО удаления:
 *   - `test_data/pot-golden-small.pot` — POT мини-дампа `test_data/tiny-dump`
 *     (фикстура коммитится, воспроизводимо в любом окружении);
 *   - `po/template.pot` — полный POT (18 445 записей), хэш и счётчики в
 *     `test_data/pot-golden.json`; перегенерация сверяется при наличии дампа
 *     (`TCNN_DUMP_DIR` или `tmp/dump-after`).
 *
 * `po_update` стережёт свой слепок `test_data/po-update-golden/` (см.
 * `.opencode/skills/extract-text/tests/po_update.test.mts`).
 *
 * Без собранного `rust-l10n` тесты пропускаются: `npm run l10n:build`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { l10nBinary } from "./text_cli.mts";

const REPO = resolve(import.meta.dirname, "..");
const DATA = join(REPO, ".opencode", "skills", "extract-text", "test_data");
const GOLDEN_JSON = join(DATA, "pot-golden.json");
const CREATED = "2026-01-02 03:04+0000";

const bin = l10nBinary(REPO);
const skip = bin ? false : "rust-l10n не собран (npm run l10n:build)";

interface GoldenMeta {
  full: { path: string; bytes: number; entries: number; sha256: string; created: string };
  small: { path: string; bytes: number; entries: number; sha256: string; created: string };
}

const meta = JSON.parse(readFileSync(GOLDEN_JSON, "utf8")) as GoldenMeta;

let tmp: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  tmp = mkdtempSync(join(REPO, "tmp", "text-parity-"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function rust(args: string[]): void {
  const run = spawnSync(bin as string, args, { encoding: "utf8" });
  assert.equal(run.status, 0, `rust-l10n ${args.join(" ")}: ${run.stderr}`);
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

const countEntries = (text: string): number =>
  text.split("\n").filter((line) => line.startsWith('msgid "')).length - 1;

/** Сравнить два POT побайтово, не считая даты создания. */
function assertSamePot(actual: string, expected: string, what: string): void {
  const dropDate = (text: string): string =>
    text
      .split("\n")
      .filter((line) => !line.includes("POT-Creation-Date:"))
      .join("\n");
  assert.deepEqual(dropDate(actual), dropDate(expected), `${what}: POT разошёлся`);
}

test("золото полного POT: хэш, размер и число записей из pot-golden.json", () => {
  const potPath = join(REPO, meta.full.path);
  assert.ok(existsSync(potPath), `нет ${meta.full.path}`);
  const bytes = readFileSync(potPath);
  assert.equal(bytes.byteLength, meta.full.bytes, "размер POT");
  assert.equal(sha256(bytes), meta.full.sha256, "sha256 POT");
  assert.equal(countEntries(bytes.toString("utf8")), meta.full.entries, "число записей");
});

test("золото мини-POT: хэш и число записей pot-golden-small.pot", () => {
  const smallPath = join(DATA, "pot-golden-small.pot");
  const bytes = readFileSync(smallPath);
  assert.equal(bytes.byteLength, meta.small.bytes);
  assert.equal(sha256(bytes), meta.small.sha256);
  assert.equal(countEntries(bytes.toString("utf8")), meta.small.entries);
});

test("Rust potgen == золото мини-дампа: байт-в-байт", { skip }, () => {
  const dump = join(DATA, "tiny-dump");
  const out = join(tmp, "tiny-rust.pot");
  rust([
    "potgen",
    "--root",
    tmp,
    "--dump",
    dump,
    "--out",
    out,
    "--created",
    meta.small.created,
    "--no-policy",
    "--no-skip-policy",
    "--no-skip-ids",
    "--no-emotions",
  ]);
  const actual = readFileSync(out);
  assert.equal(actual.byteLength, meta.small.bytes, "размер POT");
  assert.equal(sha256(actual), meta.small.sha256, "sha256 POT");
  assertSamePot(
    actual.toString("utf8"),
    readFileSync(join(DATA, "pot-golden-small.pot"), "utf8"),
    "мини-дамп",
  );
});

/** Дамп, из которого собран `po/template.pot`: сначала актуальный. */
const dumpDir =
  process.env.TCNN_DUMP_DIR ??
  ["tmp/dump-after", "tmp/dump-new", "tmp/dump"]
    .map((rel) => join(REPO, rel))
    .find((dir) => existsSync(dir)) ??
  "";
const dumpSkip = dumpDir ? false : "нет реального дампа (TCNN_DUMP_DIR или tmp/dump-after)";

test(
  "Rust potgen на реальном дампе == po/template.pot (кроме даты)",
  { skip: skip || dumpSkip },
  () => {
    const out = join(tmp, "real-rust.pot");
    rust(["potgen", "--root", REPO, "--dump", dumpDir, "--out", out, "--created", CREATED]);
    const actual = readFileSync(out, "utf8");
    const gold = readFileSync(join(REPO, "po", "template.pot"), "utf8");
    assertSamePot(actual, gold, "реальный дамп");
    assert.equal(countEntries(actual), meta.full.entries, "число записей");
  },
);
