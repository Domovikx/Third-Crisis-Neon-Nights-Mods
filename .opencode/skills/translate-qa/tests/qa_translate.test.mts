/**
 * Тесты офлайн-QA перевода. Паритет с `qa_translate.test.py`:
 * copy-through, legacy-исключение, no-translate, кириллическая доля,
 * рендер дашборда. Плюс правила, которые в Python-версии были мёртвыми
 * (дубли в PO) и проверки de-раскладки.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  check,
  cyrRatio,
  loadDat,
  renderHtml,
  sourcedirOf,
  speakerOf,
} from "../scripts/qa_translate.mts";

const REPO = resolve(import.meta.dirname, "../../../..");

/** Временная раскладка `<root>/{po,runtime}`; чистится после теста. */
function fixture(name: string, pot: string, dat: string, po?: string): string {
  const root = mkdtempSync(join(REPO, "tmp", "qa-"));
  const dir = join(root, name);
  mkdirSync(join(dir, "po"), { recursive: true });
  mkdirSync(join(dir, "runtime"), { recursive: true });
  writeFileSync(join(dir, "po", "template.pot"), pot, "utf8");
  writeFileSync(join(dir, "runtime", "patch_ru.dat"), dat, "utf8");
  if (po !== undefined) writeFileSync(join(dir, "po", "ru.po"), po, "utf8");
  return dir;
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

function cleanup(dir: string): void {
  rmSync(resolve(dir, ".."), { recursive: true, force: true });
}

test("check: copy-through в диалоге — error, legacy-строка исключена", () => {
  const dir = fixture(
    "rules",
    POT_THREE,
    [
      JSON.stringify({ t: "Hi", x: "Привет", r: "<b>Hi</b>", rt: "<b>Привет</b>" }),
      JSON.stringify({ t: "Bye", x: "Bye" }),
      JSON.stringify({ t: "Ok", x: "Ok", sk: true }),
    ].join("\n") + "\n",
  );
  try {
    const { summary, findings } = check("ru", dir);
    assert.equal(summary.total, 3);
    assert.equal(summary.filled, 3); // legacy-триаж тоже считается заполненным
    const rules = findings.map((f) => f.rule);
    assert.ok(rules.includes("copy-through"), "Bye == Bye");
    assert.ok(!rules.includes("empty-dialogue"), "Hi заполнен, Bye — copy-through");
    const copyTexts = findings.filter((f) => f.rule === "copy-through").map((f) => f.text);
    assert.deepEqual(copyTexts, ["Bye"], "legacy-строка освобождена от проверки");
    assert.ok(summary.errors >= 1);
    assert.equal(summary.byDir.get("dialogues")?.total, 2);
    assert.equal(summary.byDir.get("raw")?.total, 1);
    assert.equal(summary.bySpeaker.get("Z")?.total, 2);
  } finally {
    cleanup(dir);
  }
});

test("check: пустой перевод в диалоге — error, пустой ui — нет", () => {
  const dir = fixture(
    "empty",
    `#: [dlg:1#0]
msgctxt "speaker:Z"
msgid "Hi"
msgstr ""

#: [raw:a#0]
msgctxt "ui"
msgid "Ok"
msgstr ""
`,
    "",
  );
  try {
    const { summary, findings } = check("ru", dir);
    assert.equal(summary.filled, 0);
    const empty = findings.filter((f) => f.rule === "empty-dialogue").map((f) => f.text);
    assert.deepEqual(empty, ["Hi"], "ui-строка не диалог");
    assert.equal(summary.errors, 1);
  } finally {
    cleanup(dir);
  }
});

test("check: no-translate исключает строку из правил", () => {
  const dir = fixture(
    "notranslate",
    `#: [dlg:1#0]
#. triage: manual
#, no-translate
msgctxt "speaker:Z"
msgid "...!"
msgstr ""
`,
    "",
  );
  try {
    const { summary, findings } = check("ru", dir);
    assert.equal(summary.errors, 0);
    assert.ok(!findings.some((f) => f.rule === "empty-dialogue"));
  } finally {
    cleanup(dir);
  }
});

test("check: дисбаланс rich-тегов (r vs rt) — error, совпадение — молчит", () => {
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
  const dir = fixture("tags", pot, dat);
  try {
    const { findings } = check("ru", dir);
    const tags = findings.filter((f) => f.rule === "tag-imbalance");
    assert.equal(tags.length, 1, "сбалансированная пара не флагается");
    assert.equal(tags[0].text, "Fine");
  } finally {
    cleanup(dir);
  }
});

test("check: <font>/<material> не считаются дисбалансом (шрифт выбирает рантайм)", () => {
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
  const dir = fixture("tags-font", pot, dat);
  try {
    const { findings } = check("ru", dir);
    const tags = findings.filter((f) => f.rule === "tag-imbalance");
    assert.deepEqual(tags, [], "разница только в <font> не должна флагаться");
  } finally {
    cleanup(dir);
  }
});

test("check: латиница в RU — warning только для ru и при коротком переводе молчит", () => {
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
  const dir = fixture("latin", pot, dat);
  try {
    const { summary, findings } = check("ru", dir);
    const latin = findings.filter((f) => f.rule === "latin-leftover").map((f) => f.text);
    assert.deepEqual(latin, ["Long"]);
    assert.equal(summary.warnings, 1);
    // de не проверяет латиницу (проверка привязана к письменности)
    const deDir = fixture("latin-de", pot, dat);
    try {
      // у de нет .dat -> пустые переводы; используем ru-раскладку как источник
      const de = check("de", deDir);
      assert.equal(de.summary.warnings, 0);
    } finally {
      cleanup(deDir);
    }
  } finally {
    cleanup(dir);
  }
});

test("check: дубли (msgid, msgctxt) с разным msgstr в po — error", () => {
  const dir = fixture(
    "dupes",
    `msgctxt "speaker:Z"
msgid "Hi"
msgstr ""
`,
    JSON.stringify({ t: "Hi", x: "Привет" }) + "\n",
    `msgctxt "speaker:Z"
msgid "Hi"
msgstr "Привет"

msgctxt "speaker:Z"
msgid "Hi"
msgstr "Здравствуй"
`,
  );
  try {
    const { findings } = check("ru", dir);
    const dupes = findings.filter((f) => f.rule === "duplicate-po");
    assert.equal(dupes.length, 1);
    assert.deepEqual(JSON.parse(dupes[0].detail.split(": ").slice(1).join(": ")), [
      "Здравствуй",
      "Привет",
    ]);
  } finally {
    cleanup(dir);
  }
});

test("loadDat: первая строка побеждает, битые строки пропускаются", () => {
  const dir = fixture(
    "dat",
    `msgctxt "ui"
msgid "Hi"
msgstr ""
`,
    `{not json}\n${JSON.stringify({ t: "Hi", x: "Первый" })}\n${JSON.stringify({ t: "Hi", x: "Второй" })}\n`,
  );
  try {
    const dat = loadDat("ru", dir);
    assert.equal(dat.get("Hi")?.x, "Первый");
    assert.equal(loadDat("de", dir).size, 0, "нет .dat — пустая карта");
  } finally {
    cleanup(dir);
  }
});

test("хелперы: доля кириллицы, спикер, папка-источник", () => {
  assert.equal(cyrRatio("Привет мир"), 1);
  assert.equal(cyrRatio("Hello world"), 0);
  assert.ok(Math.abs(cyrRatio("АБВab") - 0.6) < 1e-9);
  assert.equal(cyrRatio("123"), 1); // букв нет
  assert.equal(speakerOf("speaker:Zoey"), "Zoey");
  assert.equal(speakerOf("ui"), "");
  assert.equal(sourcedirOf([]), "ui");
  assert.equal(sourcedirOf(["translations/dialogues/1.yaml"]), "dialogues");
  assert.equal(sourcedirOf(["[dlg:1#0]"]), "dlg");
  assert.equal(sourcedirOf(["[weird:1]"]), "?");
});

test("renderHtml: полноценный документ, фильтр и экранирование", () => {
  const summary = {
    total: 1,
    filled: 1,
    coverage: 100,
    errors: 0,
    warnings: 1,
    bySpeaker: new Map([["Z", { filled: 1, total: 1 }]]),
    byDir: new Map([["ui", { filled: 1, total: 1 }]]),
  };
  const html = renderHtml(summary, [
    { level: "warning", rule: "latin-leftover", rel: "po", text: "<b>Hello</b>", detail: "x" },
  ]);
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.trimEnd().endsWith("</html>"));
  assert.ok(html.includes("latin-leftover"));
  assert.ok(html.includes("&lt;b&gt;Hello&lt;/b&gt;"), "текст экранирован");
  assert.ok(html.includes('id="q"'), "есть поле фильтра");
});
