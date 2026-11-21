/**
 * Тесты сборки POT. Паритет с `build_pot_update`/`render_pot` из potgen.py:
 * msgctxt по видам, склейка дублей, rich-разметка, cross-source dedup,
 * порядок записей, заголовок и безопасная запись.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import type { InventoryItem, ItemKind } from "../scripts/inventory.mts";
import { parsePo } from "../scripts/po_file.mts";
import {
  buildCatalog,
  catalogSize,
  ctxtOf,
  formatPotDate,
  main,
  renderPot,
  runPotgen,
  stripFontTags,
  triageReason,
  writeAtomic,
} from "../scripts/potgen.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
const FIXTURE = join(import.meta.dirname, "..", "test_data", "tiny-dump");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "potgen-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

function item(partial: Partial<InventoryItem> & { text: string; kind: ItemKind }): InventoryItem {
  return { speaker: "", richText: "", source: "test", idx: 0, ...partial };
}

/** Тихая обёртка CLI (ожидаемые ошибки не должны шуметь в выводе тестов). */
async function quietMain(argv: string[]): Promise<number> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await main(argv);
  } finally {
    console.error = orig;
  }
}

test("ctxtOf: спикер / имя персонажа / ui", () => {
  assert.equal(ctxtOf(item({ text: "Hi", kind: "dlg", speaker: "Zoey" })), "speaker:Zoey");
  assert.equal(ctxtOf(item({ text: "Zoey", kind: "spk" })), "speaker-name");
  assert.equal(ctxtOf(item({ text: "Click", kind: "raw" })), "ui");
  assert.equal(ctxtOf(item({ text: "Ask about her Arm", kind: "fsm" })), "ui");
});

test("triageReason: авто-триаж только для UI-ish, диалоги неприкосновенны", () => {
  assert.equal(triageReason("NNHsvRenderer", "raw"), "asset-name");
  assert.equal(triageReason("Bff?D", "set"), "binary-garbage");
  assert.equal(triageReason("Ask about her Arm", "fsm"), "");
  assert.equal(triageReason("Bff?D", "dlg"), "");
  assert.equal(triageReason("NNHsvRenderer", "bundle"), "");
});

test("stripFontTags: font/material вырезаются, color остаётся", () => {
  assert.equal(
    stripFontTags('<color=#EB83FF><font="F" material="M">Hey</font></color>'),
    "<color=#EB83FF>Hey</color>",
  );
  assert.equal(stripFontTags("<FONT size=3>x</FONT>"), "x");
});

test("buildCatalog: один entry на (msgid, msgctxt), rich не перетирается", () => {
  const items = [
    item({ text: "Sigh", speaker: "Zoey", kind: "dlg" }),
    item({ text: "Sigh", speaker: "Zoey", kind: "dlg", richText: "<color=#EB83FF>Sigh</color>" }),
    item({ text: "Sigh", speaker: "Zoey", kind: "dlg", richText: "<color=#000000>Sigh</color>" }),
  ];
  const { catalog, stats } = buildCatalog(items);
  assert.equal(catalogSize(catalog), 1);
  assert.deepEqual(catalog.get("Sigh")?.get("speaker:Zoey")?.comments, [
    "rich_text: <color=#EB83FF>Sigh</color>",
  ]);
  assert.equal(stats.mergedTwins, 0);
  assert.equal(stats.rich, 1);
  assert.equal(stats.scanned, 3);
});

test("buildCatalog: rich, равный тексту после вырезания шрифта, не пишется", () => {
  const items = [
    item({
      text: "Hey",
      speaker: "Zed",
      kind: "dlg",
      richText: '<color=#EB83FF><font="F" material="M">Hey</font></color>',
    }),
    item({ text: "Yo", speaker: "Zed", kind: "dlg", richText: '<font="F">Yo</font>' }),
  ];
  const { catalog } = buildCatalog(items);
  assert.deepEqual(catalog.get("Hey")?.get("speaker:Zed")?.comments, [
    "rich_text: <color=#EB83FF>Hey</color>",
  ]);
  assert.deepEqual(catalog.get("Yo")?.get("speaker:Zed")?.comments, []);
});

test("buildCatalog: ui-двойник диалоговой/спикерской строки удаляется", () => {
  const items = [
    item({ text: "Zoey", kind: "spk" }),
    item({ text: "Zoey", kind: "raw" }),
    item({ text: "Hi", speaker: "Zoey", kind: "dlg" }),
    item({ text: "Hi", kind: "set" }),
  ];
  const { catalog, stats } = buildCatalog(items);
  assert.equal(catalogSize(catalog), 2);
  assert.deepEqual([...(catalog.get("Zoey")?.keys() ?? [])], ["speaker-name"]);
  assert.deepEqual([...(catalog.get("Hi")?.keys() ?? [])], ["speaker:Zoey"]);
  assert.equal(stats.mergedTwins, 2);
});

test("buildCatalog: new/vanished считаются по старому POT, на состав не влияют", () => {
  const items = [item({ text: "A", kind: "raw" }), item({ text: "B", kind: "raw" })];
  const oldKeys = new Set([JSON.stringify(["A", "ui"]), JSON.stringify(["Gone", "ui"])]);
  const { catalog, stats } = buildCatalog(items, oldKeys);
  assert.equal(catalogSize(catalog), 2);
  assert.equal(stats.new, 1);
  assert.equal(stats.vanished, 1);
});

test("renderPot: сортировка по (msgid, msgctxt), без refs, msgstr пустой", () => {
  const items = [
    item({ text: "b", kind: "raw" }),
    item({ text: "a", kind: "raw" }),
    item({ text: "a", kind: "dlg", speaker: "Zed" }),
    item({ text: "a", kind: "dlg", speaker: "Amy" }),
  ];
  const { catalog } = buildCatalog(items);
  const text = renderPot(catalog, "2026-01-02 03:04+0000");
  const entries = parsePo(text).filter((e) => e.msgid);

  assert.deepEqual(
    entries.map((e) => [e.msgid, e.msgctxt]),
    [
      ["a", "speaker:Amy"],
      ["a", "speaker:Zed"],
      ["b", "ui"],
    ],
  );
  assert.ok(entries.every((e) => e.msgstr === ""));
  assert.ok(entries.every((e) => e.refs.length === 0));
  assert.ok(text.includes('"POT-Creation-Date: 2026-01-02 03:04+0000\\n"'));
  assert.ok(text.startsWith("# NeonTranslator EN template"));
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
});

test("formatPotDate: формат Python strftime (UTC)", () => {
  assert.equal(formatPotDate(new Date(Date.UTC(2026, 0, 2, 3, 4))), "2026-01-02 03:04+0000");
});

test("runPotgen: мини-дамп → POT с ожидаемыми записями и rich", async () => {
  const out = join(root, "run", "template.pot");
  const res = await runPotgen({
    dumpDir: FIXTURE,
    outPath: out,
    created: "2026-01-02 03:04+0000",
  });

  assert.equal(res.entries, 10);
  const text = readFileSync(out, "utf8");
  assert.ok(
    text.includes("#. rich_text: <color=#EB83FF>Welcome back, Sarah.</color>"),
    "rich_text из дампа попадает в POT",
  );
  assert.ok(
    text.includes('msgctxt "speaker:Zoey"\nmsgid "Where are you going now, my dear friend?"'),
    "бандл-строка с спикером",
  );
  assert.ok(text.includes('msgctxt "speaker-name"\nmsgid "Zoey"'));
  assert.ok(text.includes('msgctxt "ui"\nmsgid "Ask about her Arm"'));
  const entries = parsePo(text).filter((e) => e.msgid);
  assert.deepEqual(
    entries
      .filter((e) => e.msgid === "Where are you going now, my dear friend?")
      .map((e) => e.msgctxt),
    ["speaker:Zoey"],
    "ui-двойник бандл-строки удалён",
  );
});

test("runPotgen: отсутствие дампа — ошибка, файла нет", async () => {
  const out = join(root, "missing", "template.pot");
  await assert.rejects(
    runPotgen({ dumpDir: join(root, "no-dump"), outPath: out }),
    /dump not found/,
  );
  assert.equal(existsSync(out), false);
});

test("runPotgen: пустой дамп — ошибка, пустой POT не пишется", async () => {
  const empty = join(root, "empty");
  mkdirSync(empty, { recursive: true });
  const out = join(root, "empty-out", "template.pot");
  await assert.rejects(runPotgen({ dumpDir: empty, outPath: out }), /empty dump/);
  assert.equal(existsSync(out), false);
});

test("main: без дампа — ненулевой код выхода", async () => {
  const code = await quietMain(["--dump", join(root, "nope"), "--out", join(root, "x.pot")]);
  assert.notEqual(code, 0);
});

test("writeAtomic: .part не остаётся после записи", () => {
  const out = join(root, "atomic", "x.pot");
  writeAtomic(out, "hello\n");
  assert.equal(readFileSync(out, "utf8"), "hello\n");
  assert.equal(existsSync(`${out}.part`), false);
  writeAtomic(out, "second\n");
  assert.equal(readFileSync(out, "utf8"), "second\n");
});
