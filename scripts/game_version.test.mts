/**
 * Тесты проверки версии игры: разбор .acf, поиск манифеста, сравнение снимков.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  compareSnapshots,
  findAppManifest,
  parseAcf,
  readInstalledSnapshot,
  steamappsDir,
  type GameSnapshot,
} from "./game_version.mts";

const REPO = resolve(import.meta.dirname, "..");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "gver-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

const ACF = `"AppState"
{
\t"appid"\t\t"3400350"
\t"name"\t\t"Third Crisis: Neon Nights"
\t"StateFlags"\t\t"4"
\t"installdir"\t\t"Third Crisis Neon Nights"
\t"LastUpdated"\t\t"1794455182"
\t"SizeOnDisk"\t\t"3948382169"
\t"buildid"\t\t"26387111"
}`;

function snapshot(over: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    appid: "3400350",
    buildid: "26387111",
    lastUpdated: 1794455182,
    sizeOnDisk: 3948382169,
    installdir: "Third Crisis Neon Nights",
    recordedAt: "2026-11-22T00:00:00.000Z",
    ...over,
  };
}

test("parseAcf: плоские пары ключ-значение", () => {
  const acf = parseAcf(ACF);
  assert.equal(acf.appid, "3400350");
  assert.equal(acf.buildid, "26387111");
  assert.equal(acf.installdir, "Third Crisis Neon Nights");
});

test("steamappsDir: <lib>/steamapps/common/<game> -> <lib>/steamapps", () => {
  assert.equal(
    steamappsDir("C:/Steam/steamapps/common/Third Crisis Neon Nights").replace(/\//g, "\\"),
    "C:\\Steam\\steamapps",
  );
});

test("findAppManifest: находит манифест по installdir, чужие игнорирует", () => {
  const lib = join(root, "lib1");
  const apps = join(lib, "steamapps");
  const game = join(apps, "common", "Third Crisis Neon Nights");
  mkdirSync(game, { recursive: true });
  writeFileSync(
    join(apps, "appmanifest_111.acf"),
    ACF.replace('"installdir"\t\t"Third Crisis Neon Nights"', '"installdir"\t\t"Other Game"'),
  );
  writeFileSync(join(apps, "appmanifest_3400350.acf"), ACF);

  const found = findAppManifest(game);
  assert.ok(found && found.endsWith("appmanifest_3400350.acf"));
});

test("findAppManifest: манифеста нет — null", () => {
  const game = join(root, "nonsteam", "common", "Game");
  mkdirSync(game, { recursive: true });
  assert.equal(findAppManifest(game), null);
});

test("readInstalledSnapshot: поля из манифеста", () => {
  const game = join(root, "lib2", "steamapps", "common", "Third Crisis Neon Nights");
  mkdirSync(game, { recursive: true });
  writeFileSync(join(root, "lib2", "steamapps", "appmanifest_3400350.acf"), ACF);

  const snap = readInstalledSnapshot(game, new Date("2026-11-22T10:00:00Z"));
  assert.ok(snap);
  assert.equal(snap.buildid, "26387111");
  assert.equal(snap.lastUpdated, 1794455182);
  assert.equal(snap.recordedAt, "2026-11-22T10:00:00.000Z");
});

test("compareSnapshots: одинаковые — тишина", () => {
  const diff = compareSnapshots(snapshot(), snapshot());
  assert.equal(diff.same, true);
  assert.deepEqual(diff.changes, []);
});

test("compareSnapshots: новый buildid — «дамп устарел»", () => {
  const diff = compareSnapshots(
    snapshot(),
    snapshot({ buildid: "99999", lastUpdated: 1795000000 }),
  );
  assert.equal(diff.same, false);
  assert.equal(diff.changes.length, 2);
  assert.ok(diff.changes[0].includes("26387111"));
  assert.ok(diff.changes[0].includes("99999"));
});
