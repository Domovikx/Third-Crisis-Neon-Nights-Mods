/**
 * rich_gate.test.mts — контракт `rich_translation` в PO и в собранном `.dat`.
 *
 * Правило (владелец, 2026-11-24): под каждой `#. rich_text: …` идёт
 * `#. rich_translation: …`; значение = `msgstr` + те же теги в том же порядке.
 * Непереведённая строка держит пустую заготовку — иначе свежие записи валили бы
 * гейт ещё до того, как их успели перевести.
 *
 * Проверяется два слоя:
 *   1. PO — adjacency + теги + текст (быстро, без модели и игры);
 *   2. `.dat` ↔ POT по КЛЮЧАМ (а не по глобальному счётчику): `#, skip` и шум
 *      не должны давать ни ложного падения, ни ложного «всё хорошо».
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { LANGS, auditPoText, datRtKeys, potRichKeys, poTranslatedKeys } from "./rich_gate.mts";
import { backfillPo } from "./rt_backfill.mts";
import { l10nBinary } from "./text_cli.mts";

const REPO = resolve(import.meta.dirname, "..");
const bin = l10nBinary(REPO);
const skipRust = bin ? false : "rust-l10n не собран (npm run l10n:build)";

const POT = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

#. src: dialog
#. rich_text: <color=#EB83FF>Welcome back, Sarah.</color>
msgctxt "speaker:Zoey"
msgid "Welcome back, Sarah."
msgstr ""

#. src: dialog
#. rich_text: Hehe- That sounds- <color=#EB83FF>fun...</color>
msgctxt "speaker:Zoey"
msgid "Hehe- That sounds- fun..."
msgstr ""

#. src: dialog
#. rich_text: <i>(Nothing to see.)</i>
msgctxt "speaker:Zoey"
msgid "(Nothing to see.)"
msgstr ""

#. src: dialog
#. rich_text: <i>Not translated yet.</i>
msgctxt "speaker:Zoey"
msgid "Not translated yet."
msgstr ""

#. src: bundle
#, skip
msgid "RestrictSaves"
msgstr ""

#. src: ui
msgctxt "ui"
msgid "Plain line"
msgstr ""
`;

/** PO уже пройден бэкфиллом: пары стоят на месте. */
const PO_OK = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

#. src: dialog
#. rich_text: <color=#EB83FF>Welcome back, Sarah.</color>
#. rich_translation: <color=#EB83FF>С возвращением, Сара.</color>
msgctxt "speaker:Zoey"
msgid "Welcome back, Sarah."
msgstr "С возвращением, Сара."

#. src: dialog
#. rich_text: Hehe- That sounds- <color=#EB83FF>fun...</color>
#. rich_translation: Хе-хе- Звучит- <color=#EB83FF>весело...</color>
msgctxt "speaker:Zoey"
msgid "Hehe- That sounds- fun..."
msgstr "Хе-хе- Звучит- весело..."

#. src: dialog
#. rich_text: <i>(Nothing to see.)</i>
#. rich_translation: <i>(Смотреть не на что.)</i>
msgctxt "speaker:Zoey"
msgid "(Nothing to see.)"
msgstr "(Смотреть не на что.)"

#. src: dialog
#. rich_text: <i>Not translated yet.</i>
#. rich_translation:
msgctxt "speaker:Zoey"
msgid "Not translated yet."
msgstr ""

#. src: bundle
#, skip
msgid "RestrictSaves"
msgstr ""

#. src: ui
msgctxt "ui"
msgid "Plain line"
msgstr "Обычная строка"
`;

test("PO: пары на месте, пустая заготовка при непереведённой строке допустима", () => {
  const r = auditPoText("xx", PO_OK);
  assert.equal(r.rich, 4);
  assert.equal(r.adjacent, 4);
  assert.equal(r.stubs, 1, "непереведённая строка = пустая заготовка");
  assert.deepEqual(r.notAdjacent, []);
  assert.deepEqual(r.emptyForTranslated, []);
  assert.deepEqual(r.tagMismatch, []);
  assert.deepEqual(r.textMismatch, []);
  assert.equal(r.legacy, 0);
});

test("PO: убрали пару — гейт краснеет (adjacency по ключу, не по счётчику)", () => {
  const broken = PO_OK.replace(
    "#. rich_translation: Хе-хе- Звучит- <color=#EB83FF>весело...</color>\n",
    "",
  );
  const r = auditPoText("xx", broken);
  assert.equal(r.rich, 4);
  assert.equal(r.adjacent, 3);
  assert.deepEqual(r.notAdjacent, ["Hehe- That sounds- fun..."]);
});

test("PO: пустой rich_translation при непустом msgstr — нарушение", () => {
  const broken = PO_OK.replace(
    "#. rich_translation: <i>(Смотреть не на что.)</i>",
    "#. rich_translation:",
  );
  const r = auditPoText("xx", broken);
  assert.deepEqual(r.emptyForTranslated, ["(Nothing to see.)"]);
});

test("PO: текст перевода разошёлся с msgstr и теги разошлись — ловятся", () => {
  const stale = PO_OK.replace(
    "#. rich_translation: <color=#EB83FF>С возвращением, Сара.</color>",
    "#. rich_translation: <color=#EB83FF>Привет, Сара.</color>",
  );
  assert.equal(auditPoText("xx", stale).textMismatch.length, 1);

  const wrongTags = PO_OK.replace(
    "#. rich_translation: Хе-хе- Звучит- <color=#EB83FF>весело...</color>",
    "#. rich_translation: Хе-хе- Звучит- <b>весело...</b>",
  );
  const r = auditPoText("xx", wrongTags);
  assert.equal(r.tagMismatch.length, 1);
  assert.deepEqual(r.tagMismatch[0].rich, ["<color=#EB83FF>", "</color>"]);
  assert.deepEqual(r.tagMismatch[0].rt, ["<b>", "</b>"]);
});

test("PO: тег на пробеле/пунктуации — артефакт и красный гейт", () => {
  const broken = PO_OK.replace(
    "#. rich_translation: <i>(Смотреть не на что.)</i>",
    "#. rich_translation: <i>(Смотреть<b> </b> не на что.)</i>",
  );
  const r = auditPoText("xx", broken);
  assert.equal(r.artifacts.length, 1);
  assert.match(r.artifacts[0].problems.join(" "), /пустая пара/);
});

test("PO: `#, rt-review` — теги сняты осознанно, строка в списке на человека", () => {
  // Позиция тега не подтверждена: rt без тега, флаг стоит, гейт не считает это
  // расхождением тегов, но ключ виден в списке (без молчаливого пропуска).
  const flagged = PO_OK.replace(
    "#. rich_translation: Хе-хе- Звучит- <color=#EB83FF>весело...</color>",
    "#. rich_translation: Хе-хе- Звучит- весело...\n#, rt-review",
  );
  const r = auditPoText("xx", flagged);
  assert.deepEqual(r.tagMismatch, []);
  assert.deepEqual(r.textMismatch, []);
  assert.deepEqual(r.review, ["Hehe- That sounds- fun..."]);
});

test("PO: старый `# rich_translation:` не остаётся (миграция обязательна)", () => {
  const legacy = PO_OK.replace(
    "#. rich_translation: <i>(Смотреть не на что.)</i>",
    "# rich_translation: <i>(Смотреть не на что.)</i>",
  );
  const r = auditPoText("xx", legacy);
  assert.equal(r.legacy, 1);
  assert.deepEqual(r.notAdjacent, ["(Nothing to see.)"]);
});

test(
  ".dat ↔ POT по ключам на фикстуре: каждый переводимый rich-ключ размечен",
  { skip: skipRust },
  () => {
    const dir = mkdtempSync(join(REPO, "tmp", "rich-gate-"));
    try {
      mkdirSync(join(dir, "po"));
      writeFileSync(join(dir, "po", "template.pot"), POT, "utf8");
      writeFileSync(join(dir, "po", "ru.po"), PO_OK, "utf8");
      const out = join(dir, "patch_ru.dat");
      const run = spawnSync(bin as string, ["po2dat", "ru", "--root", dir, "--out", out], {
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);

      const a = new Set([...potRichKeys(POT)].filter((k) => poTranslatedKeys(PO_OK).has(k)));
      const b = datRtKeys(readFileSync(out, "utf8"));
      assert.deepEqual([...a].sort(), [...b].sort(), "A == B по ключам");
      assert.equal(a.has("RestrictSaves"), false, "`#, skip` в требования не входит");
      assert.equal(
        a.has("Not translated yet."),
        false,
        "непереведённая строка требования не несёт",
      );
      assert.equal(b.has("Plain line"), false, "у строки без rich_text поля нет");

      // Обратная сторона: без пары в PO ключ пропадает из .dat — гейт обязан это видеть.
      writeFileSync(
        join(dir, "po", "ru.po"),
        PO_OK.replace("#. rich_translation: <i>(Смотреть не на что.)</i>\n", ""),
        "utf8",
      );
      assert.equal(
        spawnSync(bin as string, ["po2dat", "ru", "--root", dir, "--out", out]).status,
        0,
      );
      const b2 = datRtKeys(readFileSync(out, "utf8"));
      assert.equal([...a].filter((k) => !b2.has(k)).length, 1, "потерян ровно один ключ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("реальные po/*.po: adjacency по всем языкам — 0 нарушений", () => {
  for (const lang of LANGS) {
    const r = auditPoText(lang, readFileSync(join(REPO, "po", `${lang}.po`), "utf8"));
    assert.equal(r.rich, 2374, `${lang}: rich-записей`);
    assert.equal(r.adjacent, r.rich, `${lang}: у каждой rich_text есть соседняя rich_translation`);
    assert.deepEqual(r.notAdjacent, [], `${lang}: пары на месте`);
    assert.deepEqual(r.emptyForTranslated, [], `${lang}: переведённые строки размечены`);
    assert.deepEqual(r.tagMismatch, [], `${lang}: теги совпадают`);
    assert.deepEqual(r.textMismatch, [], `${lang}: текст rich_translation = msgstr`);
    assert.deepEqual(r.artifacts, [], `${lang}: нет тегов на пробеле/пунктуации`);
    assert.equal(r.legacy, 0, `${lang}: старых "# rich:" нет`);
    assert.ok(r.review.length >= 0, `${lang}: строки на человека учтены`);
  }
});

test("реальные runtime/*.dat: A == B по ключам (opt-in, если .dat собран)", (t) => {
  const dats = LANGS.map((l) => join(REPO, "runtime", `patch_${l}.dat`));
  if (dats.some((p) => !existsSync(p))) {
    t.skip("нет собранных runtime/patch_*.dat — прогони npm run po2dat для языков");
    return;
  }
  const a = potRichKeys(readFileSync(join(REPO, "po", "template.pot"), "utf8"));
  for (const [i, lang] of LANGS.entries()) {
    const translated = poTranslatedKeys(readFileSync(join(REPO, "po", `${lang}.po`), "utf8"));
    const potKeys = new Set([...a].filter((k) => translated.has(k)));
    const b = datRtKeys(readFileSync(dats[i], "utf8"));
    const missing = [...potKeys].filter((k) => !b.has(k));
    const extra = [...b].filter((k) => !potKeys.has(k));
    assert.deepEqual(missing, [], `${lang}: ключи POT без размеченного перевода в .dat`);
    assert.deepEqual(extra, [], `${lang}: размеченные ключи, которых нет в POT`);
  }
});

// --- бэкфилл: заполнение, миграция старой формы, идемпотентность -------------

const BACKFILL_PO = `msgid ""
msgstr ""

#. src: dialog
#. rich_text: <i>Whole line.</i>
# rich_translation: <i>Вся строка.</i>
msgctxt "speaker:Zoey"
msgid "Whole line."
msgstr "Вся строка."

#. src: dialog
#. rich_text: A <b>bold</b> word
msgctxt "speaker:Zoey"
msgid "A bold word"
msgstr "Жирное слово"

#. src: dialog
#. rich_text: <i>Not translated.</i>
msgctxt "speaker:Zoey"
msgid "Not translated."
msgstr ""
`;

test("бэкфилл: ставит пары, мигрирует `# rich:` и не трогает чужие строки", () => {
  const { out, report } = backfillPo("xx", BACKFILL_PO, true);
  assert.equal(report.rich, 3);
  assert.equal(report.filled, 2);
  assert.equal(report.stubs, 1);
  assert.deepEqual(report.failed, []);

  const r = auditPoText("xx", out);
  assert.equal(r.adjacent, 3, "по паре на каждую rich-запись");
  assert.equal(r.legacy, 0, "старая `#`-форма убрана");
  assert.deepEqual(r.tagMismatch, []);
  assert.deepEqual(r.textMismatch, []);
  assert.ok(out.includes("#. rich_translation: <i>Вся строка.</i>\n"), "значение сохранено");
  assert.ok(out.includes("#. rich_translation:\n"), "у непереведённой — заготовка");
  assert.ok(!out.includes("# rich_translation:"), "старой формы нет");
});

test("бэкфилл: второй прогон даёт тот же файл (идемпотентность)", () => {
  const first = backfillPo("xx", BACKFILL_PO, true).out;
  const second = backfillPo("xx", first, true).out;
  assert.equal(second, first);
});

test("бэкфилл: `#, skip` и строки без rich_text не получают пару", () => {
  const po = `${BACKFILL_PO}
#. src: bundle
#, skip
msgid "RestrictSaves"
msgstr ""
`;
  const { out } = backfillPo("xx", po, true);
  assert.equal(auditPoText("xx", out).rich, 3, "skip без rich_text не считается");
  const skipBlock = out.split("\n\n").find((b) => b.includes('msgid "RestrictSaves"')) ?? "";
  assert.ok(skipBlock.length > 0, "запись на месте");
  assert.ok(!skipBlock.includes("rich_translation"), "у строки без rich_text поля нет");
});
