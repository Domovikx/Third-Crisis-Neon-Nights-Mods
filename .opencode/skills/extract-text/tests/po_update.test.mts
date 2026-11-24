/**
 * Тесты `po_update` (перенос переводов в новый POT) — через рабочую
 * Rust-реализацию (`rust-l10n po_update`, обёртка `scripts/text_cli.mts`).
 *
 * TS-эталон `po_update.mts` удалён 2026-11-24. Золото (выход TS-эталона,
 * снятый до удаления) лежит в `test_data/po-update-golden/`: вход `po/`
 * (template.pot + ru.po) и ожидаемый `expected/ru.po`. Тест гоняет Rust на
 * копии входа и сравнивает байт-в-байт.
 *
 * Дополнительно правила проверяются на маленьких локальных фикстурах: шапка,
 * дубликаты ключа, `#, skip`, сироты, идемпотентность, `.bak`, ошибки CLI.
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
import process from "node:process";

import { parsePo } from "../scripts/po_file.mts";
import { l10nBinary } from "../../../../scripts/text_cli.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
const CLI = join(REPO, "scripts", "text_cli.mts");
const GOLDEN = join(import.meta.dirname, "..", "test_data", "po-update-golden");
const bin = l10nBinary(REPO);
const skip = bin ? false : "rust-l10n не собран (npm run l10n:build)";

let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "po-update-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Публичная обёртка Rust: `node scripts/text_cli.mts …`. */
function cli(args: string[], cwd = REPO): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });
  return { status: run.status, stderr: run.stderr };
}

/** Разложить фикстуру `template.pot` + `<lang>.po` в свежий каталог. */
function fixture(poText: string, potText: string, lang = "ru"): string {
  const dir = join(root, `case-${Math.random().toString(36).slice(2)}`, "po");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.pot"), potText, "utf8");
  writeFileSync(join(dir, `${lang}.po`), poText, "utf8");
  return dir;
}

function pot(entries: string[]): string {
  return `msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n${entries.join("\n\n")}\n`;
}

function po(
  entries: string[],
  header = '# RU\nmsgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"',
): string {
  return `${header}\n\n${entries.join("\n\n")}\n`;
}

function entry(msgid: string, msgstr = "", ctxt = "ui"): string {
  return `msgctxt "${ctxt}"\nmsgid "${msgid}"\nmsgstr "${msgstr}"`;
}

// ---------------------------------------------------------------------------
// Золото: выход TS-эталона, снятый 2026-11-24.
// ---------------------------------------------------------------------------

test("золото: Rust po_update байт-в-байт с expected/ru.po", { skip }, () => {
  const dir = join(root, "golden", "po");
  cpSync(join(GOLDEN, "po"), dir, { recursive: true });
  const report = join(root, "golden", "report.json");

  const run = cli(["po_update", "ru", "--po-dir", dir, "--json", report]);
  assert.equal(run.status, 0, run.stderr);

  assert.equal(
    readFileSync(join(dir, "ru.po"), "utf8"),
    readFileSync(join(GOLDEN, "expected", "ru.po"), "utf8"),
    "выход не совпал с золотом",
  );

  const expected = JSON.parse(
    readFileSync(join(GOLDEN, "expected", "stats.json"), "utf8"),
  ) as Record<string, unknown>;
  const actual = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;
  for (const field of ["carried", "new", "obsolete", "retargeted", "orphanDropped", "skipped"]) {
    assert.equal(actual[field], expected[field], `счётчик ${field}`);
  }
  const orphans = actual.orphanItems as Array<{ key: [string, string]; msgstr: string }>;
  assert.deepEqual(orphans, [{ key: ["Gone orphan", "ui"], msgstr: "Сирота" }]);
  assert.ok(existsSync(join(dir, "ru.po.bak")), "бэкап рядом с PO");
  assert.equal(existsSync(join(dir, "ru.po.part")), false, "атомарная запись без .part");
});

// ---------------------------------------------------------------------------
// Правила на маленьких фикстурах.
// ---------------------------------------------------------------------------

test("перенос существующего + новая пустая запись, refs/comments из POT", { skip }, () => {
  const dir = fixture(
    po([entry("A", "А")]),
    pot([`#. src: dialog\n${entry("A")}`, `#. src: dialog\n${entry("B")}`]),
  );
  const run = cli(["po_update", "ru", "--po-dir", dir]);
  assert.equal(run.status, 0, run.stderr);

  const back = parsePo(readFileSync(join(dir, "ru.po"), "utf8")).filter((e) => e.msgid);
  assert.deepEqual(
    back.map((e) => [e.msgid, e.msgstr, e.comments]),
    [
      ["A", "А", ["src: dialog"]],
      ["B", "", ["src: dialog"]],
    ],
    "перевод перенесён, refs-комментарии взяты из POT",
  );
});

test("ключ исчез из POT — перевод выпиливается (не legacy-сирота)", { skip }, () => {
  const dir = fixture(po([entry("A", "А"), entry("Gone", "Ушло")]), pot([entry("A")]));
  const report = join(root, "orphan-report.json");
  const run = cli(["po_update", "ru", "--po-dir", dir, "--json", report]);
  assert.equal(run.status, 0, run.stderr);

  const text = readFileSync(join(dir, "ru.po"), "utf8");
  assert.ok(!text.includes("Gone"), "сироты в выходном PO нет");
  assert.ok(!text.includes("#~"), "архивных блоков нет");
  const stats = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;
  assert.equal(stats.orphanDropped, 1);
  assert.deepEqual(
    (stats.orphanItems as Array<{ key: [string, string] }>).map((x) => x.key[0]),
    ["Gone"],
  );
});

test("ретаргет: перевод спасается при смене msgctxt", { skip }, () => {
  const dir = fixture(
    po([`# rich: <b>Иди</b>\n${entry("Go", "Иди")}`]),
    pot([entry("Go", "", "speaker:Zed")]),
  );
  const report = join(root, "retarget-report.json");
  const run = cli(["po_update", "ru", "--po-dir", dir, "--json", report]);
  assert.equal(run.status, 0, run.stderr);

  const back = parsePo(readFileSync(join(dir, "ru.po"), "utf8")).filter((e) => e.msgid);
  assert.deepEqual(
    back.map((e) => [e.msgid, e.msgctxt, e.msgstr]),
    [["Go", "speaker:Zed", "Иди"]],
  );
  assert.deepEqual(back[0].translator, ["rich: <b>Иди</b>"]);
  const stats = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;
  assert.equal(stats.retargeted, 1);
});

test("ключ вернулся в POT — протухший флаг legacy снимается", { skip }, () => {
  const dir = fixture(po([`#, legacy\n${entry("Back", "Вернулось")}`]), pot([entry("Back")]));
  const run = cli(["po_update", "ru", "--po-dir", dir]);
  assert.equal(run.status, 0, run.stderr);
  const back = parsePo(readFileSync(join(dir, "ru.po"), "utf8")).filter((e) => e.msgid);
  assert.equal(back[0].msgstr, "Вернулось");
  assert.deepEqual(back[0].flags, []);
});

test("auto-normalized не переезжает в новый POT", { skip }, () => {
  const dir = fixture(po([`#, fuzzy, auto-normalized\n${entry("A", "А")}`]), pot([entry("A")]));
  const run = cli(["po_update", "ru", "--po-dir", dir]);
  assert.equal(run.status, 0, run.stderr);
  const back = parsePo(readFileSync(join(dir, "ru.po"), "utf8")).filter((e) => e.msgid);
  assert.deepEqual(back[0].flags, ["fuzzy"]);
});

test("дубликаты msgid в PO — побеждает последний (как dict)", { skip }, () => {
  const dir = fixture(po([entry("A", "первый"), entry("A", "второй")]), pot([entry("A")]));
  const report = join(root, "dup-report.json");
  const run = cli(["po_update", "ru", "--po-dir", dir, "--json", report]);
  assert.equal(run.status, 0, run.stderr);
  const back = parsePo(readFileSync(join(dir, "ru.po"), "utf8")).filter((e) => e.msgid);
  assert.equal(back.length, 1);
  assert.equal(back[0].msgstr, "второй");
  const stats = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;
  assert.equal(stats.dupKeys, 1);
});

test("кавычки и \\n переживают merge + render + parse", { skip }, () => {
  const id = 'He said \\"hi\\"\\nbye';
  const tr = 'Он сказал \\"привет\\"\\nпока';
  const dir = fixture(po([entry(id, tr)]), pot([entry(id)]));
  const run = cli(["po_update", "ru", "--po-dir", dir]);
  assert.equal(run.status, 0, run.stderr);
  const text = readFileSync(join(dir, "ru.po"), "utf8");
  assert.ok(text.includes('msgid "He said \\"hi\\"\\nbye"'));
  const back = parsePo(text).filter((e) => e.msgid);
  assert.equal(back[0].msgid, 'He said "hi"\nbye');
  assert.equal(back[0].msgstr, 'Он сказал "привет"\nпока');
});

test("шапка переносится дословно (первый блок до пустой строки)", { skip }, () => {
  const header = '# RU\n# note\nmsgid ""\nmsgstr ""\n"Last-Translator: Я\\n"';
  const dir = fixture(po([entry("A", "А")], header), pot([entry("A")]));
  const run = cli(["po_update", "ru", "--po-dir", dir]);
  assert.equal(run.status, 0, run.stderr);
  const out = readFileSync(join(dir, "ru.po"), "utf8");
  assert.ok(out.startsWith(`${header}\n\n`), "шапка дословно");
});

test("`#, skip`: пустые и переведённые skip-строки в PO не заводятся", { skip }, () => {
  const skipEntry = (id: string): string =>
    `#. skip: short-token\n#, skip\nmsgctxt "ui"\nmsgid "${id}"\nmsgstr ""`;
  const dir = fixture(
    po([entry("kept-key", "уже есть")]),
    pot([skipEntry("junk-key"), entry("Normal line"), skipEntry("kept-key")]),
  );
  const report = join(root, "skip-report.json");
  const run = cli(["po_update", "ru", "--po-dir", dir, "--json", report]);
  assert.equal(run.status, 0, run.stderr);

  const out = readFileSync(join(dir, "ru.po"), "utf8");
  assert.ok(!out.includes("junk-key"), "пустого skip-ключа в PO нет");
  assert.ok(!out.includes("kept-key"), "переведённый skip-ключ тоже не попадает");
  assert.ok(!out.includes("уже есть"), "его перевод не тянется в PO");
  assert.ok(out.includes('msgid "Normal line"\nmsgstr ""'), "обычная строка на месте");
  assert.ok(!/#, skip/.test(out), "ни одной skip-метки в PO");
  const stats = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;
  assert.equal(stats.skipped, 2);
  assert.equal(stats.skipDropped, 0, "их ключи есть в POT — хвостом ничего не шло");
});

test("повторный прогон не меняет файл и не оставляет .part", { skip }, () => {
  const dir = fixture(po([entry("A", "А")]), pot([entry("A")]));
  assert.equal(cli(["po_update", "ru", "--po-dir", dir]).status, 0);
  const first = readFileSync(join(dir, "ru.po"), "utf8");
  assert.equal(cli(["po_update", "ru", "--po-dir", dir]).status, 0);
  assert.equal(readFileSync(join(dir, "ru.po"), "utf8"), first);
  assert.equal(existsSync(join(dir, "ru.po.part")), false);
});

test("отсутствующий PO — ошибка, файл не создаётся", { skip }, () => {
  const dir = fixture("", pot([entry("A")])); // заглушка, перезапишем ниже
  const noPoDir = join(root, "missing", "po");
  mkdirSync(noPoDir, { recursive: true });
  writeFileSync(join(noPoDir, "template.pot"), pot([entry("A")]), "utf8");

  const run = cli(["po_update", "ru", "--po-dir", noPoDir]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing/i);
  assert.equal(existsSync(join(noPoDir, "ru.po")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("--help — 0, неизвестный аргумент — 2", { skip }, () => {
  assert.equal(cli(["po_update", "--help"]).status, 0);
  assert.equal(cli(["po_update", "--bogus"]).status, 2);
});
