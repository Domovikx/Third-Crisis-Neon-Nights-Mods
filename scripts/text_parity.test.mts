/**
 * text_parity.test.mts — паритет Rust-генераторов против TS-эталонов.
 *
 * Гейт миграции (`tasks/2026-11-22-rust-text-core.md`, `docs/language-audit.md`):
 *   - `potgen`: POT байт-в-байт с `potgen.mts` (даты фиксируются `--created`);
 *   - `po2dat`: `.dat` байт-в-байт с `po2dat.mts` на всех языках репозитория.
 *
 * Без собранного `rust-l10n` тесты пропускаются (как `qa_parity.test.mts`):
 * сборка — `npm run l10n:build`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildDat, writeDat } from "../.opencode/skills/extract-text/scripts/po2dat.mts";
import { runPotgen } from "../.opencode/skills/extract-text/scripts/potgen.mts";

const REPO = resolve(import.meta.dirname, "..");
const CREATED = "2026-01-02 03:04+0000";

/** Собранный бинарь `rust-l10n` (Windows — .exe). */
function rustL10nBinary(root: string): string | null {
  const candidates = [
    join(root, "tools", "rust-l10n", "target", "release", "rust-l10n.exe"),
    join(root, "tools", "rust-l10n", "target", "release", "rust-l10n"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const bin = rustL10nBinary(REPO);
const skip = bin ? false : "rust-l10n не собран (npm run l10n:build)";

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

/** POT мини-дампа: одинаковый вход, разные реализации. */
test("паритет potgen на мини-дампе: POT байт-в-байт", { skip }, async () => {
  const dump = join(REPO, ".opencode", "skills", "extract-text", "test_data", "tiny-dump");
  const tsOut = join(tmp, "tiny-ts.pot");
  const rustOut = join(tmp, "tiny-rust.pot");

  await runPotgen({ dumpDir: dump, outPath: tsOut, created: CREATED });
  rust(["potgen", "--root", tmp, "--dump", dump, "--out", rustOut, "--created", CREATED]);

  assert.equal(readFileSync(rustOut, "utf8"), readFileSync(tsOut, "utf8"));
});

/** Пот-паритет на реальном дампе (нет дампа — тест пропускается). */
const dumpDir = process.env.TCNN_DUMP_DIR ?? join(REPO, "tmp", "dump-new");
const dumpSkip = !existsSync(dumpDir) ? `нет дампа ${dumpDir}` : false;

test(
  "паритет potgen на реальном дампе: template.pot байт-в-байт (кроме даты)",
  { skip: skip || dumpSkip },
  async () => {
    const tsOut = join(tmp, "real-ts.pot");
    const rustOut = join(tmp, "real-rust.pot");
    await runPotgen({ dumpDir, outPath: tsOut, created: CREATED });
    rust(["potgen", "--root", tmp, "--dump", dumpDir, "--out", rustOut, "--created", CREATED]);
    assert.ok(readFileSync(tsOut).byteLength > 0);
    assert.equal(readFileSync(rustOut, "utf8"), readFileSync(tsOut, "utf8"));
  },
);

/** Все языки репозитория: `.dat` байт-в-байт. */
const LANGS = ["de", "es", "fr", "it", "ja", "ko", "pl", "pt", "ru", "zh"];

for (const lang of LANGS) {
  test(`паритет po2dat на ${lang}: .dat байт-в-байт`, { skip }, () => {
    const tsOut = join(tmp, `ts-${lang}.dat`);
    const rustOut = join(tmp, `rust-${lang}.dat`);
    const { rows } = buildDat(lang, REPO);
    writeDat(rows, tsOut);
    rust(["po2dat", lang, "--root", REPO, "--out", rustOut]);
    assert.ok(existsSync(tsOut));
    assert.equal(readFileSync(rustOut, "utf8"), readFileSync(tsOut, "utf8"));
  });
}
