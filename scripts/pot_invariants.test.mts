/**
 * Тесты контракта POT: по одному (минимум) на каждый инвариант 1–13.
 *
 * Принцип: тест не «просто проходит», а доказывает, что подсунутый дефект
 * ЛОВИТСЯ — сначала проверяется чистая база (нарушений нужного кода нет),
 * затем тот же POT с дефектом (нарушение есть). Синтетика пишется в `tmp/`.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  richNestingProblems,
  checkPot,
  checkPotText,
  headerFields,
  INVARIANTS,
  isValidPotDate,
  parsePotText,
  summarizePot,
  type Violation,
} from "./pot_invariants.mts";
import { newEntry, renderPo } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import {
  potHeaderLines,
  parseSkipPolicy,
} from "../.opencode/skills/extract-text/scripts/pot_rules.mts";
import { l10nBinary } from "./text_cli.mts";

const REPO = resolve(import.meta.dirname, "..");
const CREATED = "2026-01-02 03:04+0000";
const CLI = join(REPO, "scripts", "text_cli.mts");
const bin = l10nBinary(REPO);
const rustSkip = bin ? false : "rust-l10n не собран (npm run l10n:build)";

/** POT рабочей Rust-реализации (TS-эталон potgen.mts удалён 2026-11-24). */
function generatePot(dumpDir: string, outPath: string): void {
  const run = spawnSync(
    process.execPath,
    [CLI, "potgen", "--root", REPO, "--dump", dumpDir, "--out", outPath, "--created", CREATED],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`text_cli potgen: ${run.stderr}`);
}

let root: string;
before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "pot-inv-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

interface PotSeed {
  id: string;
  ctx?: string;
  str?: string;
  rich?: string;
  /** `null` — записи без провенанса (негатив инварианта 14). */
  src?: string | null;
  /** Id правила skip-политики: пишет `#, skip` + `#. skip: <id>`. */
  skip?: string;
  /** Голые флаги (негатив: контракт разрешает только `skip`). */
  flags?: string[];
}

/** Канонический POT из перечня записей (порядок как дан). */
function pot(entries: PotSeed[], header: string[] = potHeaderLines(CREATED)): string {
  const poEntries = entries.map((seed) => {
    const e = newEntry();
    e.msgid = seed.id;
    e.msgctxt = seed.ctx ?? "ui";
    e.msgstr = seed.str ?? "";
    if (seed.src !== null) e.comments.push(`src: ${seed.src ?? "dialog"}`);
    if (seed.skip !== undefined) e.comments.push(`skip: ${seed.skip}`);
    if (seed.rich !== undefined) e.comments.push(`rich_text: ${seed.rich}`);
    if (seed.skip !== undefined) e.flags.push("skip");
    if (seed.flags) e.flags = [...seed.flags];
    return e;
  });
  return renderPo(poEntries, header);
}

function codes(violations: Violation[]): string[] {
  return violations.map((v) => `${v.invariant}/${v.code}`);
}

function expectCaught(violations: Violation[], invariant: number, code: string): void {
  assert.ok(
    codes(violations).includes(`${invariant}/${code}`),
    `ожидалось ${invariant}/${code}, получено: ${codes(violations).join(", ") || "ничего"}`,
  );
}

function expectNoCode(violations: Violation[], invariant: number, code: string): void {
  assert.ok(
    !codes(violations).includes(`${invariant}/${code}`),
    `не ожидалось ${invariant}/${code}, но есть`,
  );
}

/** Дамп: имя файла → объекты (сериализуются по одному на строку). */
function writeDump(name: string, files: Record<string, unknown[]>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, rows] of Object.entries(files)) {
    writeFileSync(join(dir, file), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  return dir;
}

/** Базовый чистый дамп: диалоги, UI, FSM, бандл, settings. */
function cleanDumpFiles(): Record<string, unknown[]> {
  return {
    "level0.jsonl": [
      {
        asset: "level0",
        path_id: 900,
        raw_strings: ["Dialogue Log", "BACK", "actions/open", "value must be set"],
      },
      {
        asset: "level0",
        path_id: 901,
        dialogues: [
          {
            speaker: "Zoey",
            text: "Welcome back, Sarah.",
            rich_text: "<color=#EB83FF>Welcome back, Sarah.</color>",
          },
          { speaker: "Zoey", text: "Welcome back, Sarah.", rich_text: "" },
          { speaker: "", text: "Narration line here.", rich_text: "<i>Narration line here.</i>" },
          { speaker: "", text: "   ", rich_text: "" },
        ],
      },
      {
        asset: "level0",
        path_id: 902,
        fsm_strings: ["Ask about her Arm", "Ask about her Arm", ""],
      },
    ],
    "bundle_tiny_assets_all_abc123.jsonl": [
      {
        asset: "bundle_tiny_assets_all_abc123",
        // Значение > 2^53 намеренно: проверяется BigInt-ветка path_id.
        path_id: -5271052525308704166, // eslint-disable-line no-loss-of-precision
        strings: { m_Name: "Tiny" },
        raw_strings: ["Tiny", "line_0", "Where are you going now, my dear friend?", "Zoey"],
      },
    ],
    "summaries.jsonl": [
      {
        asset: "globalgamemanagers",
        settings_keys: [
          { key: "New Game", display: "New Game" },
          { key: "New Game", display: "  New Game  " },
          { key: "empty", display: "   " },
        ],
      },
    ],
  };
}

async function generate(
  name: string,
  files: Record<string, unknown[]>,
): Promise<{ dir: string; path: string; text: string }> {
  const dir = writeDump(name, files);
  const path = join(dir, "template.pot");
  generatePot(dir, path);
  return { dir, path, text: readFileSync(path, "utf8") };
}

// ---------------------------------------------------------------------------

test("набор инвариантов: 1–15 объявлены", () => {
  assert.deepEqual(
    Object.keys(INVARIANTS).map(Number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  );
});

test("чистый синтетический POT: нарушений нет (без дампа)", async () => {
  const text = pot([
    { id: "Ask about her Arm" },
    { id: "BACK", rich: "<i>BACK</i>" },
    { id: "Welcome back, Sarah.", ctx: "speaker:Zoey" },
  ]);
  assert.deepEqual(await checkPotText(text), []);
});

test("инвариант 8: кавычки, \\n, \\t, не-ASCII и обратный слэш переживают round-trip", async () => {
  const tricky = [
    'He said "hi" and left.',
    "Первая строка\nВторая\tс табуляцией",
    "Путь C:\\Games\\Third Crisis",
    "Иероглифы: 世界, こんにちは, 안녕",
    "Эмодзи и типографика: «ёлочки» — тире…",
  ].sort();
  const text = pot(tricky.map((id, i) => ({ id, ctx: `speaker:S${i}` })));
  assert.deepEqual(await checkPotText(text), []);
  const parsed = parsePotText(text);
  assert.deepEqual(
    parsed.entries.slice(1).map((e) => e.fields.msgid?.value),
    tricky,
  );
});

test(
  "инвариант 1: порядок элементов дампа не должен менять POT (ловится конфликт rich)",
  { skip: rustSkip },
  async () => {
    const files = cleanDumpFiles();
    const level = files["level0.jsonl"] as Array<Record<string, unknown>>;
    level.push(
      {
        asset: "level0",
        path_id: 100,
        dialogues: [
          { speaker: "Zoey", text: "Conflicted line.", rich_text: "<i>Conflicted line.</i>" },
        ],
      },
      {
        asset: "level0",
        path_id: 101,
        dialogues: [
          { speaker: "Zoey", text: "Conflicted line.", rich_text: "<b>Conflicted line.</b>" },
        ],
      },
    );
    const { dir, path } = await generate("order-conflict", files);
    const violations = await checkPot(path, { dumpPath: dir });
    expectCaught(violations, 1, "order-dependent");

    // Чистый дамп того же состава, но без конфликта rich — предупреждения нет.
    const clean = cleanDumpFiles();
    const cleanRun = await generate("order-clean", clean);
    expectNoCode(await checkPot(cleanRun.path, { dumpPath: cleanRun.dir }), 1, "order-dependent");
  },
);

test(
  "инвариант 2: POT, разошедшийся с дампом, — stale; перегенерация дважды побайтовая",
  { skip: rustSkip },
  async () => {
    const first = await generate("idempotent", cleanDumpFiles());
    const twice = await generate("idempotent-2", cleanDumpFiles());
    assert.equal(first.text, twice.text, "два прогона одного дампа обязаны совпасть");

    const drifted = first.text.replace("Narration line here.", "Narration line here!");
    const path = join(root, "idempotent", "drifted.pot");
    writeFileSync(path, drifted, "utf8");
    expectCaught(await checkPot(path, { dumpPath: first.dir }), 2, "stale");
  },
);

test("инвариант 3: пропавшая запись в POT — missing-entry", { skip: rustSkip }, async () => {
  const run = await generate("complete", cleanDumpFiles());
  const blocks = run.text.split("\n\n");
  const withoutOne = [...blocks.slice(0, 5), ...blocks.slice(6)].join("\n\n");
  const path = join(run.dir, "missing.pot");
  writeFileSync(path, withoutOne, "utf8");
  const violations = await checkPot(path, { dumpPath: run.dir });
  expectCaught(violations, 3, "missing-entry");
  expectCaught(violations, 9, "entry-count");
});

test("инвариант 4: выдуманный msgid — invented-entry", { skip: rustSkip }, async () => {
  const run = await generate("invented", cleanDumpFiles());
  const forged = pot([{ id: "Fabricated question?", ctx: "speaker:Ghost" }]);
  const path = join(run.dir, "forged.pot");
  // Шапка из настоящего POT + выдуманная запись (порядок сохраняем сортировкой).
  const body = readFileSync(run.path, "utf8").split("\n\n");
  const forgedBody = forged.split("\n\n").slice(1).join("\n\n");
  writeFileSync(path, [body[0], forgedBody, ...body.slice(1)].join("\n\n"), "utf8");
  expectCaught(await checkPot(path, { dumpPath: run.dir }), 4, "invented-entry");
});

test("инвариант 5: дубль (msgid, msgctxt) — duplicate-key", async () => {
  const base = pot([{ id: "Hello" }, { id: "World" }]);
  assert.deepEqual(await checkPotText(base), []);

  const dup = pot([{ id: "Hello" }, { id: "Hello" }, { id: "World" }]);
  expectCaught(await checkPotText(dup), 5, "duplicate-key");

  // Один msgid с разными msgctxt — не дубль (порядок: speaker:* < ui).
  const sameId = pot([{ id: "Hello", ctx: "speaker:Zoey" }, { id: "Hello" }]);
  assert.deepEqual(await checkPotText(sameId), []);
});

test("инвариант 6: записи обязаны быть отсортированы по (msgid, msgctxt)", async () => {
  const sorted = pot([{ id: "a", ctx: "speaker:Zed" }, { id: "a" }, { id: "b" }]);
  assert.deepEqual(await checkPotText(sorted), []);

  const unsorted = pot([{ id: "b" }, { id: "a" }]);
  expectCaught(await checkPotText(unsorted), 6, "unsorted");
});

test(
  "инвариант 7: rich_text — наличие по источнику, без <font>, не обрезан",
  { skip: rustSkip },
  async () => {
    const run = await generate("rich", cleanDumpFiles());
    const baseline = await checkPot(run.path, { dumpPath: run.dir });
    assert.equal(baseline.filter((v) => v.invariant === 7).length, 0);

    const withRich = run.text;
    const withoutRich = withRich.replace(/#\. rich_text: .*\n/g, "");
    const noRichPath = join(run.dir, "no-rich.pot");
    writeFileSync(noRichPath, withoutRich, "utf8");
    expectCaught(await checkPot(noRichPath, { dumpPath: run.dir }), 7, "rich-missing");

    const truncated = withRich.replace(
      "#. rich_text: <color=#EB83FF>Welcome back, Sarah.</color>",
      "#. rich_text: <color=#EB83FF>Welcome back",
    );
    const truncPath = join(run.dir, "truncated.pot");
    writeFileSync(truncPath, truncated, "utf8");
    expectCaught(await checkPot(truncPath, { dumpPath: run.dir }), 7, "rich-mismatch");

    const fontTag = pot([{ id: "Hi", rich: '<font="F" material="M">Hi</font>' }]);
    expectCaught(await checkPotText(fontTag), 7, "rich-font-tag");
  },
);

test("инвариант 8: битое экранирование и неканоничный формат", async () => {
  const ok = pot([{ id: 'He said "hi"' }]);
  assert.deepEqual(await checkPotText(ok), []);

  // Незакрытая/лишняя кавычка — строка не по грамматике PO.
  const broken = `${potHeaderLines(CREATED).join("\n")}\n\nmsgctxt "ui"\nmsgid "He said "hi""\nmsgstr ""\n`;
  expectCaught(await checkPotText(broken), 8, "syntax");

  // Неизвестный эскейп: \q декодируется в q, обратно — уже "aqb".
  const badEscape = ok.replace('msgid "He said \\"hi\\""', 'msgid "He said \\qhi\\q"');
  assert.notEqual(badEscape, ok);
  expectCaught(await checkPotText(badEscape), 8, "escape-noncanonical");

  // Комментарий после msgid — render переставит его, round-trip не сойдётся.
  const reordered = ok.replace(
    'msgid "He said \\"hi\\""',
    'msgid "He said \\"hi\\""\n#. comment after',
  );
  expectCaught(await checkPotText(reordered), 8, "roundtrip");

  // refs контрактом не пишутся.
  const withRefs = ok.replace(
    'msgid "He said \\"hi\\""',
    '#: scene.yaml:1\nmsgid "He said \\"hi\\""',
  );
  expectCaught(await checkPotText(withRefs), 8, "refs");
});

test("инвариант 9: счётчики rich/mergedTwins сходятся с фактом", { skip: rustSkip }, async () => {
  // ui-двойник с rich: генератор пишет rich в ui-запись, затем удаляет её как
  // двойника — счётчик rich обязан это учитывать (сейчас предупреждает).
  const files = cleanDumpFiles();
  (files["level0.jsonl"] as Array<Record<string, unknown>>).push({
    asset: "level0",
    path_id: 950,
    dialogues: [
      { speaker: "", text: "Twin line with style.", rich_text: "<i>Twin line with style.</i>" },
      { speaker: "Zoey", text: "Twin line with style.", rich_text: "" },
    ],
  });
  const run = await generate("rich-counter", files);
  expectCaught(await checkPot(run.path, { dumpPath: run.dir }), 9, "rich-counter");
});

test("инвариант 10: BOM, CRLF, NUL — ошибки кодировки", async () => {
  const clean = pot([{ id: "Hello" }]);
  assert.deepEqual(await checkPotText(clean), []);

  expectCaught(await checkPotText(`\uFEFF${clean}`), 10, "bom");
  expectCaught(await checkPotText(clean.replace(/\n/g, "\r\n")), 10, "crlf");
  expectCaught(
    await checkPotText(clean.replace('msgid "Hello"', 'msgid "Hel\u0000lo"')),
    10,
    "invisible",
  );
});

test("инвариант 11: заголовок обязателен и корректен", async () => {
  const clean = pot([{ id: "Hello" }]);
  assert.deepEqual(await checkPotText(clean), []);

  const noCharset = pot(
    [{ id: "Hello" }],
    potHeaderLines(CREATED).map((l) => l.replace("charset=UTF-8", "charset=KOI8-R")),
  );
  expectCaught(await checkPotText(noCharset), 11, "header-charset");

  const badDate = pot(
    [{ id: "Hello" }],
    potHeaderLines(CREATED).map((l) => l.replace("2026-01-02 03:04", "2026-02-30 03:04")),
  );
  expectCaught(await checkPotText(badDate), 11, "header-date-invalid");

  expectCaught(
    await checkPotText(clean.slice(clean.indexOf('msgctxt "ui"'))),
    11,
    "header-not-first",
  );
  expectCaught(
    await checkPotText(pot([{ id: "Hello", str: "Привет" }])),
    11,
    "template-msgstr-filled",
  );
});

test("инвариант 12: POT второй реализации сравнивается побайтово (кроме даты)", async () => {
  const mine = pot([{ id: "Hello" }, { id: "World" }]);
  const path = join(root, "parity", "mine.pot");
  mkdirSync(join(root, "parity"), { recursive: true });
  writeFileSync(path, mine, "utf8");

  const otherSame = mine.replace(
    "POT-Creation-Date: 2026-01-02 03:04",
    "POT-Creation-Date: 2030-12-31 23:59",
  );
  const samePath = join(root, "parity", "same.pot");
  writeFileSync(samePath, otherSame, "utf8");
  assert.deepEqual(await checkPot(path, { parityPot: samePath }), []);

  const otherDiff = mine.replace('msgid "World"', 'msgid "Word"');
  const diffPath = join(root, "parity", "diff.pot");
  writeFileSync(diffPath, otherDiff, "utf8");
  expectCaught(await checkPot(path, { parityPot: diffPath }), 12, "parity-diff");
});

test(
  "инвариант 13: битая JSONL-строка не роняет генерацию и не даёт записей",
  { skip: rustSkip },
  async () => {
    const files = cleanDumpFiles();
    const brokenDir = writeDump("robust", files);
    const path = join(brokenDir, "template.pot");
    generatePot(brokenDir, path);
    const cleanText = readFileSync(path, "utf8");
    const cleanKeys = new Set(
      parsePotText(cleanText)
        .entries.slice(1)
        .map((e) => JSON.stringify([e.fields.msgid?.value, e.fields.msgctxt?.value ?? ""])),
    );

    // Тот же дамп + обрезанная строка, строка-не-объект и пустая строка.
    const noisyDir = writeDump("robust-noisy", files);
    writeFileSync(
      join(noisyDir, "level0.jsonl"),
      `${readFileSync(join(noisyDir, "level0.jsonl"), "utf8")}{"asset": "level0", "dialogues": [\nnull\n\n`,
      "utf8",
    );
    const noisyPath = join(noisyDir, "template.pot");
    generatePot(noisyDir, noisyPath);
    const noisyText = readFileSync(noisyPath, "utf8");
    const noisyKeys = new Set(
      parsePotText(noisyText)
        .entries.slice(1)
        .map((e) => JSON.stringify([e.fields.msgid?.value, e.fields.msgctxt?.value ?? ""])),
    );
    assert.deepEqual(
      [...noisyKeys].sort(),
      [...cleanKeys].sort(),
      "битые строки не порождают записей",
    );

    const violations = await checkPot(noisyPath, { dumpPath: noisyDir });
    expectCaught(violations, 13, "dump-ignored-lines");
    assert.equal(violations.filter((v) => v.severity === "error").length, 0);
  },
);

test("CLI-обвязка: пустой POT, нет файла POT, нет дампа — понятные ошибки", async () => {
  expectCaught(await checkPotText(""), 11, "empty-file");
  expectCaught(await checkPotText("\n\n\n"), 11, "empty-file");

  await assert.rejects(checkPot(join(root, "nope.pot")), /POT not found/);
  const clean = pot([{ id: "Hello" }]);
  const path = join(root, "errors", "x.pot");
  mkdirSync(join(root, "errors"), { recursive: true });
  writeFileSync(path, clean, "utf8");
  await assert.rejects(checkPot(path, { dumpPath: join(root, "no-dump") }), /dump not found/);

  // Пустой дамп: генератор отказывается (существующий тест potgen), а проверка
  // даёт нарушения, но не падает.
  const emptyDump = join(root, "empty-dump");
  mkdirSync(emptyDump, { recursive: true });
  writeFileSync(join(emptyDump, "level0.jsonl"), "\n", "utf8");
  const violations = await checkPot(path, { dumpPath: emptyDump });
  expectCaught(violations, 9, "entry-count");
});

test("инвариант 14: провенанс обязателен и только из фиксированного списка", async () => {
  // Негатив: POT без `#. src:` не проходит контракт.
  const noSrc = pot([{ id: "Hello", src: null }]);
  expectCaught(await checkPotText(noSrc), 14, "src-missing");

  // Переходный POT (сгенерирован до провенанса): проверка явно отключена.
  assert.deepEqual(await checkPotText(noSrc, { requireSrc: false }), []);

  // Произвольная метка запрещена: отчёт по провенансу должен быть однозначным.
  expectCaught(await checkPotText(pot([{ id: "Hello", src: "garbage" }])), 14, "src-unknown");
  expectCaught(await checkPotText(pot([{ id: "Hello", src: "field:" }])), 14, "src-unknown");

  // Весь фиксированный список проходит.
  for (const src of [
    "dialog",
    "bundle",
    "settings",
    "us",
    "global",
    "field:m_Name",
    "raw:Texture2D",
  ]) {
    assert.deepEqual(await checkPotText(pot([{ id: "Hello", src }])), [], src);
  }
  // Две метки у записи — дефект.
  const a = newEntry();
  a.msgid = "Hello";
  a.msgctxt = "ui";
  a.comments = ["src: dialog", "src: bundle"];
  expectCaught(await checkPotText(renderPo([a], potHeaderLines(CREATED))), 14, "src-duplicate");
});

test("инвариант 14: метка POT сверяется с генератором (с дампом)", { skip: rustSkip }, async () => {
  const files = cleanDumpFiles();
  const run = await generate("provenance", files);
  const violations = await checkPot(run.path, { dumpPath: run.dir });
  expectNoCode(violations, 14, "src-mismatch");
  assert.ok(run.text.includes("#. src: "), "генератор обязан писать метку");

  // Подмена метки у одной записи ловится сверкой с дампом.
  const wrong = run.text.replace("#. src: dialog", "#. src: bundle");
  const wrongPath = join(root, "provenance", "wrong.pot");
  writeFileSync(wrongPath, wrong, "utf8");
  expectCaught(await checkPot(wrongPath, { dumpPath: run.dir }), 14, "src-mismatch");
});

test("вспомогательное: дата и сводка", () => {
  assert.equal(isValidPotDate("2026-01-02 03:04+0000"), true);
  assert.equal(isValidPotDate("2024-02-29 00:00+0000"), true);
  assert.equal(isValidPotDate("2026-02-30 00:00+0000"), false);
  assert.equal(isValidPotDate("2026-1-2 3:4+0000"), false);

  const text = pot([
    { id: "BACK" },
    { id: "Zoey", ctx: "speaker-name" },
    { id: "Hi", ctx: "speaker:Zoey", rich: "<i>Hi</i>" },
  ]);
  const summary = summarizePot(text);
  assert.equal(summary.entries, 3);
  assert.equal(summary.rich, 1);
  assert.deepEqual(summary.byCtxt, { ui: 1, speaker: 1, speakerName: 1, other: 0 });
  assert.equal(
    headerFields(parsePotText(text).entries[0].fields.msgstr?.value ?? "").get("POT-Creation-Date"),
    CREATED,
  );
});

test("реальный POT в репозитории: структурные инварианты без дампа (если файл есть)", async () => {
  const path = join(REPO, "po", "template.pot");
  if (!existsSync(path)) return;
  // POT перегенерирован вместе с провенансом и skip-политикой (2026-11-23):
  // `#. src:` и `#, skip` в файле есть, поэтому проверка идёт со значениями по
  // умолчанию (src обязателен, политика читается из config/).
  const violations = await checkPot(path);
  const errors = violations.filter((v) => v.severity === "error");

  // Известные дефекты данных (найдены 2026-11-22, чистка — отдельная задача).
  // Фиксируем их код и потолок, чтобы НОВЫЕ классы и рост падали тестом.
  // rich-nesting — дефект данных игры (TMP закрывает неявно), поэтому warn с потолком.
  const KNOWN_WARN: Record<string, number> = { "rich-nesting": 21 };
  const warns = violations.filter((v) => v.severity === "warn");
  const byCode = new Map<string, number>();
  for (const v of warns) byCode.set(v.code, (byCode.get(v.code) ?? 0) + 1);

  for (const [code, count] of byCode) {
    if (KNOWN_WARN[code] === undefined) continue; // прочие warn не нормируем
    assert.ok(
      count <= KNOWN_WARN[code],
      `${code} стало больше: ${count} > известных ${KNOWN_WARN[code]}`,
    );
  }
  assert.deepEqual(errors, [], `в po/template.pot не должно быть ошибок контракта`);
});

test("вложенность rich_text: перекрещенные теги ловятся, правильные — нет", () => {
  assert.deepEqual(richNestingProblems("<color=#fff><i>текст</i></color>"), []);
  assert.deepEqual(richNestingProblems("<i>a <color=#fff>b</color> c</i>"), []);
  assert.deepEqual(richNestingProblems('<sprite="x" name="y" tint=1>'), []);
  const crossed = richNestingProblems("<i>a <color=#fff>b</color> c</i></color>");
  assert.equal(crossed.length, 1);
  assert.match(crossed[0], /без открывающего|перекрещ/);
  const unbalanced = richNestingProblems("<i>a <color=#fff>b");
  assert.ok(unbalanced.some((p) => /незакрытые/.test(p)));
});

// ---------------------------------------------------------------------------
// Инвариант 7 (rich-fragment) и 15 (skip-теги).
// ---------------------------------------------------------------------------

const REAL_FRAGMENT =
  "<i>< Like this, hmmm...? I love these nice big tits. Especially when adorable " +
  "customers like <b>you</b> request them. >";

const SKIP_POLICY = parseSkipPolicy(
  JSON.stringify({
    rules: [
      { id: "no-letters", src: "raw:*", when: "noLetters" },
      { id: "short-token", src: "raw:*", when: "shortToken" },
      { id: "fragment", src: "*", when: "fragment" },
    ],
  }),
  "<test>",
);

test("rich-fragment: обрывок-хвост ловится, шум по порогу — нет", async () => {
  const text = pot([
    { id: "you request them. >", rich: REAL_FRAGMENT },
    { id: ">", rich: "<< Declination processed. Proceeding relocation. >>" },
    { id: "Fine line", rich: "<i>Fine line</i>" },
  ]);
  const violations = await checkPotText(text, { skipPolicy: SKIP_POLICY });
  const frags = violations.filter((v) => v.code === "rich-fragment");
  assert.equal(frags.length, 1, JSON.stringify(violations, null, 2));
  assert.equal(frags[0].severity, "warn", "дефект данных игры, не контракта");
  assert.match(frags[0].detail, /^suffix:/);
  assert.ok(frags[0].detail.includes("you request them. >"));
});

test("rich-fragment: расхождение на символ — подкласс mismatch", async () => {
  const id =
    "Your new Neon-Trust Reserve account is now open! Your new pin number is as follows... 7192>";
  const rich =
    "Your new Neon-Trust Reserve account is now open! Your new pin number is as " +
    "follows... <<color=yellow>7192</color>>";
  const violations = await checkPotText(pot([{ id, rich }]), { skipPolicy: SKIP_POLICY });
  const frags = violations.filter((v) => v.code === "rich-fragment");
  assert.equal(frags.length, 1);
  assert.match(frags[0].detail, /^mismatch:/);
});

test("skip-теги: пара флаг+причина принимается, записи остаются в POT", async () => {
  const text = pot([
    { id: "?|b", src: "raw:Transform", skip: "short-token" },
    { id: "you request them. >", skip: "fragment", rich: REAL_FRAGMENT },
    { id: "Normal line" },
  ]);
  const violations = await checkPotText(text, { skipPolicy: SKIP_POLICY });
  assert.deepEqual(
    violations.filter((v) => v.invariant === 15),
    [],
    JSON.stringify(violations, null, 2),
  );
  assert.equal(summarizePot(text).skip, 2, "записи не удалены, только помечены");
});

test("skip-теги: неизвестное правило — ошибка, не тихий игнор", async () => {
  const text = pot([{ id: "?|b", src: "raw:Transform", skip: "made-up" }]);
  const violations = await checkPotText(text, { skipPolicy: SKIP_POLICY });
  expectCaught(violations, 15, "skip-unknown-rule");
  assert.match(
    violations.find((v) => v.code === "skip-unknown-rule")?.detail ?? "",
    /no-letters, short-token, fragment/,
  );
});

test("skip-теги: флаг без причины, причина без флага, мусорная причина", async () => {
  const noRule = pot([{ id: "x1", src: "raw:Transform", flags: ["skip"] }]);
  expectCaught(await checkPotText(noRule, { skipPolicy: SKIP_POLICY }), 15, "skip-no-rule");

  const noFlag = pot([{ id: "x2", src: "raw:Transform" }]).replace(
    'msgid "x2"',
    '#. skip: short-token\nmsgid "x2"',
  );
  expectCaught(await checkPotText(noFlag, { skipPolicy: SKIP_POLICY }), 15, "skip-no-flag");

  const badSyntax = pot([{ id: "x3", src: "raw:Transform", flags: ["skip"] }]).replace(
    "#. src: raw:Transform",
    "#. src: raw:Transform\n#. skip short-token",
  );
  expectCaught(await checkPotText(badSyntax, { skipPolicy: SKIP_POLICY }), 15, "skip-syntax");
});

test("skip-теги: метка без политики — ошибка", async () => {
  const text = pot([{ id: "?|b", src: "raw:Transform", skip: "short-token" }]);
  expectCaught(await checkPotText(text, { skipPolicy: null }), 15, "skip-without-policy");
});

test("skip-теги: протухшее правило — warn, а не тишина", async () => {
  // Правило short-token требует raw:*, а метка записи — dialog.
  const text = pot([{ id: "line here", src: "dialog", skip: "short-token" }]);
  const violations = await checkPotText(text, { skipPolicy: SKIP_POLICY });
  const stale = violations.find((v) => v.code === "skip-stale");
  assert.ok(stale, JSON.stringify(violations, null, 2));
  assert.equal(stale?.severity, "warn");
});

test("контракт: флаг не-skip по-прежнему ошибка", async () => {
  const text = pot([{ id: "line", flags: ["fuzzy"] }]);
  expectCaught(await checkPotText(text, { skipPolicy: SKIP_POLICY }), 8, "flags");
});
