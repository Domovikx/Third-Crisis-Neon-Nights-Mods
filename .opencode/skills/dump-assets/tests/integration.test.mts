/**
 * Интеграционные проверки на РЕАЛЬНОЙ установке игры.
 *
 * В CI игры нет — тесты помечены skip, пока `TCNN_GAME_DIR` (или Steam) не
 * указывает на установленную Third Crisis Neon Nights. Файлы игры только
 * читаются; дамп пишется во временный каталог репозитория (`tmp/`) и удаляется.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";

import { checkGameDir, findGameDir, GAME_DATA_FOLDER } from "../../../../scripts/game_dir.mts";
import {
  describeAssetFile,
  discoverGameFiles,
  dumpAssets,
  REPO_ROOT,
} from "../scripts/dump_assets.mts";
import { readObjectRaw, readSerializedFile } from "../scripts/serialized.mts";
import { readUnityFs } from "../scripts/unityfs.mts";
import { scanDump } from "../../extract-text/scripts/inventory.mts";
import { join } from "node:path";

const gameDir = findGameDir();
const hasGame = checkGameDir(gameDir).ok;
const skip = hasGame ? false : "игра не установлена (TCNN_GAME_DIR)";

function read(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(join(gameDir as string, GAME_DATA_FOLDER, relative)));
}

test("интеграция: level0 разбирается, объекты адресуются внутри файла", { skip }, () => {
  const bytes = read("level0");
  const file = readSerializedFile(bytes);
  assert.equal(file.header.version, 22);
  assert.equal(file.header.enableTypeTree, false);
  assert.ok(file.objects.length > 0, "в level0 должны быть объекты");
  const pathIds = new Set(file.objects.map((o) => o.pathId.toString()));
  assert.equal(pathIds.size, file.objects.length, "path_id в файле уникален");
  for (const object of file.objects.slice(0, 200)) {
    assert.ok(object.byteStart >= file.header.dataOffset);
    assert.equal(readObjectRaw(file, object).length, object.byteSize);
  }
});

test("интеграция: бандл распаковывается, entry и объекты на месте", { skip }, () => {
  const bundles = discoverGameFiles(gameDir as string).filter((f) => f.name.startsWith("bundle_"));
  assert.ok(bundles.length > 0, "в StreamingAssets должны быть бандлы");
  const bytes = new Uint8Array(readFileSync(bundles[0].path));
  const archive = readUnityFs(bytes);
  assert.ok(archive.entries.length > 0);
  let serialized = 0;
  for (const entry of archive.entries) {
    const body = archive.readEntry(entry);
    if (entry.path.endsWith(".resS") || entry.path.endsWith(".resource")) continue;
    try {
      const file = readSerializedFile(body);
      serialized += 1;
      assert.ok(file.objects.length > 0);
      for (const object of file.objects.slice(0, 20)) {
        assert.equal(readObjectRaw(file, object).length, object.byteSize);
      }
    } catch {
      // Не каждый entry — SerializedFile; это нормально.
    }
  }
  assert.ok(serialized > 0, "в бандле должен быть хотя бы один SerializedFile");
});

test("интеграция: describeAssetFile даёт отчёт по level0 без ошибок", { skip }, () => {
  const path = join(gameDir as string, GAME_DATA_FOLDER, "level0");
  const report = describeAssetFile("level0", path, read("level0"), false);
  assert.equal(report.kind, "serialized");
  assert.equal(report.error, undefined);
  assert.equal(report.files.length, 1);
  assert.ok(report.files[0].objectCount > 0);
  assert.equal(report.files[0].typeTreeEnabled, false);
});

test("интеграция: дамп реальных файлов даёт JSONL и POT-строки", { skip }, async () => {
  const discovered = discoverGameFiles(gameDir as string);
  const level1 = discovered.find((item) => item.name === "level1");
  assert.ok(level1, "в установке должен быть level1");
  const bundles = discovered
    .filter((item) => item.name.startsWith("bundle_"))
    .sort((a, b) => statSync(a.path).size - statSync(b.path).size);
  assert.ok(bundles.length > 0, "в StreamingAssets должны быть бандлы");

  mkdirSync(join(REPO_ROOT, "tmp"), { recursive: true });
  const workDir = mkdtempSync(join(REPO_ROOT, "tmp", "integration-dump-"));
  try {
    const stats = dumpAssets([level1, bundles[0]], workDir);
    assert.equal(stats.failed, 0);
    assert.equal(stats.assets, 2);
    assert.ok(stats.objects > 0);

    const inventory = await scanDump(workDir);
    assert.ok(inventory.items.length > 0, "из реального дампа должны быть строки");
    assert.equal(inventory.stats.chunkFiles, 2);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
