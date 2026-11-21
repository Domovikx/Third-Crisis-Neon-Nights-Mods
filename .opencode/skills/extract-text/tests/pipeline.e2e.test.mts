/**
 * E2E пайплайна: мини-дамп → potgen.mts → template.pot → po2dat.mts → .dat.
 *
 * Доказывает, что два портированных модуля стыкуются: rich_text из POT
 * доходит до словаря рантайма, а переводы из PO попадают в строки.
 * Сеть и игра не нужны; дамп — маленький коммитимый фикстур.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildDat, writeDat } from "../scripts/po2dat.mts";
import { runPotgen } from "../scripts/potgen.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
const FIXTURE = join(import.meta.dirname, "..", "test_data", "tiny-dump");
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

test("E2E: дамп → POT → DAT, rich и переводы доходят до словаря", async () => {
  mkdirSync(join(root, "po"), { recursive: true });
  writeFileSync(join(root, "po", "xx.po"), XX_PO, "utf8");

  const pot = await runPotgen({
    dumpDir: FIXTURE,
    outPath: join(root, "po", "template.pot"),
    created: "2026-01-02 03:04+0000",
  });
  assert.equal(pot.entries, 10);
  assert.ok(existsSync(join(root, "po", "template.pot")));

  const { rows, report } = buildDat("xx", root);
  assert.equal(report.poEntries, 2);

  const dat = join(root, "runtime", "patch_xx.dat");
  writeDat(rows, dat);
  const lines = rows.map((r) => JSON.stringify(r));

  assert.deepEqual(rows, [
    {
      t: "Welcome back, Sarah.",
      x: "С возвращением, Сара.",
      r: "<color=#EB83FF>Welcome back, Sarah.</color>",
    },
    { t: "Dialogue Log", x: "Журнал диалогов" },
  ]);
  assert.equal(lines.length, 2);
});
