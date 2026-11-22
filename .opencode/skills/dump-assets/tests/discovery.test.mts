/**
 * Тесты discovery сцен: обход по факту наличия файлов, а не диапазоном 0..15.
 *
 * Регрессия 2026-11-22: Python-эталон (и первый порт) обходил только `level0..15`
 * и `sharedassets0..15`, поэтому три сцены (`level16..18`, ~70 000 объектов) молча
 * не попадали в дамп и POT. Эти тесты фиксируют, что обход идёт по файлам.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { discoverGameFiles, sceneIndexes } from "../scripts/dump_assets.mts";
import { GAME_DATA_FOLDER } from "../../../../scripts/game_dir.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "discover-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Фейковая установка: `<root>/<game>/<Game>_Data/<файлы>`. */
function fakeGame(name: string, files: string[]): string {
  const game = join(root, name);
  const data = join(game, GAME_DATA_FOLDER);
  mkdirSync(data, { recursive: true });
  for (const f of files) writeFileSync(join(data, f), "x");
  return game;
}

test("sceneIndexes: числовые индексы по возрастанию, нечисловые игнорируются", () => {
  const dir = join(root, "idx");
  mkdirSync(dir, { recursive: true });
  for (const f of ["level0", "level16", "level2", "levelX", "level.bak", "level9.bak"]) {
    writeFileSync(join(dir, f), "x");
  }
  assert.deepEqual(sceneIndexes(dir, "level"), [0, 2, 16]);
});

test("sceneIndexes: суффикс учитывается (sharedassetsN.assets)", () => {
  const dir = join(root, "idx2");
  mkdirSync(dir, { recursive: true });
  for (const f of ["sharedassets0.assets", "sharedassets17.assets", "sharedassets0.resource"]) {
    writeFileSync(join(dir, f), "x");
  }
  assert.deepEqual(sceneIndexes(dir, "sharedassets", ".assets"), [0, 17]);
});

test("discoverGameFiles: 19 сцен находятся (регрессия на level16..18)", () => {
  const levels = Array.from({ length: 19 }, (_, i) => `level${i}`);
  const shared = Array.from({ length: 19 }, (_, i) => `sharedassets${i}.assets`);
  const game = fakeGame("game19", [...levels, ...shared]);

  const files = discoverGameFiles(game);
  const lv = files.filter((f) => /^level\d+$/.test(f.name)).map((f) => f.name);
  const sa = files.filter((f) => /^sharedassets\d+$/.test(f.name)).map((f) => f.name);

  assert.equal(lv.length, 19);
  assert.equal(sa.length, 19);
  assert.ok(lv.includes("level16"), "level16 должен попадать в дамп");
  assert.ok(lv.includes("level18"), "level18 должен попадать в дамп");
  assert.deepEqual(lv, levels, "порядок — числовой, а не строковый");
});

test("discoverGameFiles: новая сцена после апдейта игры тоже попадает", () => {
  const game = fakeGame("game-future", ["level0", "level19", "level20"]);
  const lv = discoverGameFiles(game)
    .filter((f) => /^level\d+$/.test(f.name))
    .map((f) => f.name);
  assert.deepEqual(lv, ["level0", "level19", "level20"]);
});

test("discoverGameFiles: мусорные имена не считаются сценами", () => {
  const game = fakeGame("game-junk", ["level0", "level0.bak", "level", "levelX", "level12.tmp"]);
  const lv = discoverGameFiles(game)
    .filter((f) => /^level\d+$/.test(f.name))
    .map((f) => f.name);
  assert.deepEqual(lv, ["level0"]);
});
