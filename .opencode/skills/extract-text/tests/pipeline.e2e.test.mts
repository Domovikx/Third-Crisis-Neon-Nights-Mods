/**
 * E2E пайплайна: мини-дамп → `rust-l10n potgen` → template.pot →
 * `rust-l10n po2dat` → .dat.
 *
 * Доказывает, что два модуля стыкуются на файлах: rich_text из POT доходит до
 * словаря рантайма, переводы из PO попадают в строки. Обе команды — рабочая
 * Rust-реализация (TS-эталоны удалены, см. `docs/rust-vs-ts.md`), поэтому
 * тест переживёт удаление `potgen.mts`. Сеть и игра не нужны; дамп — маленький
 * коммитимый фикстур.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { l10nBinary } from "../../../../scripts/text_cli.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
const FIXTURE = join(import.meta.dirname, "..", "test_data", "tiny-dump");
const bin = l10nBinary(REPO);
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "pot-e2e-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

const XX_PO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Welcome back, Sarah."
msgstr "С возвращением, Сара."

msgid "Dialogue Log"
msgstr "Журнал диалогов"
`;

function rust(args: string[]): void {
  const run = spawnSync(bin as string, args, { encoding: "utf8" });
  assert.equal(run.status, 0, `rust-l10n ${args.join(" ")}: ${run.stderr}`);
}

test(
  "E2E: дамп → POT → DAT, rich и переводы доходят до словаря",
  { skip: bin ? false : "rust-l10n не собран (npm run l10n:build)" },
  () => {
    mkdirSync(join(root, "po"), { recursive: true });
    writeFileSync(join(root, "po", "xx.po"), XX_PO, "utf8");

    rust([
      "potgen",
      "--root",
      root,
      "--dump",
      FIXTURE,
      "--out",
      join(root, "po", "template.pot"),
      "--created",
      "2026-01-02 03:04+0000",
    ]);
    assert.ok(existsSync(join(root, "po", "template.pot")));

    const dat = join(root, "runtime", "patch_xx.dat");
    rust(["po2dat", "xx", "--root", root, "--out", dat]);

    const rows = readFileSync(dat, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.deepEqual(rows, [
      {
        t: "Welcome back, Sarah.",
        x: "С возвращением, Сара.",
        r: "<color=#EB83FF>Welcome back, Sarah.</color>",
      },
      { t: "Dialogue Log", x: "Журнал диалогов" },
    ]);
  },
);
