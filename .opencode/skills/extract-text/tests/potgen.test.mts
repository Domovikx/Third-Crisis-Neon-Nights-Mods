/**
 * Тесты сборки POT. Паритет с `build_pot_update`/`render_pot` из potgen.py:
 * msgctxt по видам, склейка дублей, rich-разметка, cross-source dedup,
 * порядок записей, заголовок и безопасная запись.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { InventoryItem, ItemKind } from "../scripts/inventory.mts";
import { parsePo } from "../scripts/po_file.mts";
import {
  distribution,
  formatReport,
  looksLikeProse,
} from "../../../../scripts/pot_provenance_report.mts";
import {
  applySrcPolicy,
  applySkipIds,
  applySkipPolicy,
  parseSkipIds,
  buildCatalog,
  catalogSize,
  ctxtOf,
  discoverSkipPolicyPath,
  formatPotDate,
  formatSkipReport,
  KNOWN_RAW_CLASSES,
  main,
  parseSkipPolicy,
  parseSrcPolicy,
  policyDecision,
  renderExcludedJsonl,
  repairFragment,
  renderPot,
  renderSkipJournalJsonl,
  runPotgen,
  srcMatchesPattern,
  stripFontTags,
  triageReason,
  validatePolicyPattern,
  writeAtomic,
  type SkipPolicy,
} from "../scripts/potgen.mts";
import {
  classifyRich,
  hasLetters,
  isMeaningfulText,
  skipConditionMatches,
  stripTmpTags,
  TMP_TAGS,
} from "../scripts/pot_skip.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
const FIXTURE = join(import.meta.dirname, "..", "test_data", "tiny-dump");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "potgen-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

function item(partial: Partial<InventoryItem> & { text: string; kind: ItemKind }): InventoryItem {
  return { speaker: "", richText: "", source: "test", idx: 0, src: "raw:test", ...partial };
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
    // Тест про каталог и rich, а не про политику: без неё фикстура целиком.
    policyPath: null,
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

test("buildCatalog: src пишется первым комментарием и не перетирается дублем", () => {
  const items = [
    item({ text: "Hi", speaker: "Zoey", kind: "dlg", src: "dialog", richText: "<i>Hi</i>" }),
    item({ text: "Hi", speaker: "Zoey", kind: "dlg", src: "raw:Other" }),
  ];
  const { catalog } = buildCatalog(items);
  const slot = catalog.get("Hi")?.get("speaker:Zoey");
  assert.equal(slot?.src, "dialog", "метка первого вхождения");
  const text = renderPot(catalog, "2026-01-02 03:04+0000");
  assert.ok(text.includes("#. src: dialog\n#. rich_text: <i>Hi</i>"), text);
  // `includeSrc: false` — только для POT до провенанса.
  assert.ok(!renderPot(catalog, "2026-01-02 03:04+0000", { includeSrc: false }).includes("src:"));
});

test("renderPot: метки не меняют записи — добавляется только комментарий src", () => {
  const items = [
    item({ text: "Hi", speaker: "Zoey", kind: "dlg", src: "dialog", richText: "<i>Hi</i>" }),
    item({ text: "BACK", kind: "raw", src: "raw:MonoBehaviour" }),
    item({ text: "New Game", kind: "set", src: "settings" }),
  ];
  const { catalog } = buildCatalog(items);
  const withSrc = renderPot(catalog, "2026-01-02 03:04+0000");
  const without = renderPot(catalog, "2026-01-02 03:04+0000", { includeSrc: false });
  assert.equal(withSrc.replace(/^#\. src: .*\n/gm, ""), without);
  assert.equal(parsePo(withSrc).filter((e) => e.msgid).length, 3);
});

test("distribution: инвентарь → ключи → POT и мягкий тест прозы (синтетика)", () => {
  const items = [
    item({ text: "Hi there friend", kind: "dlg", speaker: "Zoey", src: "dialog" }),
    item({ text: "Hi there friend", kind: "raw", src: "raw:Other" }),
    item({ text: "Back", kind: "set", src: "settings" }),
    item({ text: "Back", kind: "raw", src: "raw:MonoBehaviour" }),
    item({ text: "Where is my mind?", kind: "raw", src: "field:m_text" }),
    item({ text: "+5?GNRSSS", kind: "raw", src: "raw:Font" }),
  ];
  const { catalog } = buildCatalog(items);
  const stats = distribution(items, catalog);
  const bySrc = new Map(stats.map((s) => [s.src, s]));
  assert.equal(bySrc.get("dialog")?.items, 1);
  assert.equal(bySrc.get("dialog")?.pot, 1);
  assert.equal(bySrc.get("settings")?.pot, 1);
  // "Back" из settings стал ui-двойником? Нет: у него нет диалогового ключа,
  // но второй "Back" — raw с тем же ctxt "ui", значит один POT-ключ.
  assert.equal((bySrc.get("settings")?.pot ?? 0) + (bySrc.get("raw:MonoBehaviour")?.pot ?? 0), 1);
  assert.equal(bySrc.get("field:m_text")?.prose, 1);
  assert.equal(bySrc.get("raw:Font")?.prose, 0);
  // Порядок меток стабилен: dialog → ... → settings → ... → raw:*.
  assert.deepEqual(
    stats.map((s) => s.src),
    ["dialog", "field:m_text", "settings", "raw:Font", "raw:MonoBehaviour", "raw:Other"],
  );
  const totalPot = stats.reduce((n, s) => n + s.pot, 0);
  assert.equal(totalPot, 4, "dialog + Back + Where + +5?GNRSSS");
  assert.equal(looksLikeProse("+5?GNRSSS"), false);
  assert.equal(looksLikeProse("Hi there friend"), true);
  assert.equal(looksLikeProse("Where is my mind?"), true);
  assert.equal(looksLikeProse("A dick."), false, "меньше 3 слов");
});

test("formatReport: таблица и примеры содержат все источники", () => {
  const items = [item({ text: "Hi there friend", kind: "dlg", speaker: "Zoey", src: "dialog" })];
  const { catalog } = buildCatalog(items);
  const md = formatReport(distribution(items, catalog), {
    candidates: 0,
    inPot: 0,
    prose: 0,
    examples: [],
  });
  assert.ok(md.includes("| `src` | в инвентаре | ключей | в POT |"));
  assert.ok(md.includes("| `dialog` | 1 | 1 | 1 |"));
  assert.ok(md.includes("### `dialog` — 1 в POT"));
  assert.ok(md.includes("`global` — кандидаты"));
});

// ---------------------------------------------------------------------------
// Политика отбора по провенансу (`config/pot-src-policy.json`).
// ---------------------------------------------------------------------------

test("parseSrcPolicy: пустая политика = как раньше (exclude [], include ['*'])", () => {
  const policy = parseSrcPolicy("{}", "empty.json");
  assert.deepEqual(policy.exclude, []);
  assert.deepEqual(policy.include, ["*"]);
});

test("parseSrcPolicy: невалидный JSON — понятная ошибка с путём", () => {
  assert.throws(
    () => parseSrcPolicy('{"exclude": ["raw:Font"}', "bad.json"),
    /невалидный JSON политики bad\.json/,
  );
});

test("parseSrcPolicy: неизвестное поле — ошибка (опечатка не игнорируется)", () => {
  assert.throws(
    () => parseSrcPolicy('{"exlude": ["raw:Font"]}', "p.json"),
    /неизвестное поле "exlude"/,
  );
});

test("parseSrcPolicy: неизвестная метка и пустой include — ошибки, а не молчание", () => {
  assert.throws(
    () => parseSrcPolicy('{"exclude": ["raw:Fontt"]}', "p.json"),
    /неизвестная метка "raw:Fontt"/,
  );
  assert.throws(
    () => parseSrcPolicy('{"exclude": ["dilog"]}', "p.json"),
    /неизвестная метка "dilog"/,
  );
  assert.throws(() => parseSrcPolicy('{"include": []}', "p.json"), /include.*пуст/);
});

test("validatePolicyPattern: точные метки, префиксы и wildcard", () => {
  for (const ok of [
    "*",
    "dialog",
    "raw:Font",
    "raw:Tex*",
    "raw:*",
    "field:m_Name",
    "field:*",
    "dialog*",
    "raw:ClassID0*",
  ]) {
    assert.equal(validatePolicyPattern(ok), null, `должно быть валидно: ${ok}`);
  }
  for (const bad of ["", "raw:", "dilog", "raw:Fontt", "raw:Zzz*", "field:1bad"]) {
    assert.ok(validatePolicyPattern(bad), `должно быть ошибкой: ${bad}`);
  }
});

test("policyDecision: exclude — точная метка или префикс, include — допуск", () => {
  const policy = parseSrcPolicy('{"exclude":["raw:Font","raw:Tex*"],"include":["*"]}', "p");
  assert.equal(srcMatchesPattern("raw:Font", "raw:Font"), true);
  assert.equal(srcMatchesPattern("raw:Font", "raw:FontX"), false, "точная метка не префикс");
  assert.equal(srcMatchesPattern("raw:Tex*", "raw:Texture2D"), true);
  assert.deepEqual(policyDecision(policy, "raw:Font"), {
    excluded: true,
    reason: "exclude:raw:Font",
  });
  assert.deepEqual(policyDecision(policy, "raw:Texture2D"), {
    excluded: true,
    reason: "exclude:raw:Tex*",
  });
  assert.deepEqual(policyDecision(policy, "raw:MonoBehaviour"), { excluded: false, reason: "" });

  const whitelist = parseSrcPolicy('{"include":["dialog","raw:*"]}', "p");
  assert.equal(policyDecision(whitelist, "settings").reason, "not-included");
  assert.equal(policyDecision(whitelist, "raw:Font").excluded, false);
});

test("applySrcPolicy: исключённые уходят в журнал, POT их не видит", () => {
  const items = [
    item({ text: "Hi", kind: "dlg", speaker: "Zoey", src: "dialog" }),
    item({ text: "Arial", kind: "raw", src: "raw:Font" }),
    item({ text: "Body", kind: "raw", src: "raw:Texture2D" }),
    item({ text: "Keep me", kind: "raw", src: "raw:TextAsset" }),
  ];
  const { catalog } = buildCatalog(items);
  const policy = parseSrcPolicy('{"exclude":["raw:Font","raw:Texture*"]}', "p");
  const applied = applySrcPolicy(catalog, policy);

  assert.equal(catalogSize(applied.catalog), 2, "dialog + TextAsset остались");
  assert.deepEqual(
    applied.excluded.map((e) => e.msgid),
    ["Arial", "Body"],
    "журнал отсортирован по (msgid, msgctxt)",
  );
  assert.deepEqual(applied.excluded[0], {
    src: "raw:Font",
    msgid: "Arial",
    msgctxt: "ui",
    reason: "exclude:raw:Font",
  });
  assert.deepEqual(applied.bySrc, [
    { src: "raw:Font", count: 1 },
    { src: "raw:Texture2D", count: 1 },
  ]);
});

test("renderExcludedJsonl: строка JSONL на запись, валидный JSON", () => {
  const entries = [
    { src: "raw:Font", msgid: "B\nB", msgctxt: "ui", reason: "exclude:raw:Font" },
    { src: "dialog", msgid: "A", msgctxt: "speaker:Zoey", reason: "not-included" },
  ];
  const text = renderExcludedJsonl(entries);
  assert.ok(text.endsWith("\n"));
  const rows = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, string>);
  assert.deepEqual(rows[0], {
    src: "raw:Font",
    msgid: "B\nB",
    msgctxt: "ui",
    reason: "exclude:raw:Font",
  });
  assert.deepEqual(rows[1], {
    src: "dialog",
    msgid: "A",
    msgctxt: "speaker:Zoey",
    reason: "not-included",
  });
  assert.equal(renderExcludedJsonl([]), "");
});

test("runPotgen: политика выкидывает из POT и пишет журнал; пустая = как раньше", async () => {
  const dir = join(root, "policy");
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "policy.json");
  writeFileSync(policyPath, '{"exclude":["raw:MonoBehaviour"]}', "utf8");

  const out = join(dir, "with-policy.pot");
  const excludedPath = join(dir, "excluded.jsonl");
  const res = await runPotgen({
    dumpDir: FIXTURE,
    outPath: out,
    created: "2026-01-02 03:04+0000",
    policyPath,
    excludedPath,
  });

  assert.equal(res.entries, 7, "10 записей минус 3 из raw:MonoBehaviour");
  assert.equal(res.policy?.excluded, 3);
  assert.deepEqual(res.policy?.bySrc, [{ src: "raw:MonoBehaviour", count: 3 }]);
  assert.ok(res.bytes > 0);
  const pot = readFileSync(out, "utf8");
  assert.ok(!pot.includes('msgid "BACK"'), "исключённой записи в POT нет");
  assert.ok(pot.includes('msgid "New Game"'), "остальные записи на месте");

  const rows = readFileSync(excludedPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { src: string; msgid: string; reason: string });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.src === "raw:MonoBehaviour"));
  assert.ok(rows.every((r) => r.reason === "exclude:raw:MonoBehaviour"));
  assert.ok(rows.some((r) => r.msgid === "BACK"));
  assert.equal(existsSync(`${excludedPath}.part`), false);

  // Пустая политика: POT побайтово как при выключенной, журнал пуст.
  writeFileSync(policyPath, '{"exclude":[],"include":["*"]}', "utf8");
  const emptyOut = join(dir, "empty-policy.pot");
  const emptyExcluded = join(dir, "empty-excluded.jsonl");
  const empty = await runPotgen({
    dumpDir: FIXTURE,
    outPath: emptyOut,
    created: "2026-01-02 03:04+0000",
    policyPath,
    excludedPath: emptyExcluded,
  });
  const noPolicyOut = join(dir, "no-policy.pot");
  const none = await runPotgen({
    dumpDir: FIXTURE,
    outPath: noPolicyOut,
    created: "2026-01-02 03:04+0000",
    policyPath: null,
  });
  assert.equal(readFileSync(emptyOut, "utf8"), readFileSync(noPolicyOut, "utf8"));
  assert.equal(empty.policy?.excluded, 0);
  assert.equal(none.policy, null);
  assert.equal(readFileSync(emptyExcluded, "utf8"), "");
});

test("runPotgen: невалидная политика — ошибка, POT не пишется", async () => {
  const dir = join(root, "bad-policy");
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "policy.json");
  writeFileSync(policyPath, '{"exclude":["raw:Fontt"]}', "utf8");
  const out = join(dir, "out.pot");
  await assert.rejects(
    runPotgen({ dumpDir: FIXTURE, outPath: out, policyPath }),
    /неизвестная метка "raw:Fontt"/,
  );
  assert.equal(existsSync(out), false);
});

test("knownRawClasses: TS-список = unity_classes.mts = Rust-список", () => {
  const unity = readFileSync(
    join(REPO, ".opencode/skills/dump-assets/scripts/unity_classes.mts"),
    "utf8",
  );
  const fromDumper = [...unity.matchAll(/^\s+\d+: "([^"]+)",$/gm)].map((m) => m[1]);
  const ours = KNOWN_RAW_CLASSES.filter((name) => name !== "unknown");
  assert.deepEqual([...ours].sort(), [...fromDumper].sort());

  const rs = readFileSync(join(REPO, "tools/rust-l10n/src/potgen.rs"), "utf8");
  const start = rs.indexOf("pub const KNOWN_RAW_CLASSES");
  assert.ok(start >= 0, "в potgen.rs есть KNOWN_RAW_CLASSES");
  const block = rs.slice(start, rs.indexOf("];", start));
  const fromRust = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...KNOWN_RAW_CLASSES].sort(), [...fromRust].sort());
});

// --- паритет TS ↔ Rust с политикой и без (нужен собранный бинарь и дамп) ---
const RUST_BIN = [
  join(REPO, "tools/rust-l10n/target/release/rust-l10n.exe"),
  join(REPO, "tools/rust-l10n/target/release/rust-l10n"),
].find((p) => existsSync(p));
const parityDump =
  process.env.TCNN_DUMP_DIR ??
  ["tmp/dump-after", "tmp/dump-new", "tmp/dump"]
    .map((rel) => join(REPO, rel))
    .find((dir) => existsSync(dir));
const paritySkip = RUST_BIN && parityDump ? false : "нужен rust-l10n (npm run l10n:build) и дамп";

test(
  "паритет TS ↔ Rust: POT и журнал байт-в-байт (с политикой и без)",
  { skip: paritySkip },
  async () => {
    const dir = join(root, "parity");
    mkdirSync(dir, { recursive: true });
    const policyPath = join(REPO, "config", "pot-src-policy.json");
    for (const mode of ["with", "without"] as const) {
      const tsPot = join(dir, `${mode}-ts.pot`);
      const rustPot = join(dir, `${mode}-rust.pot`);
      const tsExcluded = join(dir, `${mode}-ts.jsonl`);
      const rustExcluded = join(dir, `${mode}-rust.jsonl`);
      const tsSkip = join(dir, `${mode}-ts-skip.jsonl`);
      const rustSkip = join(dir, `${mode}-rust-skip.jsonl`);
      const policyArg = mode === "with" ? policyPath : null;

      const res = await runPotgen({
        dumpDir: parityDump as string,
        outPath: tsPot,
        created: "2026-01-02 03:04+0000",
        policyPath: policyArg,
        excludedPath: tsExcluded,
        skipJournalPath: tsSkip,
      });
      const args = [
        "potgen",
        "--root",
        REPO,
        "--dump",
        parityDump as string,
        "--out",
        rustPot,
        "--created",
        "2026-01-02 03:04+0000",
        "--excluded",
        rustExcluded,
        "--skip-journal",
        rustSkip,
        ...(policyArg ? ["--policy", policyArg] : ["--no-policy"]),
      ];
      const run = spawnSync(RUST_BIN as string, args, { encoding: "utf8" });
      assert.equal(run.status, 0, `rust-l10n ${args.join(" ")}: ${run.stderr}`);

      assert.equal(readFileSync(rustPot, "utf8"), readFileSync(tsPot, "utf8"), `${mode}: POT`);
      // Журнал skip — тоже побайтово (метка правила, порядок POT).
      assert.equal(readFileSync(rustSkip, "utf8"), readFileSync(tsSkip, "utf8"), `${mode}: skip`);
      assert.equal(
        res.skip?.marked,
        readFileSync(tsSkip, "utf8").split(/\r?\n/).filter(Boolean).length,
        "журнал skip содержит ровно помеченные записи",
      );
      if (policyArg) {
        // Число исключённых зависит от данных политики (меняется вместе с config/),
        // поэтому проверяем инвариант, а не магическое число: журнал = исключённые.
        const excludedCount = res.policy?.excluded ?? 0;
        assert.ok(excludedCount > 0, "политика действительно исключает");
        assert.equal(
          excludedCount,
          readFileSync(tsExcluded, "utf8").split(/\r?\n/).filter(Boolean).length,
          "журнал содержит ровно исключённые записи",
        );
        assert.equal(
          readFileSync(rustExcluded, "utf8"),
          readFileSync(tsExcluded, "utf8"),
          `${mode}: журнал`,
        );
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Skip-логика (`pot_skip.mts`) — ОДНА реализация для инварианта и политики.
//
// Главный тест — ловушка 2026-11-23: наивная чистка `<[^>]+>` съедает
// авторские кавычки `< … >` вместе с настоящим тегом, и дефект маскируется
// (три разовых скрипта дали 0 обрывков там, где баг есть).
// ---------------------------------------------------------------------------

const REAL_FRAGMENT =
  "<i>< Like this, hmmm...? I love these nice big tits. Especially when adorable " +
  "customers like <b>you</b> request them. >";

/** Наивная чистка `<[^>]+>` — ровно так «теряется» дефект. */
function naiveStrip(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

test("ловушка: наивная чистка даёт совпадение, умная — нет", () => {
  assert.equal(naiveStrip(REAL_FRAGMENT), "you request them. >", "наивная чистка маскирует дефект");
  const plain = stripTmpTags(REAL_FRAGMENT);
  assert.ok(plain.startsWith("< Like this"), "авторские кавычки остались текстом");
  assert.ok(!plain.includes("<b>"), "настоящий тег <b> снят");
  assert.ok(plain.includes("like you request them. >"));
  assert.notEqual(plain, "you request them. >");
});

test("stripTmpTags: список тегов — данные, цвета и закрывающие снимаются", () => {
  assert.equal(stripTmpTags("<color=#EB83FF><i>Hi</i></color>"), "Hi");
  assert.equal(stripTmpTags("<B>Hi</B>"), "Hi", "регистр не важен");
  assert.equal(stripTmpTags("<size=40>Hi</size>"), "Hi");
  assert.equal(stripTmpTags("<sprite name=x>Hi"), "Hi", "самозакрывающийся");
  assert.equal(stripTmpTags("<< not a tag >>"), "<< not a tag >>");
  assert.equal(stripTmpTags("<colored>Hi</colored>"), "<colored>Hi</colored>", "имя с границей");
  assert.ok(TMP_TAGS.includes("line-height"), "тег с дефисом живёт в списке");
});

test("classifyRich: обрывок — хвост полного текста, порог и mismatch", () => {
  const check = classifyRich("you request them. >", REAL_FRAGMENT);
  assert.equal(check.relation, "suffix");
  assert.ok(check.plain.endsWith("you request them. >"));

  assert.equal(isMeaningfulText(">"), false);
  assert.equal(isMeaningfulText("short"), false, "10 символов, но одно слово");
  assert.equal(isMeaningfulText("two words!"), true);
  assert.equal(
    classifyRich(">", "<< Declination processed. Proceeding relocation. >>").relation,
    "noise",
  );

  const rich =
    "Your new Neon-Trust Reserve account is now open! Your new pin number is as " +
    "follows... <<color=yellow>7192</color>>";
  assert.equal(
    classifyRich(
      "Your new Neon-Trust Reserve account is now open! Your new pin number is as follows... 7192>",
      rich,
    ).relation,
    "mismatch",
  );

  for (const [id, okRich] of [
    ["Hi", "<i>Hi</i>"],
    ["Hi", "<color=#EB83FF><i>Hi</i></color>"],
    ["Hi", "<B>Hi</B>"],
    ["> Cum for me.", "<i> > Cum for me."],
  ]) {
    assert.equal(classifyRich(id, okRich).relation, "ok", okRich);
  }
});

test("условия правил: noLetters / shortToken / noWord / fragment", () => {
  assert.ok(hasLetters("!AL7"), "буквы A и L есть");
  assert.ok(!hasLetters("«123»"));
  assert.ok(skipConditionMatches("noLetters", { msgid: "«123»", rich: "" }));
  assert.ok(skipConditionMatches("shortToken", { msgid: "?|b", rich: "" }));
  // Примеры владельца оба С ПРОБЕЛОМ — shortToken их не ловит, ловит noWord.
  assert.ok(!skipConditionMatches("shortToken", { msgid: "w? |b", rich: "" }));
  assert.ok(!skipConditionMatches("shortToken", { msgid: "wK Ax", rich: "" }));
  assert.ok(!skipConditionMatches("shortToken", { msgid: "abcdefghijklm", rich: "" }));
  // noWord: нет ни одного токена из >=3 букв.
  assert.ok(skipConditionMatches("noWord", { msgid: "w? |b", rich: "" }));
  assert.ok(skipConditionMatches("noWord", { msgid: "wK Ax", rich: "" }));
  assert.ok(skipConditionMatches("noWord", { msgid: "j A", rich: "" }));
  assert.ok(skipConditionMatches("noWord", { msgid: "v 0.5.7-pr", rich: "" }), "pr — 2 буквы");
  // Настоящие подписи остаются: в них есть слово.
  assert.ok(!skipConditionMatches("noWord", { msgid: "ACCESS", rich: "" }));
  assert.ok(!skipConditionMatches("noWord", { msgid: "SAVEFILENAME", rich: "" }));
  assert.ok(
    skipConditionMatches("noWord", { msgid: "UI", rich: "" }),
    "две буквы — не слово (в POT такой записи нет, но правило обязано быть точным)",
  );
  assert.ok(!skipConditionMatches("noWord", { msgid: "x y ZZZ", rich: "" }), "ZZZ — слово");
  // identifier: структура имени, а не «вид».
  for (const id of ["AbilityName", "Camera_Flash", "DEFAULT_KEY", "Char_Klaudia", "MainUI"]) {
    assert.ok(skipConditionMatches("identifier", { msgid: id, rich: "" }), `identifier: ${id}`);
  }
  for (const id of ["ACCESS", "Accept", "ARRIVAL", "Aaron", "Neon-Trust", "AC/DС"]) {
    assert.ok(!skipConditionMatches("identifier", { msgid: id, rich: "" }), `не identifier: ${id}`);
  }
  // tokens: шаблон с подстановкой — формат, а не текст.
  for (const id of [
    "Received #ItemName#.",
    "#TakenFromInventoryText# #ItemName#.",
    "E#M#",
    "Hi %s",
    "{Count} items",
  ]) {
    assert.ok(skipConditionMatches("tokens", { msgid: id, rich: "" }), `tokens: ${id}`);
  }
  for (const id of ["Received the item.", "100% sure", "Hi there"]) {
    assert.ok(!skipConditionMatches("tokens", { msgid: id, rich: "" }), `не tokens: ${id}`);
  }
  // hexColor: явный #RRGGBB — константа; без # не срабатывает.
  for (const id of ["#FFD24A", "#8A8F98", "#FFF", "#A64141"]) {
    assert.ok(skipConditionMatches("hexColor", { msgid: id, rich: "" }), `hex: ${id}`);
  }
  for (const id of ["ADDDDD", "EDDDDD", "#FFD24G", "Color #FFF", "FFD24A"]) {
    assert.ok(!skipConditionMatches("hexColor", { msgid: id, rich: "" }), `не hex: ${id}`);
  }
  // saveKey: идентификатор сохранения, а не реплика.
  for (const id of [
    "GlowingHoleKeys/103 Peeking Counter",
    "CartelHideoutBadendKeys/Did get naked",
    "Character Keys/Did stare at Lios Dick",
  ]) {
    assert.ok(skipConditionMatches("saveKey", { msgid: id, rich: "" }), `save-key: ${id}`);
  }
  for (const id of ["24/7 Kiosk", "Annoyed / Angry", "AMS/UI SoftMask", "Keys of the city"]) {
    assert.ok(!skipConditionMatches("saveKey", { msgid: id, rich: "" }), `не save-key: ${id}`);
  }
  // snakeCase: имена ассетов/состояний/отладка Unity, а не текст для игрока.
  for (const id of [
    "CC_Option_Outfit_Futereswear Skintight Suit Dark",
    "Apl_Female_Carte_Suit2 Grey",
    "PMA_ClearPathfindingTarget: FollowerEntity is disabled!",
    "Inspection_Lio_Crotch",
  ]) {
    assert.ok(skipConditionMatches("snakeCase", { msgid: id, rich: "" }), `snake: ${id}`);
  }
  for (const id of ["Change", "24/7 Kiosk", "Annoyed / Angry", "Alpha: N/A", "Neon-Trust"]) {
    assert.ok(!skipConditionMatches("snakeCase", { msgid: id, rich: "" }), `не snake: ${id}`);
  }
  // codeRef: путь без расширения или имя типа .NET — код, а не текст.
  for (const id of ["Dialogue/Auto", "AnimationViewer, Assembly-CSharp"]) {
    assert.ok(skipConditionMatches("codeRef", { msgid: id, rich: "" }), `code: ${id}`);
  }
  for (const id of ["24/7 Kiosk", "Annoyed / Angry", "AMS/UI SoftMask", "a b/c"]) {
    assert.ok(!skipConditionMatches("codeRef", { msgid: id, rich: "" }), `не code: ${id}`);
  }

  // stateName: метки веток диалога (Bark 12, Choice1) — не текст для игрока.
  for (const id of ["Bark 12", "Bark2 3", "Choice1", "Agree2", "Disable2"]) {
    assert.ok(skipConditionMatches("stateName", { msgid: id, rich: "" }), `state: ${id}`);
  }
  for (const id of ["Leave", "Agree", "Check", "Look at that", "Check 2nd Save Key"]) {
    assert.ok(!skipConditionMatches("stateName", { msgid: id, rich: "" }), `не state: ${id}`);
  }

  // fsmLabel: метка машины состояний Unity, а не текст для игрока.
  for (const id of ["FSM Lio Printer", "FSM Nova Moving In", "Fsm Nova Move"]) {
    assert.ok(skipConditionMatches("fsmLabel", { msgid: id, rich: "" }), `fsm: ${id}`);
  }
  for (const id of ["FSMatic", "The FSM is broken", "FSM"]) {
    assert.ok(!skipConditionMatches("fsmLabel", { msgid: id, rich: "" }), `не fsm: ${id}`);
  }
  assert.ok(
    skipConditionMatches("fragment", { msgid: "you request them. >", rich: REAL_FRAGMENT }),
  );
  assert.ok(!skipConditionMatches("fragment", { msgid: ">", rich: "<< x >>" }));
});

// ---------------------------------------------------------------------------
// Skip-политика: данные, ошибки не молчат, записи не удаляются.
// ---------------------------------------------------------------------------

test("parseSkipPolicy: валидная политика и понятные ошибки", () => {
  const policy = parseSkipPolicy(
    '{"rules":[{"id":"no-letters","src":"raw:*","when":"noLetters"}]}',
    "p.json",
  );
  assert.equal(policy.rules.length, 1);
  assert.equal(policy.rules[0].enabled, true);

  assert.throws(
    () => parseSkipPolicy('{"rules":[{"id":"x","src":"raw:*","when":"nope"}]}', "p.json"),
    /неизвестное условие "nope".*noLetters, shortToken, noWord, identifier, tokens, hexColor, assetPath, saveKey, snakeCase, fsmLabel, stateName, codeRef, fragment/,
  );
  assert.throws(
    () => parseSkipPolicy('{"rules":[{"id":"x","src":"raw:Fontt","when":"noLetters"}]}', "p.json"),
    /неизвестная метка "raw:Fontt"/,
  );
  assert.throws(
    () =>
      parseSkipPolicy(
        '{"rules":[{"id":"x","src":"*","when":"noLetters"},{"id":"x","src":"*","when":"fragment"}]}',
        "p.json",
      ),
    /повторяется/,
  );
  assert.throws(() => parseSkipPolicy('{"rules":[],"rulez":[]}', "p.json"), /неизвестное поле/);
  assert.throws(
    () => parseSkipPolicy('{"rules":[{"id":"Bad Id","src":"*","when":"fragment"}]}', "p.json"),
    /id/,
  );
  const disabled = parseSkipPolicy(
    '{"rules":[{"id":"x","src":"*","when":"fragment","enabled":false}]}',
    "p.json",
  );
  assert.equal(disabled.rules[0].enabled, false);
});

test("applySkipPolicy: помечает, не удаляет, журнал в порядке POT", () => {
  const items = [
    item({ text: "wK Ax", kind: "raw", src: "raw:MonoBehaviour" }),
    item({ text: "?|b", kind: "raw", src: "raw:Transform" }),
    item({ text: "Real UI line", kind: "set", src: "settings" }),
    item({ text: "you request them. >", kind: "dlg", src: "dialog", richText: REAL_FRAGMENT }),
  ];
  const { catalog } = buildCatalog(items);
  const policy: SkipPolicy = parseSkipPolicy(
    JSON.stringify({
      rules: [
        { id: "short-token", src: "raw:*", when: "shortToken" },
        { id: "fragment", src: "*", when: "fragment" },
      ],
    }),
    "p.json",
  );
  const applied = applySkipPolicy(catalog, policy);
  assert.equal(catalogSize(catalog), 4, "записи не удалены");
  // Обрывок больше НЕ помечается: он починен полной фразой из rich_text,
  // поэтому правило `fragment` к нему не применимо.
  assert.equal(applied.marked, 1, "только ?|b (short-token)");
  assert.deepEqual(applied.byRule, [
    { rule: "short-token", count: 1 },
    { rule: "fragment", count: 0 },
  ]);
  assert.deepEqual(
    applied.journal.map((j) => [j.rule, j.msgid]),
    [["short-token", "?|b"]],
    "в журнале только структурная метка",
  );
  assert.equal(catalog.get("?|b")?.get("ui")?.skip, "short-token");
  assert.equal(catalog.get("wK Ax")?.get("ui")?.skip, undefined, "пробел = не короткий токен");

  const pot = renderPot(catalog, "2026-01-02 03:04+0000");
  assert.ok(pot.includes('#, skip\nmsgctxt "ui"\nmsgid "?|b"'), pot);
  assert.ok(!pot.includes("#. skip: fragment"), pot);
  assert.ok(pot.includes("#. repaired: you request them. >"), pot);
  const jsonl = renderSkipJournalJsonl(applied.journal);
  assert.equal(jsonl.trim().split("\n").length, 1);
});

test("runPotgen: skip-метки в POT, журнал и выключатель политики", async () => {
  const dir = join(root, "skip");
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "skip.json");
  writeFileSync(
    policyPath,
    JSON.stringify({ rules: [{ id: "short-token", src: "raw:*", when: "shortToken" }] }),
    "utf8",
  );
  const out = join(dir, "with-skip.pot");
  const journal = join(dir, "skip.jsonl");
  const res = await runPotgen({
    dumpDir: FIXTURE,
    outPath: out,
    created: "2026-01-02 03:04+0000",
    policyPath: null,
    skipPolicyPath: policyPath,
    skipJournalPath: journal,
  });
  assert.ok(res.skip && res.skip.marked > 0, "мини-дамп содержит короткие raw-токены");
  const pot = readFileSync(out, "utf8");
  assert.ok(pot.includes("#, skip"), "метка стоит в POT");
  const ids = [...pot.matchAll(/#\. skip: ([\w-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(ids)], ["short-token"]);
  const rows = readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, res.skip?.marked);
  assert.ok(rows.every((r) => r.rule === "short-token"));
  assert.equal(existsSync(`${journal}.part`), false);
  // Отчёт печатается по правилам.
  assert.ok(formatSkipReport(res.skip).some((l) => l.includes("short-token")));

  // Выключено — POT без меток и без журнала.
  const offOut = join(dir, "off.pot");
  const off = await runPotgen({
    dumpDir: FIXTURE,
    outPath: offOut,
    created: "2026-01-02 03:04+0000",
    policyPath: null,
    skipPolicyPath: null,
  });
  assert.equal(off.skip, null);
  assert.equal(off.skipJournalPath, null);
  assert.ok(!readFileSync(offOut, "utf8").includes("#, skip"));
});

test("skip-политика находится от корня репозитория", () => {
  const found = discoverSkipPolicyPath(REPO);
  assert.ok(found, "config/pot-skip-policy.json");
  assert.ok(found?.endsWith("pot-skip-policy.json"));
});

test("repairFragment: хвост полной фразы чинится, нормальный текст — нет", () => {
  const plain = "< It's all about your comfort, hon. I'll be anything you want me to be. >";
  assert.deepEqual(
    repairFragment("your comfort, hon. I'll be anything you want me to be. >", plain),
    {
      text: plain,
      original: "your comfort, hon. I'll be anything you want me to be. >",
    },
  );
  assert.equal(repairFragment(plain, plain), null, "уже полный — не трогаем");
  assert.equal(repairFragment("Hello", "Hello there"), null, "не хвост");
  assert.equal(repairFragment("123", "< 123"), null, "перед хвостом нет букв");
});

test("buildCatalog: обрывок становится полной фразой, старый хвост — в комментарии", () => {
  const tail = "you request them. >";
  const full =
    "< Like this, hmmm...? I love these nice big tits. Especially when adorable customers like you request them. >";
  const { catalog } = buildCatalog([
    item({ text: tail, kind: "dlg", src: "dialog", richText: `<i>${full}</i>` }),
  ]);
  assert.equal(catalog.has(tail), false, "обрезанного ключа больше нет");
  const slot = catalog.get(full)?.get("ui");
  assert.ok(slot, "ключом стала полная фраза");
  assert.deepEqual(
    slot.comments.find((c) => c.startsWith("repaired: ")),
    `repaired: ${tail}`,
    "исходный хвост сохранён для аудита",
  );

  // Не-обрывок не меняется.
  const { catalog: plainCatalog } = buildCatalog([
    item({ text: "Just a line", kind: "dlg", src: "dialog" }),
  ]);
  assert.ok(plainCatalog.has("Just a line"));
});

test("buildCatalog: при дубле побеждает живой источник, а не исключённый ассет", () => {
  const policy = parseSrcPolicy(
    JSON.stringify({ exclude: ["raw:GameObject"], include: ["*"] }),
    "p.json",
  );
  const isExcluded = (src: string): boolean => policyDecision(policy, src).excluded;
  const asset = () => item({ text: "Hello", kind: "raw", src: "raw:GameObject" });
  const dialog = () => item({ text: "Hello", kind: "dlg", src: "dialog" });

  // Порядок 1: ассет первым.  Порядок 2: живой первым.
  for (const items of [
    [asset(), dialog()],
    [dialog(), asset()],
  ]) {
    const { catalog } = buildCatalog(items, new Set(), isExcluded);
    assert.equal(
      catalog.get("Hello")?.get("ui")?.src,
      "dialog",
      "метка обязана стать живой: иначе срез ассетов унесёт настоящий текст",
    );
  }

  // Только ассет — политика убирает запись, журнал её фиксирует.
  const onlyAsset = buildCatalog([asset()], new Set(), isExcluded);
  const applied = applySrcPolicy(onlyAsset.catalog, policy);
  assert.equal(applied.catalog.size, 0, "ассетная строка исключена");
  assert.equal(applied.excluded[0]?.src, "raw:GameObject");
});

test("parseSkipIds: валидный список и понятные ошибки", () => {
  assert.deepEqual([...parseSkipIds('{"skip":["A","B"]}')], ["A", "B"]);
  assert.throws(() => parseSkipIds('{"skip":"A"}'), /должно быть массивом строк/);
  assert.throws(() => parseSkipIds('{"skip":[1]}'), /ожидалась непустая строка/);
  assert.throws(() => parseSkipIds('{"skips":[]}'), /неизвестное поле/);
  assert.throws(() => parseSkipIds("[]"), /ожидался объект/);
});

test("applySkipIds: помечает только новые, считает неиспользованные", () => {
  const items = [
    item({ text: "BUUYC", kind: "raw", src: "raw:MonoBehaviour" }),
    item({ text: "ACCESS", kind: "raw", src: "raw:MonoBehaviour" }),
    item({ text: "junk-structural", kind: "raw", src: "raw:MonoBehaviour" }),
  ];
  const { catalog } = buildCatalog(items);
  const structural = applySkipPolicy(catalog, parseSkipPolicy('{"rules":[]}', "p"));
  assert.equal(structural.marked, 0);

  const applied = applySkipIds(catalog, new Set(["BUUYC", "junk-structural", "not-in-pot"]));
  assert.equal(applied.marked, 2, "две записи помечены");
  assert.equal(applied.unused, 1, "остаток списка виден");
  assert.equal(catalog.get("BUUYC")?.get("ui")?.skip, "reviewed");
  assert.equal(catalog.get("ACCESS")?.get("ui")?.skip, undefined, "текст не тронут");
  assert.deepEqual(
    applied.journal.map((j) => [j.rule, j.msgid]),
    [
      ["reviewed", "BUUYC"],
      ["reviewed", "junk-structural"],
    ],
    "порядок POT",
  );
});

test("applySkipPolicy: srcExclude сужает правило, не ломая остальные метки", () => {
  const items = [
    item({ text: "wK Ax", kind: "raw", src: "raw:MonoBehaviour" }),
    item({ text: "LAST MINUTE", kind: "raw", src: "raw:MonoBehaviour" }),
    item({ text: "CurtainsLeft", kind: "raw", src: "raw:GameObject" }),
    item({ text: "ZoeyBlink", kind: "raw", src: "raw:AnimatorController" }),
  ];
  const { catalog } = buildCatalog(items);
  const policy: SkipPolicy = parseSkipPolicy(
    JSON.stringify({
      rules: [
        {
          id: "short-token",
          src: "raw:*",
          srcExclude: ["raw:MonoBehaviour"],
          when: "shortToken",
        },
        { id: "no-word", src: "raw:*", when: "noWord" },
      ],
    }),
    "p.json",
  );
  const applied = applySkipPolicy(catalog, policy);
  assert.deepEqual(applied.byRule, [
    { rule: "short-token", count: 2 },
    { rule: "no-word", count: 1 },
  ]);
  assert.equal(
    catalog.get("wK Ax")?.get("ui")?.skip,
    "no-word",
    "MonoBehaviour исключён из short-token, но noWord его ловит",
  );
  assert.equal(
    catalog.get("LAST MINUTE")?.get("ui")?.skip,
    undefined,
    "в MonoBehaviour есть слово",
  );
  assert.equal(catalog.get("CurtainsLeft")?.get("ui")?.skip, "short-token");

  assert.throws(
    () =>
      parseSkipPolicy(
        '{"rules":[{"id":"x","src":"*","srcExclude":"raw:*","when":"fragment"}]}',
        "p.json",
      ),
    /srcExclude должен быть массивом/,
  );
  assert.throws(
    () =>
      parseSkipPolicy(
        '{"rules":[{"id":"x","src":"*","srcExclude":["raw:Fontt"],"when":"fragment"}]}',
        "p.json",
      ),
    /srcExclude: неизвестная метка/,
  );
});
