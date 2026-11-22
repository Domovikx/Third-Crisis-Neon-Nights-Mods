/**
 * dump_e2e.test.mts — сквозной прогон на синтетических фикстурах:
 * UnityFS/SerializedFile → JSONL → инвентарь → POT.
 *
 * Файлы игры не используются: бандл и ассет собираются байтами из helpers.
 * Проверяется то, ради чего дампер существует — что из JSONL получается
 * ожидаемый POT (dialogues, fsm_strings, settings/raw).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { dumpAssets, REPO_ROOT } from "../scripts/dump_assets.mts";
import { buildBlocksInfo, buildSerializedFile, buildUnityFs, testTreeNode } from "./helpers.mts";
import { scanDump } from "../../extract-text/scripts/inventory.mts";
import { buildCatalog, catalogSize } from "../../extract-text/scripts/potgen.mts";

const encoder = new TextEncoder();

/**
 * Type tree для buildSerializedFile: узлы БЕЗ заголовка [count][buffer],
 * заголовок пишет сам сборщик SerializedFile.
 */
function buildTypeTree(
  nodes: Array<{ type: string; name: string; level: number; metaFlag?: number }>,
): { nodes: Uint8Array; strings: Uint8Array } {
  const buffer: number[] = [];
  const offsets = new Map<string, number>();
  const add = (value: string): number => {
    const existing = offsets.get(value);
    if (existing !== undefined) return existing;
    const offset = buffer.length;
    for (const b of encoder.encode(value)) buffer.push(b);
    buffer.push(0);
    offsets.set(value, offset);
    return offset;
  };
  const nodeBytes: number[] = [];
  nodes.forEach((spec) => {
    nodeBytes.push(
      ...testTreeNode({
        level: spec.level,
        typeOffset: add(spec.type),
        nameOffset: add(spec.name),
        metaFlag: spec.metaFlag ?? 0,
      }),
    );
  });
  return {
    nodes: new Uint8Array(nodeBytes),
    strings: new Uint8Array(buffer),
  };
}

/** Бандл с одним SerializedFile (type tree включён). */
function buildBundle(serialized: Uint8Array): Uint8Array {
  const blocksInfo = buildBlocksInfo(
    [{ uncompressedSize: serialized.length, compressedSize: serialized.length, flags: 0 }],
    [{ path: "CAB-e2e", offset: 0, size: serialized.length }],
  );
  return buildUnityFs({
    blocksInfo,
    blocks: [{ stored: serialized, uncompressedSize: serialized.length, flags: 0 }],
    nodes: [{ path: "CAB-e2e", offset: 0, size: serialized.length }],
    flags: 0x40,
  });
}

test("e2e: синтетические ассеты → JSONL → инвентарь → POT", async () => {
  const tmpRoot = join(REPO_ROOT, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const workDir = mkdtempSync(join(tmpRoot, "e2e-dump-"));
  const dumpDir = join(workDir, "dump");

  try {
    // 1. «Обычный» ассет без type tree: текст диалога лежит в raw-байтах.
    const dialogue = encoder.encode(
      'x{"Speaker":"Zoey","Text":"Hello <color=perversion>there</color>!"}',
    );
    const levelPath = join(workDir, "level_e2e");
    writeFileSync(
      levelPath,
      buildSerializedFile({
        enableTypeTree: false,
        types: [{ classId: 114 }],
        objects: [{ pathId: 42n, data: dialogue, typeId: 0 }],
      }),
    );

    // 2. Бандл с type tree: m_Name + PlayMaker fsm.value.
    const { nodes, strings } = buildTypeTree([
      { type: "MonoBehaviour", name: "Base", level: 0 },
      { type: "string", name: "m_Name", level: 1 },
      { type: "fsm", name: "fsm", level: 1, metaFlag: 0x4000 },
      { type: "string", name: "value", level: 2 },
      { type: "bool", name: "useVariable", level: 2 },
    ]);
    const fsmValue = "Ask her";
    const objectData = new Uint8Array(24);
    const view = new DataView(objectData.buffer);
    view.setInt32(0, 3, true); // m_Name "FSM" (4+3 → pad 8)
    objectData.set(encoder.encode("FSM"), 4);
    view.setInt32(8, fsmValue.length, true); // fsm.value (4+7 → pad 20)
    objectData.set(encoder.encode(fsmValue), 12);
    objectData[20] = 0; // useVariable = false (+ выравнивание fsm до 24)

    const bundleBytes = buildBundle(
      buildSerializedFile({
        enableTypeTree: true,
        types: [{ classId: 114, typeTree: { nodes, strings } }],
        objects: [{ pathId: 7n, data: objectData, typeId: 0 }],
      }),
    );
    const bundlePath = join(workDir, "e2e.bundle");
    writeFileSync(bundlePath, bundleBytes);

    // 3. Дамп.
    const stats = dumpAssets(
      [
        { name: "level_e2e", path: levelPath },
        { name: "bundle_e2e", path: bundlePath },
      ],
      dumpDir,
    );
    assert.equal(stats.assets, 2);
    assert.equal(stats.objects, 2);
    assert.equal(stats.failed, 0);

    const levelRows = readFileSync(join(dumpDir, "level_e2e.jsonl"), "utf8").trim().split("\n");
    const levelRow = JSON.parse(levelRows[0]) as Record<string, unknown>;
    assert.equal(levelRow.error, "read_failed");
    assert.deepEqual((levelRow.dialogues as Array<Record<string, string>>)[0].text, "Hello there!");

    const bundleRow = JSON.parse(
      readFileSync(join(dumpDir, "bundle_e2e.jsonl"), "utf8").trim(),
    ) as Record<string, unknown>;
    assert.deepEqual(bundleRow.strings, { m_Name: "FSM" });
    assert.deepEqual(bundleRow.fsm_strings, [fsmValue]);

    // 4. POT из дампа.
    const inventory = await scanDump(dumpDir);
    const kinds = new Map(inventory.items.map((item) => [item.text, item.kind]));
    assert.equal(kinds.get("Hello there!"), "dlg");
    assert.equal(kinds.get(fsmValue), "fsm");

    const { catalog } = buildCatalog(inventory.items);
    // Три записи: реплика, имя спикера (spk) и FSM-строка.
    assert.equal(catalogSize(catalog), 3);
    assert.ok(catalog.get("Zoey")?.get("speaker-name"));
    const dialogueEntry = catalog.get("Hello there!")?.get("speaker:Zoey");
    assert.ok(dialogueEntry, "диалог должен иметь контекст спикера");
    assert.deepEqual(dialogueEntry.comments, ["rich_text: Hello <color=perversion>there</color>!"]);
    assert.ok(catalog.get(fsmValue)?.get("ui"), "FSM-строка попадает как ui");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("e2e: summaries.jsonl несёт schema_version и типы объектов", async () => {
  const tmpRoot = join(REPO_ROOT, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const workDir = mkdtempSync(join(tmpRoot, "e2e-summary-"));
  try {
    const assetPath = join(workDir, "level_summary");
    writeFileSync(
      assetPath,
      buildSerializedFile({
        enableTypeTree: false,
        types: [{ classId: 1 }, { classId: 114 }],
        objects: [
          { pathId: 1n, data: new Uint8Array(0), typeId: 0 },
          { pathId: 2n, data: new Uint8Array(0), typeId: 1 },
        ],
      }),
    );
    const dumpDir = join(workDir, "dump");
    dumpAssets([{ name: "level_summary", path: assetPath }], dumpDir);
    const summary = JSON.parse(readFileSync(join(dumpDir, "summaries.jsonl"), "utf8").trim()) as {
      schema_version: string;
      asset: string;
      total_objects: number;
      object_types: Record<string, number>;
    };
    assert.equal(summary.schema_version, "3");
    assert.equal(summary.asset, "level_summary");
    assert.equal(summary.total_objects, 2);
    assert.deepEqual(summary.object_types, { GameObject: 1, MonoBehaviour: 1 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
