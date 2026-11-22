/**
 * Тесты `find_source.mts` (порт `find_source.py` через тестовые кейсы).
 *
 * Дамп — фикстура `test_data/tiny-dump` (без игры). Покрыто: точный матч,
 * порядок вхождений, `--first`, формат строки, срез 120 code points,
 * коды выхода 0/1/2.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import type { InventoryItem } from "../scripts/inventory.mts";
import { find, fmt, main } from "../scripts/find_source.mts";

const DUMP = join(import.meta.dirname, "..", "test_data", "tiny-dump");

function item(partial: Partial<InventoryItem> & { text: string }): InventoryItem {
  return {
    speaker: "",
    richText: "",
    kind: "raw",
    source: "x",
    idx: null,
    src: "raw:test",
    ...partial,
  };
}

/** Тихая обёртка CLI: ожидаемые ошибки не должны шуметь в выводе тестов. */
async function quietMain(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    return { code: await main(argv), out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test("find: точный матч находит все вхождения в порядке инвентаря", async () => {
  const hits = await find("Where are you going now, my dear friend?", { dumpDir: DUMP });
  assert.deepEqual(
    hits.map((h) => [h.kind, h.source, h.idx, h.speaker]),
    [
      ["bundle", "bundle_tiny", 0, "Zoey"],
      ["raw", "bundle_tiny_assets_all_abc123", 1, ""],
    ],
  );
});

test("find: --first останавливается на первом вхождении", async () => {
  const hits = await find("Where are you going now, my dear friend?", {
    dumpDir: DUMP,
    first: true,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "bundle");
});

test("find: совпадение только точное (регистр и подстроки не матчатся)", async () => {
  assert.deepEqual(await find("where are you going now, my dear friend?", { dumpDir: DUMP }), []);
  assert.deepEqual(await find("Welcome", { dumpDir: DUMP }), []);
  const exact = await find("Welcome back, Sarah.", { dumpDir: DUMP });
  assert.equal(exact.length, 1, "дубликат внутри одного объекта дедуплицирован");
  assert.deepEqual([exact[0].kind, exact[0].idx], ["dlg", 0]);
});

test("fmt: kind:source#idx, speaker и текст", async () => {
  assert.equal(
    fmt(item({ text: "Hi", kind: "dlg", source: "73203", idx: 0, speaker: "Zoey" })),
    "[dlg:73203#0] speaker=Zoey :: Hi",
  );
  assert.equal(
    fmt(item({ text: "Zoey", kind: "spk", source: "Zoey" })),
    "[spk:Zoey] :: Zoey",
    "idx = null → без #idx",
  );
  assert.equal(
    fmt(item({ text: "New Game", kind: "set", source: "globalgamemanagers", idx: 423 })),
    "[set:globalgamemanagers#423] :: New Game",
  );
});

test("fmt: текст режется до 120 code points (не UTF-16 units)", () => {
  const long = `${"a".repeat(119)}😀tail`;
  const line = fmt(item({ text: long }));
  const payload = line.slice(line.indexOf(" :: ") + 4);
  assert.equal([...payload].length, 120);
  assert.equal(payload, `${"a".repeat(119)}😀`);
});

test("main: найденные строки → код 0 и вывод в stdout", async () => {
  const res = await quietMain(["New Game", "--dump", DUMP]);
  assert.equal(res.code, 0);
  assert.deepEqual(res.out, ["[set:globalgamemanagers#0] :: New Game"]);
  assert.deepEqual(res.err, []);
});

test("main: --first даёт одну строку", async () => {
  const res = await quietMain(["Zoey", "--first", "--dump", DUMP]);
  assert.equal(res.code, 0);
  assert.deepEqual(res.out, ["[spk:Zoey] :: Zoey"]);
});

test("main: ничего не найдено → код 1 и сообщение в stderr", async () => {
  const res = await quietMain(["no such line", "--dump", DUMP]);
  assert.equal(res.code, 1);
  assert.deepEqual(res.out, []);
  assert.match(res.err[0], /no occurrences/);
});

test("main: пустой/отсутствующий дамп → код 1", async () => {
  const res = await quietMain(["anything", "--dump", join(DUMP, "no-such-dir")]);
  assert.equal(res.code, 1);
  assert.match(res.err[0], /dump is empty or missing/);
});

test("main: без аргумента → код 2, --help → 0", async () => {
  assert.equal((await quietMain([])).code, 2);
  assert.equal((await quietMain(["--help"])).code, 0);
  assert.equal((await quietMain(["--dump"])).code, 2, "флаг без значения — ошибка аргументов");
});
