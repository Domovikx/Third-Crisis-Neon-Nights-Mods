/**
 * Поведение правил QA на Rust-движке (`tools/rust-qa`) — построчные фикстуры.
 *
 * Это порт тестов удалённого TS-эталона: те же 6 правил и те же исключения
 * (legacy / no-translate / skip), но проверяется единственный оставшийся движок.
 * Крупный корпус стережёт золотой отчёт (`qa_golden.test.mts`), здесь — граничные
 * случаи, которых в реальных данных нет или мало (дубли PO, `<font>`-фильтр).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { REPO_ROOT } from "../../../../scripts/languages.mts";
import { rustQaBinary } from "../../../../scripts/qa.mts";

const bin = rustQaBinary(REPO_ROOT);
const skip = bin ? false : "rust-qa не собран (npm run qa:build)";
mkdirSync(join(REPO_ROOT, "tmp"), { recursive: true }); // под mkdtemp

interface Report {
  lang: string;
  summary: {
    total: number;
    filled: number;
    errors: number;
    warnings: number;
    by_speaker: Array<[string, { filled: number; total: number }]>;
    by_dir: Array<[string, { filled: number; total: number }]>;
  };
  findings: Array<{ level: string; rule: string; rel: string; text: string; detail: string }>;
}

/** Временная раскладка `<root>/{po,runtime}`; чистится после теста. */
function fixture(pot: string, dat: string, po?: string, lang = "ru"): string {
  const dir = mkdtempSync(join(REPO_ROOT, "tmp", "qa-rules-"));
  mkdirSync(join(dir, "po"), { recursive: true });
  mkdirSync(join(dir, "runtime"), { recursive: true });
  writeFileSync(join(dir, "po", "template.pot"), pot, "utf8");
  writeFileSync(join(dir, "runtime", `patch_${lang}.dat`), dat, "utf8");
  if (po !== undefined) writeFileSync(join(dir, "po", `${lang}.po`), po, "utf8");
  return dir;
}

/** Прогон `rust-qa` на раскладке: отчёт + код выхода. */
function run(dir: string, lang = "ru"): { status: number | null; report: Report } {
  const out = join(dir, "report.json");
  const res = spawnSync(bin as string, ["--root", dir, "--lang", lang, "--json", out, "--quiet"], {
    stdio: "ignore",
  });
  return { status: res.status, report: JSON.parse(readFileSync(out, "utf8")) as Report };
}

function withFixture<T>(pot: string, dat: string, fn: (dir: string) => T, po?: string): T {
  const dir = fixture(pot, dat, po);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const POT_THREE = `#: translations/dialogues/1.yaml [dlg:1#0]
msgctxt "speaker:Z"
msgid "Hi"
msgstr ""

#: translations/dialogues/1.yaml [dlg:1#1]
msgctxt "speaker:Z"
msgid "Bye"
msgstr ""

#: translations/raw/a.yaml [raw:a#0]
msgctxt "ui"
msgid "Ok"
msgstr ""
`;

test("copy-through в диалоге — error, legacy-строка исключена", { skip }, () => {
  const dat =
    [
      JSON.stringify({ t: "Hi", x: "Привет", r: "<b>Hi</b>", rt: "<b>Привет</b>" }),
      JSON.stringify({ t: "Bye", x: "Bye" }),
      JSON.stringify({ t: "Ok", x: "Ok", sk: true }),
    ].join("\n") + "\n";
  withFixture(POT_THREE, dat, (dir) => {
    const { status, report } = run(dir);
    assert.equal(report.summary.total, 3);
    assert.equal(report.summary.filled, 3, "legacy-триаж тоже считается заполненным");
    assert.equal(status, 1, "есть errors -> код 1");
    const copy = report.findings.filter((f) => f.rule === "copy-through").map((f) => f.text);
    assert.deepEqual(copy, ["Bye"], "legacy-строка освобождена от проверки");
    assert.ok(!report.findings.some((f) => f.rule === "empty-dialogue"));
    const dirs = Object.fromEntries(report.summary.by_dir);
    assert.equal(dirs.dialogues?.total, 2);
    assert.equal(dirs.raw?.total, 1, "папка берётся из refs translations/");
    const spk = Object.fromEntries(report.summary.by_speaker);
    assert.equal(spk.Z?.total, 2);
  });
});

test("пустой перевод в диалоге — error, пустой ui — нет", { skip }, () => {
  const pot = `#: [dlg:1#0]
msgctxt "speaker:Z"
msgid "Hi"
msgstr ""

#: [raw:a#0]
msgctxt "ui"
msgid "Ok"
msgstr ""
`;
  withFixture(pot, "", (dir) => {
    const { report } = run(dir);
    assert.equal(report.summary.filled, 0);
    const empty = report.findings.filter((f) => f.rule === "empty-dialogue").map((f) => f.text);
    assert.deepEqual(empty, ["Hi"], "ui-строка не диалог");
    assert.equal(report.summary.errors, 1);
  });
});

test("no-translate исключает строку из правил", { skip }, () => {
  const pot = `#: [dlg:1#0]
#. triage: manual
#, no-translate
msgctxt "speaker:Z"
msgid "...!"
msgstr ""
`;
  withFixture(pot, "", (dir) => {
    const { status, report } = run(dir);
    assert.equal(report.summary.errors, 0);
    assert.equal(status, 0, "нет errors -> код 0");
    assert.ok(!report.findings.some((f) => f.rule === "empty-dialogue"));
  });
});

test("`#, skip` не считается пустым диалогом (решение potgen)", { skip }, () => {
  const pot = `#. src: raw:MonoBehaviour
#. skip: short-token
#, skip
msgctxt "speaker:Z"
msgid "wK Ax"
msgstr ""

#: [dlg:1#0]
msgctxt "speaker:Z"
msgid "Hi"
msgstr ""
`;
  withFixture(pot, "", (dir) => {
    const { report } = run(dir);
    assert.equal(report.summary.total, 2);
    const empty = report.findings.filter((f) => f.rule === "empty-dialogue").map((f) => f.text);
    assert.deepEqual(empty, ["Hi"], "skip-строка из правил исключена, обычная — нет");
    assert.equal(report.summary.errors, 1);
  });
});

test("дисбаланс rich-тегов (r vs rt) — error, совпадение — молчит", { skip }, () => {
  const pot = `#: [dlg:1#0]
msgctxt "speaker:Z"
msgid "Ok"
msgstr ""

#: [dlg:1#1]
msgctxt "speaker:Z"
msgid "Fine"
msgstr ""
`;
  const dat =
    [
      JSON.stringify({
        t: "Ok",
        x: "Ладно",
        r: "<color=#fff>Ok</color>",
        rt: "<color=#fff>Ладно</color>",
      }),
      JSON.stringify({ t: "Fine", x: "Хорошо", r: "<b>Fine</b>", rt: "<b>Хорошо" }),
    ].join("\n") + "\n";
  withFixture(pot, dat, (dir) => {
    const { report } = run(dir);
    const tags = report.findings.filter((f) => f.rule === "tag-imbalance");
    assert.equal(tags.length, 1, "сбалансированная пара не флагается");
    assert.equal(tags[0].text, "Fine");
    assert.equal(tags[0].detail, "<b>,</b> vs <b>", "детали — имена тегов через запятую");
  });
});

test("<font>/<material> не считаются дисбалансом (шрифт выбирает рантайм)", { skip }, () => {
  const pot = `msgctxt "speaker:Z"
msgid "Hi"
msgstr ""
`;
  // Реальный случай: в `rt` остался <font> из старых `# rich:`-оверрайдов, в `r` его нет.
  const dat =
    JSON.stringify({
      t: "Hi",
      x: "Привет",
      r: "<i><color=#B867FF>Hi</color></i>",
      rt: '<i><color=#B867FF><font="Roboto-Condensed_DialogueUI" material="Perversion">Привет</font></color></i>',
    }) + "\n";
  withFixture(pot, dat, (dir) => {
    const { report } = run(dir);
    assert.deepEqual(
      report.findings.filter((f) => f.rule === "tag-imbalance"),
      [],
      "разница только в <font> не должна флагаться",
    );
  });
});

test("латиница в RU — warning только для ru и при коротком переводе молчит", { skip }, () => {
  const pot = `#: [dlg:1#0]
msgctxt "speaker:Z"
msgid "Long"
msgstr ""

#: [dlg:1#1]
msgctxt "speaker:Z"
msgid "Short"
msgstr ""
`;
  const dat =
    [
      JSON.stringify({ t: "Long", x: "Hello darkness my old friend" }),
      JSON.stringify({ t: "Short", x: "Hello" }), // <= 10 символов — не проверяем
    ].join("\n") + "\n";
  withFixture(pot, dat, (dir) => {
    const { report } = run(dir);
    const latin = report.findings.filter((f) => f.rule === "latin-leftover");
    assert.deepEqual(
      latin.map((f) => f.text),
      ["Long"],
    );
    assert.equal(report.summary.warnings, 1);
    // Ищем patch_de.dat — его нет: переводов нет, латиницы тоже.
    const deDir = fixture(pot, dat);
    try {
      assert.equal(run(deDir, "de").report.summary.warnings, 0, "de не проверяет латиницу");
    } finally {
      rmSync(deDir, { recursive: true, force: true });
    }
  });
});

test("дубли (msgid, msgctxt) с разным msgstr в po — error", { skip }, () => {
  const pot = `msgctxt "speaker:Z"
msgid "Hi"
msgstr ""
`;
  const po = `msgctxt "speaker:Z"
msgid "Hi"
msgstr "Привет"

msgctxt "speaker:Z"
msgid "Hi"
msgstr "Здравствуй"
`;
  withFixture(
    pot,
    JSON.stringify({ t: "Hi", x: "Привет" }) + "\n",
    (dir) => {
      const { report } = run(dir);
      const dupes = report.findings.filter((f) => f.rule === "duplicate-po");
      assert.equal(dupes.length, 1);
      assert.equal(dupes[0].rel, "po/ru.po");
      assert.equal(dupes[0].text, "Hi");
      assert.equal(dupes[0].detail, 'speaker:Z: ["Здравствуй","Привет"]');
    },
    po,
  );
});

test(".dat: первая строка побеждает; без .dat переводов нет", { skip }, () => {
  const pot = `msgctxt "speaker:Z"
msgid "Hi"
msgstr ""
`;
  // Если победит ВТОРАЯ строка, перевод совпадёт с оригиналом -> copy-through.
  const dat = `{not json}\n${JSON.stringify({ t: "Hi", x: "Привет" })}\n${JSON.stringify({ t: "Hi", x: "Hi" })}\n`;
  withFixture(pot, dat, (dir) => {
    const { report } = run(dir);
    assert.equal(report.summary.filled, 1);
    assert.ok(
      !report.findings.some((f) => f.rule === "copy-through"),
      "первая строка .dat — истина",
    );
  });
  withFixture(pot, "", (dir) => {
    const { report } = run(dir);
    assert.equal(report.summary.filled, 0, "нет .dat — пустая карта");
    assert.equal(report.summary.errors, 1, "и диалог виден как пустой");
  });
});
