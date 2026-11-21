/**
 * Тесты компилятора PO → DAT. Паритет с `po2dat.test.py`:
 * rich из шаблона, дубликаты, гейт авто-нормализации, legacy-флаг, rt-оверрайд.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildDat, loadPotRich, writeDat } from "../scripts/po2dat.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "po2dat-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Раскладка <dir>/po/{template.pot,xx.po} для одного теста. */
function fixture(name: string, pot: string, po: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "po"), { recursive: true });
  writeFileSync(join(dir, "po", "template.pot"), pot, "utf8");
  writeFileSync(join(dir, "po", "xx.po"), po, "utf8");
  return dir;
}

const HEADER = 'msgid ""\nmsgstr ""\n';

test("buildDat: rich_text из шаблона подставляется в строку", () => {
  const dir = fixture(
    "rich",
    `${HEADER}\n#. rich_text: <color=#EB83FF>Yesss...!~</color>\nmsgid "Yesss...!~"\nmsgstr ""\n`,
    `${HEADER}\nmsgid "Yesss...!~"\nmsgstr "Да-а-а...!~"\n`,
  );

  const { rows, report } = buildDat("xx", dir);
  assert.deepEqual(rows, [
    { t: "Yesss...!~", x: "Да-а-а...!~", r: "<color=#EB83FF>Yesss...!~</color>" },
  ]);
  assert.equal(report.filled, 1);
  assert.equal(report.noRich, 0);
});

test("buildDat: без перевода и без rich строки нет в словаре", () => {
  const dir = fixture("empty", HEADER, `${HEADER}\nmsgid "Nope"\nmsgstr ""\n`);
  const { rows } = buildDat("xx", dir);
  assert.deepEqual(rows, []);
});

test("buildDat: rich-only строка попадает с пустым переводом", () => {
  const dir = fixture(
    "richonly",
    `${HEADER}\n#. rich_text: <color=#fff>Styled</color>\nmsgid "Styled"\nmsgstr ""\n`,
    `${HEADER}\nmsgid "Styled"\nmsgstr ""\n`,
  );

  const { rows, report } = buildDat("xx", dir);
  assert.deepEqual(rows, [{ t: "Styled", x: "", r: "<color=#fff>Styled</color>" }]);
  assert.equal(report.richOnly, 1);
});

test("buildDat: дубликаты разрешаются earliest-ref-file-wins", () => {
  const dir = fixture(
    "dupes",
    HEADER,
    `${HEADER}\n#: translations/b.yaml\nmsgid "Hi"\nmsgstr "B"\n\n#: translations/a.yaml\nmsgid "Hi"\nmsgstr "A"\n`,
  );

  const { rows, report } = buildDat("xx", dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].x, "A");
  assert.equal(report.dupes.length, 1);
  assert.equal(report.dupes[0][0], "Hi");
});

test("buildDat: авто-нормализованное ждёт человека и не уезжает", () => {
  const dir = fixture("gated", HEADER, `${HEADER}\n#, auto-normalized\nmsgid "X"\nmsgstr "Икс"\n`);

  const { rows, report } = buildDat("xx", dir);
  assert.deepEqual(rows, []);
  assert.equal(report.gatedAutoNormalized, 1);
});

test("buildDat: legacy-флаг даёт sk, `# rich:` даёт rt", () => {
  const dir = fixture(
    "flags",
    `${HEADER}\n#. rich_text: <color=#fff>Hi</color>\nmsgid "Hi"\nmsgstr ""\n`,
    `${HEADER}\n# rich: <color=#fff>Привет</color>\n#, legacy\nmsgid "Hi"\nmsgstr "Привет"\n`,
  );

  const { rows } = buildDat("xx", dir);
  assert.deepEqual(rows, [
    {
      t: "Hi",
      x: "Привет",
      r: "<color=#fff>Hi</color>",
      rt: "<color=#fff>Привет</color>",
      sk: true,
    },
  ]);
});

test("loadPotRich: первый rich_text для текста побеждает", () => {
  const dir = fixture(
    "potwins",
    `${HEADER}\n#. rich_text: <color=#111>first</color>\nmsgid "T"\nmsgstr ""\n\n#. rich_text: <color=#222>second</color>\nmsgid "T"\nmsgstr ""\n`,
    `${HEADER}\nmsgid "T"\nmsgstr "Т"\n`,
  );

  const rich = loadPotRich(dir);
  assert.equal(rich.get("T"), "<color=#111>first</color>");
});

test("buildDat: отсутствующий po — понятная ошибка", () => {
  const dir = fixture("missing", HEADER, HEADER);
  assert.throws(() => buildDat("zz", dir), /missing .*zz\.po/);
});

test("writeDat: один JSON-объект на строку, читается обратно", () => {
  const dir = fixture("write", HEADER, `${HEADER}\nmsgid "Hi"\nmsgstr "Привет"\n`);
  const { rows } = buildDat("xx", dir);
  const out = join(dir, "runtime", "patch_xx.dat");

  writeDat(rows, out);
  const text = readFileSync(out, "utf8");
  assert.ok(text.endsWith("\n"));
  const lines = text.trim().split("\n");
  assert.equal(lines.length, rows.length);
  assert.deepEqual(JSON.parse(lines[0]), rows[0]);
});
