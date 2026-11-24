/**
 * Тесты инвентаря дампа. Паритет с читающей половиной `extractor.py`:
 * диалоги ANToolkit, бандлы PlayMaker, UI-строки, FSM, settings_keys,
 * цветовые имена и 64-битные path_id.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  DumpScanner,
  bundleShortName,
  isUiString,
  isValidSrc,
  pyStrip,
  resolveNamedColors,
  scanDump,
  type InventoryItem,
} from "../scripts/inventory.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
const FIXTURE = join(import.meta.dirname, "..", "test_data", "tiny-dump");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "inventory-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Добавить строку чанка в сканер (JSON.stringify — сырой строкой дампа). */
function addRow(scanner: DumpScanner, obj: unknown, rawLine = JSON.stringify(obj)): void {
  scanner.addChunkRow(JSON.parse(rawLine) as Record<string, unknown>, rawLine);
}

function only(items: InventoryItem[], kind: InventoryItem["kind"]): InventoryItem[] {
  return items.filter((i) => i.kind === kind);
}

test("pyStrip: пробелы Python (NEL, \\x1c), BOM не трогает", () => {
  assert.equal(pyStrip("  hi \n\t"), "hi");
  assert.equal(pyStrip("\u0085hi\u001c"), "hi");
  assert.equal(pyStrip("\uFEFFhi"), "\uFEFFhi");
});

test("isUiString: лейблы проходят, шум отсекается", () => {
  assert.equal(isUiString("Dialogue Log"), true);
  assert.equal(isUiString("BACK"), true);
  assert.equal(isUiString("Continue"), true);
  assert.equal(isUiString("a"), false);
  assert.equal(isUiString("actions/open"), false);
  assert.equal(isUiString("value must be set"), false);
  assert.equal(isUiString("Normal"), false);
  assert.equal(isUiString("12345678-1234"), false);
});

test("resolveNamedColors: имя из color_parser_list → hex", () => {
  const colors = new Map([["perversion", "#EB83FF"]]);
  assert.equal(
    resolveNamedColors("<color=perversion>Hi</color>", colors),
    "<color=#EB83FF>Hi</color>",
  );
  assert.equal(
    resolveNamedColors("<color=unknown>Hi</color>", colors),
    "<color=unknown>Hi</color>",
  );
});

test("bundleShortName: хвост хэша ассетов/сцен срезается", () => {
  assert.equal(bundleShortName("bundle_x_assets_all_abc123"), "bundle_x");
  assert.equal(bundleShortName("bundle_y_scenes_all_741d8619fcc0"), "bundle_y");
  assert.equal(bundleShortName("level0"), "level0");
});

test("DumpScanner: диалоги ANToolkit — strip, дедуп по объекту, pid по BigInt", () => {
  const scanner = new DumpScanner();
  addRow(scanner, { asset: "resources", path_id: 1, color_parser_list: { perversion: "#EB83FF" } });
  addRow(scanner, {
    asset: "resources",
    path_id: 10,
    dialogues: [
      { speaker: "Zoey", text: "  Hi  ", rich_text: "<color=perversion>Hi</color>" },
      { speaker: "Zoey", text: "Hi", rich_text: "<color=#000000>Hi</color>" },
      { speaker: "", text: "   ", rich_text: "" },
    ],
  });
  addRow(scanner, {
    asset: "resources",
    path_id: 2,
    dialogues: [{ speaker: "", text: "Second", rich_text: "" }],
  });

  const items = only(scanner.finish().items, "dlg");
  assert.deepEqual(
    items.map((i) => [i.source, i.idx, i.text, i.speaker]),
    [
      ["2", 0, "Second", ""],
      ["10", 0, "Hi", "Zoey"],
    ],
  );
  assert.equal(items[1].richText, "<color=#EB83FF>Hi</color>");
});

test("DumpScanner: цвет разворачивается, даже если color_parser_list встретился позже", () => {
  // Порядок файлов не должен влиять на цвет: диалог идёт ДО карты цветов.
  const scanner = new DumpScanner();
  addRow(scanner, {
    asset: "a_first",
    path_id: 1,
    dialogues: [{ speaker: "", text: "Later", rich_text: "<color=perversion>Later</color>" }],
  });
  addRow(scanner, { asset: "z_last", path_id: 2, color_parser_list: { perversion: "#EB83FF" } });

  const items = only(scanner.finish().items, "dlg");
  assert.equal(items[0].richText, "<color=#EB83FF>Later</color>");
});

test("DumpScanner: 64-битный path_id не теряет точность и сортируется как int", () => {
  const raw =
    '{"asset":"bundle_x","path_id":-5271052525308704166,"dialogues":[{"speaker":"","text":"Big","rich_text":""}]}';
  const scanner = new DumpScanner();
  addRow(scanner, null, raw);
  addRow(scanner, {
    asset: "bundle_x",
    path_id: -5,
    dialogues: [{ speaker: "", text: "Small", rich_text: "" }],
  });

  const items = only(scanner.finish().items, "dlg");
  assert.deepEqual(
    items.map((i) => [i.source, i.text]),
    [
      ["-5271052525308704166", "Big"],
      ["-5", "Small"],
    ],
  );
});

test("DumpScanner: бандл PlayMaker — line_X, спикер и глобальный дедуп", () => {
  const scanner = new DumpScanner();
  const asset = "bundle_tiny_assets_all_abc123";
  addRow(scanner, {
    asset,
    path_id: 7,
    strings: { m_Name: "Tiny" },
    raw_strings: [
      "Tiny",
      "line_0",
      "Where are you going now, my dear friend?",
      "Zoey",
      "expressions/seductive",
      "line_1",
      "line_1",
      "No, wait, that is a very long line indeed.",
    ],
  });
  // Тот же (text, speaker) в другом объекте — глобальный дедуп, как в extractor.
  addRow(scanner, {
    asset,
    path_id: 7,
    strings: { m_Name: "Other" },
    raw_strings: ["line_2", "No, wait, that is a very long line indeed."],
  });
  // Без line_ — записей нет.
  addRow(scanner, { asset: "bundle_empty_assets_all_x", raw_strings: ["Just a label"] });

  const items = only(scanner.finish().items, "bundle");
  assert.deepEqual(
    items.map((i) => [i.source, i.idx, i.text, i.speaker]),
    [
      ["bundle_tiny", 0, "Where are you going now, my dear friend?", "Zoey"],
      ["bundle_tiny", 1, "No, wait, that is a very long line indeed.", ""],
    ],
  );
});

test("DumpScanner: UI-строки raw_strings — фильтр, дедуп, unknown-ассет", () => {
  const scanner = new DumpScanner();
  addRow(scanner, {
    asset: "level0",
    raw_strings: ["Dialogue Log", "BACK", "a", "actions/open", "value must be set", "Normal"],
  });
  addRow(scanner, { asset: "level0", raw_strings: ["Dialogue Log"] });
  addRow(scanner, { raw_strings: ["Resume"] });

  const items = only(scanner.finish().items, "raw");
  assert.deepEqual(
    items.map((i) => [i.source, i.text]),
    [
      ["level0", "Dialogue Log"],
      ["level0", "BACK"],
      ["unknown", "Resume"],
    ],
  );
});

test("DumpScanner: FSM-строки — без UI-фильтра, strip и дедуп", () => {
  const scanner = new DumpScanner();
  addRow(scanner, {
    asset: "level0",
    fsm_strings: ["Ask about her Arm", " Ask about her Arm ", "", 42],
  });
  addRow(scanner, { asset: "level1", fsm_strings: ["Ask about her Arm", "Second FSM"] });

  const items = only(scanner.finish().items, "fsm");
  assert.deepEqual(
    items.map((i) => [i.source, i.text]),
    [
      ["level0", "Ask about her Arm"],
      ["level1", "Second FSM"],
    ],
  );
});

test("DumpScanner: settings_keys.display — strip, NUL, дедуп в строке", () => {
  const scanner = new DumpScanner();
  scanner.addSummaryRow(
    {
      asset: "globalgamemanagers",
      settings_keys: [
        { display: "  New Game  " },
        { display: "New Game" },
        { display: "   " },
        { display: "a\u0000b" },
        { display: "\u0000Options\u0000" },
      ],
    },
    "globalgamemanagers",
  );

  const items = only(scanner.finish().items, "set");
  assert.deepEqual(
    items.map((i) => [i.source, i.text]),
    [
      ["globalgamemanagers", "New Game"],
      ["globalgamemanagers", "Options"],
    ],
  );
});

test("DumpScanner: спикеры собираются из диалогов и бандлов по первому появлению", () => {
  const scanner = new DumpScanner();
  addRow(scanner, {
    asset: "resources",
    path_id: 1,
    dialogues: [
      { speaker: "Zoey", text: "one", rich_text: "" },
      { speaker: "Sarah", text: "two", rich_text: "" },
    ],
  });
  addRow(scanner, {
    asset: "bundle_x_assets_all_abc",
    path_id: 2,
    strings: { m_Name: "N" },
    raw_strings: ["line_0", "Where is my mind, my dear friend?", "Clerk"],
  });

  const items = only(scanner.finish().items, "spk");
  assert.deepEqual(
    items.map((i) => i.text),
    ["Zoey", "Sarah", "Clerk"],
  );
});

test("scanDump: реальный мини-фикстур-дамп собирается целиком", async () => {
  const inv = await scanDump(FIXTURE);
  assert.equal(inv.stats.chunkFiles, 2);
  assert.equal(inv.stats.summaryFiles, 1);

  const dlg = only(inv.items, "dlg");
  assert.deepEqual(
    dlg.map((i) => [i.text, i.speaker]),
    [["Welcome back, Sarah.", "Zoey"]],
  );
  assert.equal(dlg[0].richText, "<color=#EB83FF>Welcome back, Sarah.</color>");
  assert.deepEqual(
    only(inv.items, "bundle").map((i) => i.text),
    ["Where are you going now, my dear friend?"],
  );
  assert.deepEqual(
    only(inv.items, "set").map((i) => i.text),
    ["New Game", "Options"],
  );
  assert.deepEqual(
    only(inv.items, "fsm").map((i) => i.text),
    ["Ask about her Arm"],
  );
  assert.ok(only(inv.items, "raw").some((i) => i.text === "Dialogue Log"));
});

test("DumpScanner: провенанс — settings и us различаются по строке DLL", () => {
  const scanner = new DumpScanner();
  scanner.addSummaryRow(
    {
      asset: "Assembly-CSharp.dll",
      format: "dotnet_us_heap",
      settings_keys: [
        { key: "Settings.EnableVSync", display: "Enable VSync" },
        { key: "Load Game", display: "Load Game" },
      ],
    },
    "Assembly-CSharp.dll",
  );
  scanner.addSummaryRow(
    {
      asset: "resources.assets",
      settings_keys: [{ key: "Settings.Volume", display: "Volume" }],
    },
    "resources.assets",
  );
  const items = only(scanner.finish().items, "set");
  assert.deepEqual(
    items.map((i) => [i.text, i.src]),
    [
      ["Enable VSync", "settings"],
      ["Load Game", "us"],
      ["Volume", "settings"],
    ],
  );
});

test("DumpScanner: провенанс raw — значение типизированного поля точнее raw:<Type>", () => {
  const scanner = new DumpScanner();
  addRow(scanner, {
    asset: "level0",
    type: "MonoBehaviour",
    strings: { m_Name: "Panel" },
    fields: { m_Labels: ["Start Game", "Continue"] },
    raw_strings: ["Panel", "Start Game", "Continue", "Raw Only Label"],
  });
  const items = only(scanner.finish().items, "raw");
  assert.deepEqual(
    items.map((i) => [i.text, i.src]),
    [
      ["Panel", "field:m_Name"],
      ["Start Game", "field:m_Labels"],
      ["Continue", "field:m_Labels"],
      ["Raw Only Label", "raw:MonoBehaviour"],
    ],
  );
});

test("DumpScanner: провенанс спикера — источник первого появления", () => {
  const scanner = new DumpScanner();
  addRow(scanner, {
    asset: "resources",
    path_id: 1,
    dialogues: [{ speaker: "Zoey", text: "one", rich_text: "" }],
  });
  addRow(scanner, {
    asset: "bundle_x_assets_all_abc",
    type: "MonoBehaviour",
    strings: { m_Name: "N" },
    raw_strings: ["line_0", "Where is my mind, my dear friend?", "Clerk"],
  });
  const items = only(scanner.finish().items, "spk");
  assert.deepEqual(
    items.map((i) => [i.text, i.src]),
    [
      ["Zoey", "dialog"],
      ["Clerk", "bundle"],
    ],
  );
});

test("DumpScanner: FSM-строки — field:fsm, диалоги и бандлы — свои метки", () => {
  const scanner = new DumpScanner();
  addRow(scanner, {
    asset: "resources",
    path_id: 5,
    dialogues: [{ speaker: "Zoey", text: "Hi there", rich_text: "" }],
  });
  addRow(scanner, {
    asset: "bundle_z_assets_all_abc",
    type: "MonoBehaviour",
    strings: { m_Name: "P" },
    raw_strings: ["line_0", "Hello there friend"],
  });
  addRow(scanner, { asset: "level0", fsm_strings: ["Ask about her Arm"] });

  const inv = scanner.finish().items;
  assert.deepEqual(
    inv.filter((i) => i.kind === "dlg" || i.kind === "bundle").map((i) => [i.text, i.src]),
    [
      ["Hi there", "dialog"],
      ["Hello there friend", "bundle"],
    ],
  );
  assert.deepEqual(
    inv.filter((i) => i.kind === "fsm").map((i) => [i.text, i.src]),
    [["Ask about her Arm", "field:fsm"]],
  );
});

test("isValidSrc: фиксированный список и параметры field/raw", () => {
  for (const ok of [
    "dialog",
    "bundle",
    "settings",
    "us",
    "global",
    "field:m_Name",
    "field:fsm",
    "raw:Texture2D",
  ]) {
    assert.equal(isValidSrc(ok), true, ok);
  }
  for (const bad of ["", "dialog:", "field:", "raw:", "field:1x", "raw:Two Words", "other"]) {
    assert.equal(isValidSrc(bad), false, bad);
  }
});

test("scanDump: метка есть у каждой строки инвентаря", async () => {
  const inv = await scanDump(FIXTURE);
  assert.ok(inv.items.length > 0);
  for (const item of inv.items) {
    assert.equal(isValidSrc(item.src), true, `${item.kind}: ${item.text}`);
  }
});

test("scanDump: отсутствующий дамп — понятная ошибка", async () => {
  await assert.rejects(scanDump(join(root, "no-such-dump")), /dump not found/);
});

test("scanDump: пустой каталог — пустой инвентарь, без падения", async () => {
  const empty = join(root, "empty-dump");
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, "level0.jsonl"), "", "utf8");

  const inv = await scanDump(empty);
  assert.deepEqual(inv.items, []);
  assert.deepEqual(inv.stats, { chunkFiles: 1, summaryFiles: 0 });
});

test("isUiString: границы длины 2..50 code points", () => {
  const s50 = `${"a".repeat(25)} ${"b".repeat(24)}`;
  const s51 = `${"a".repeat(25)} ${"b".repeat(25)}`;
  assert.equal(s50.length, 50);
  assert.equal(s51.length, 51);
  assert.equal(isUiString(s50), true);
  assert.equal(isUiString(s51), false, "длиннее 50 — уже не UI-лейбл (см. coverage-gaps)");
  assert.equal(isUiString("a"), false);
  assert.equal(isUiString("Back"), true);
});

test("isUiString: предложение с точкой отбрасывается (эвристика C#-полей)", () => {
  // Характеризация: фильтр видит в «Yeah. Looks…» C#-поле Namespace.Field.
  // Диалоги приходят другими путями, но raw-строки сцен с точками теряются.
  assert.equal(isUiString("Yeah. Looks like it."), false);
  assert.equal(isUiString("Text (TMP)"), false, "скобки = не лейбл");
  assert.equal(isUiString("value must be set"), false, "отладочный текст");
});

test("DumpScanner: бандл — objName, line_ и {json} не становятся репликами", () => {
  const scanner = new DumpScanner();
  addRow(scanner, {
    asset: "bundle_y_assets_all_abc",
    strings: { m_Name: "Tiny" },
    raw_strings: [
      "line_0",
      "Where is the nearest train station, friend?",
      "Tiny",
      "line_1",
      '{"speaker":"X","text":"ignored"}',
      "line_2",
      "<color=#fff>Rich text line with markup here</color>",
      "Zoey",
    ],
  });

  const items = only(scanner.finish().items, "bundle");
  assert.deepEqual(
    items.map((i) => [i.text, i.speaker, i.richText]),
    [
      ["Where is the nearest train station, friend?", "", ""],
      [
        "Rich text line with markup here",
        "Zoey",
        "<color=#fff>Rich text line with markup here</color>",
      ],
    ],
  );
});

test("DumpScanner: доверенные текстовые поля не режутся правилом 50 символов", () => {
  // Реальный промах POT (2026-11-24): описания одежды и подсказки галереи —
  // предложения >50 символов, их отбрасывал `isUiString`. Проверено на дампе:
  // 11 `Description` + 5 `UnlockHint` не попадали в шаблон.
  const desc = "Just an old pair of shorts to wear around my apartment.";
  const scanner = new DumpScanner();
  addRow(scanner, {
    asset: "bundle_shorts_assets_all_x",
    type: "MonoBehaviour",
    strings: { Description: desc },
    raw_strings: [desc],
  });
  // Длинная строка НЕ из доверенного поля по-прежнему отсекается.
  const noise = "This line is long enough to be rejected by the fifty character rule.";
  addRow(scanner, { asset: "level1", type: "TextAsset", raw_strings: [noise] });

  const items = only(scanner.finish().items, "raw");
  assert.deepEqual(
    items.map((i) => [i.text, i.src]),
    [[desc, "field:Description"]],
  );
});

test("isUiString: trusted-флаг снимает эвристики длины, точки, скобок и тегов", () => {
  const desc = "Business up top, party down below. Part of the Hi-Thread casual set.";
  assert.equal(isUiString(desc), false, "обычная эвристика: >50 символов и точка");
  assert.equal(isUiString(desc, true), true);
  assert.equal(isUiString("Have a close look at Rosies breasts.", true), true);
  // Скобки/угловые скобки в описании — обычная пунктуация, не разметка.
  assert.equal(isUiString("Found in M31 over the entrance area (north lift).", true), true);
});

test("DumpScanner: название предмета после `Apl_<id>` не режется скобками", () => {
  // База предметов: имя стоит сразу за своим id. Правило структурное, поэтому
  // «Sporty Bra (Black)» снимается как доверенная строка, а не как «похоже на имя».
  const scanner = new DumpScanner();
  addRow(scanner, {
    asset: "resources",
    type: "MonoBehaviour",
    raw_strings: ["Apl_Zoey_Underwear_Sporty_Black_Top", "Sporty Bra (Black)", "Use"],
  });
  const items = only(scanner.finish().items, "raw");
  const name = items.find((i) => i.text === "Sporty Bra (Black)");
  assert.ok(name, "название предмета обязано попасть в инвентарь");
  assert.equal(name.src, "field:ItemName");
  // Обычная строка с теми же скобками, но без id-пары, по-прежнему отсекается.
  scanner.addChunkRow(
    { asset: "level1", type: "TextAsset", raw_strings: ["Some label (odd)"] },
    "{}",
  );
  const after = only(scanner.finish().items, "raw").filter((i) => i.text === "Some label (odd)");
  assert.equal(after.length, 0);
});
