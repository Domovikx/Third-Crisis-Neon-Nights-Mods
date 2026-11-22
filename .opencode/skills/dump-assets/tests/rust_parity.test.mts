/**
 * rust_parity.test.mts — паритет двух исполнителей байтового уровня:
 * TS-ядро (`writeRawDumpTs`) и Rust-декодер (`tools/rust-decoder`).
 *
 * Проверяется два уровня:
 *   1. промежуточный rd1 — ПОБАЙТОВО (это и есть байтовый контракт);
 *   2. итоговый дамп `dumpAssets` (TS) против `dumpAssetsFromRaw` (rd1 из Rust)
 *      — каталоги целиком.
 *
 * Фикстуры синтетические (`helpers.mts`): файлов игры в git не кладём.
 * Без собранного бинаря тест пропускается с подсказкой, как собрать.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  defaultDumpOptions,
  dumpAssets,
  dumpAssetsFromRaw,
  REPO_ROOT,
} from "../scripts/dump_assets.mts";
import { findRustBinary, runRustDecoder, writeRawDumpTs } from "../scripts/rawdump.mts";
import { buildBlocksInfo, buildSerializedFile, buildUnityFs, testTreeNode } from "./helpers.mts";

const encoder = new TextEncoder();
const rustBinary = findRustBinary(REPO_ROOT);
const skip = rustBinary ? false : "Rust-декодер не собран (npm run rust:build)";

/** Type tree для сборщика SerializedFile (заголовок пишет он сам). */
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
  return { nodes: new Uint8Array(nodeBytes), strings: new Uint8Array(buffer) };
}

function bundleOf(serialized: Uint8Array): Uint8Array {
  const blocksInfo = buildBlocksInfo(
    [{ uncompressedSize: serialized.length, compressedSize: serialized.length, flags: 0 }],
    [{ path: "CAB-parity", offset: 0, size: serialized.length }],
  );
  return buildUnityFs({
    blocksInfo,
    blocks: [{ stored: serialized, uncompressedSize: serialized.length, flags: 0 }],
    nodes: [{ path: "CAB-parity", offset: 0, size: serialized.length }],
    flags: 0x40,
  });
}

/** Запись кучи #US: [compressed len][UTF-16LE текст][терминатор]. */
function usRecord(text: string): number[] {
  const utf16: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    utf16.push(code & 0xff, (code >> 8) & 0xff);
  }
  const total = utf16.length + 1;
  const prefix = total < 0x80 ? [total] : [0x80 | (total >> 8), total & 0xff];
  return [...prefix, ...utf16, 0];
}

/** Минимальная .NET-сборка с кучей #US (структура — как в dotnet.mts). */
function buildDll(strings: string[]): Uint8Array {
  const out: number[] = Array.from({ length: 16 }, () => 0);
  const sigAt = out.length;
  out.push(0x42, 0x53, 0x4a, 0x42);
  out.push(0, 0, 0, 0, 0, 0, 0, 0);
  const version = [...encoder.encode("v4.0.30319"), 0, 0];
  out.push(version.length, 0, 0, 0, ...version);
  while (out.length % 4 !== 0) out.push(0);
  out.push(0, 0, 2, 0); // flags + streamsCount = 2
  const firstHeaderAt = out.length;
  out.push(0, 0, 0, 0, 0, 0, 0, 0, 0x23, 0x7e, 0, 0); // "#~" (пустой)
  const usHeaderAt = out.length;
  out.push(0, 0, 0, 0, 0, 0, 0, 0, 0x23, 0x55, 0x53, 0); // "#US"
  while (out.length % 4 !== 0) out.push(0);
  const usStart = out.length;
  out.push(0); // куча начинается с нулевого байта
  for (const text of strings) out.push(...usRecord(text));
  const usSize = out.length - usStart;
  const patch = (at: number, offset: number, size: number): void => {
    const view = new DataView(new Uint8Array(4).buffer);
    view.setUint32(0, offset, true);
    for (let i = 0; i < 4; i++) out[at + i] = view.getUint8(i);
    view.setUint32(0, size, true);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = view.getUint8(i);
  };
  patch(firstHeaderAt, 0, 0);
  patch(usHeaderAt, usStart - sigAt, usSize);
  return new Uint8Array(out);
}

/** ColorParserList: count + записи (len + имя + pad + 16 байт float + 8 хвост). */
function buildColorParserList(entries: Array<[string, number, number, number]>): Uint8Array {
  const out: number[] = [];
  const pushI32 = (value: number): void => {
    out.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  };
  const pushF32 = (value: number): void => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) out.push(view.getUint8(i));
  };
  pushI32(entries.length);
  for (const [name, r, g, b] of entries) {
    pushI32(name.length);
    for (const b2 of encoder.encode(name)) out.push(b2);
    while (out.length % 4 !== 0) out.push(0);
    pushF32(r);
    pushF32(g);
    pushF32(b);
    pushF32(1);
    for (let i = 0; i < 8; i++) out.push(0);
  }
  for (const b2 of encoder.encode("ColorParserList")) out.push(b2);
  return new Uint8Array(out);
}

/** Набор фикстур: ассет без type tree, бандл с ним, .resource и DLL. */
function manyRawStrings(count: number): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < count; i++) {
    for (const b of encoder.encode(`Long tail line ${i}`)) bytes.push(b);
    bytes.push(0);
  }
  return new Uint8Array(bytes);
}

function buildFixtures(workDir: string): Array<{ name: string; path: string }> {
  const targets: Array<{ name: string; path: string }> = [];

  // 1. Ассет без type tree: диалог с rich-тегом, raw-строки, ColorParserList.
  const dialogue = encoder.encode(
    'x{"Speaker":"Zoey","Text":"Hello <color=perversion>there</color>!"}',
  );
  const colors = buildColorParserList([
    ["perversion", 1, 0.2, 0.4],
    ["love", 0, 0.5, 1],
  ]);
  const levelPath = join(workDir, "level_parity");
  writeFileSync(
    levelPath,
    buildSerializedFile({
      enableTypeTree: false,
      types: [{ classId: 114 }],
      objects: [
        { pathId: 42n, data: dialogue, typeId: 0 },
        { pathId: -9007199254740993n, data: colors, typeId: 0 },
        { pathId: 43n, data: manyRawStrings(150), typeId: 0 },
      ],
    }),
  );
  targets.push({ name: "level_parity", path: levelPath });

  // 2. Бандл с type tree: m_Name + PlayMaker fsm.value.
  const { nodes, strings } = buildTypeTree([
    { type: "MonoBehaviour", name: "Base", level: 0 },
    { type: "string", name: "m_Name", level: 1 },
    { type: "fsm", name: "fsm", level: 1, metaFlag: 0x4000 },
    { type: "string", name: "value", level: 2 },
    { type: "bool", name: "useVariable", level: 2 },
    { type: "int", name: "count", level: 1 },
  ]);
  const fsmValue = "Ask her";
  const objectData = new Uint8Array(28);
  const view = new DataView(objectData.buffer);
  view.setInt32(0, 3, true);
  objectData.set(encoder.encode("FSM"), 4);
  view.setInt32(8, fsmValue.length, true);
  objectData.set(encoder.encode(fsmValue), 12);
  objectData[20] = 0;
  view.setInt32(24, 7, true);
  const bundlePath = join(workDir, "parity.bundle");
  writeFileSync(
    bundlePath,
    bundleOf(
      buildSerializedFile({
        enableTypeTree: true,
        types: [{ classId: 114, typeTree: { nodes, strings } }],
        objects: [{ pathId: 7n, data: objectData, typeId: 0 }],
      }),
    ),
  );
  targets.push({ name: "bundle_parity", path: bundlePath });

  // 3. .resource: ключи Settings.*, печатные строки для global_strings.
  const resourceBytes: number[] = [];
  const pushU32 = (value: number): void => {
    resourceBytes.push(
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff,
    );
  };
  const pushText = (text: string): void => {
    for (const b of encoder.encode(text)) resourceBytes.push(b);
  };
  resourceBytes.push(0xde, 0xad, 0xbe, 0xef);
  pushU32("Settings.EnableVSync".length);
  pushText("Settings.EnableVSync");
  resourceBytes.push(0, 0);
  pushU32("Enable VSync".length);
  pushText("Enable VSync");
  resourceBytes.push(0); // разделитель печатных строк
  pushText("New Game");
  resourceBytes.push(0);
  pushText("Dialogue Log");
  pushText("x");
  const resourcePath = join(workDir, "level_resource.resource");
  writeFileSync(resourcePath, new Uint8Array(resourceBytes));
  targets.push({ name: "resource_parity", path: resourcePath });

  // 4. DLL: Settings.* + автономные UI-строки.
  const dllPath = join(workDir, "Assembly-CSharp.dll");
  writeFileSync(
    dllPath,
    buildDll(["Settings.EnableVSync", "Enable VSync", "New Game", "Continue"]),
  );
  targets.push({ name: "dll_Assembly-CSharp", path: dllPath });

  return targets;
}

test("паритет RD1: TS-ядро и Rust пишут одинаковые байты", { skip }, () => {
  const workDir = mkdtempSync(join(REPO_ROOT, "tmp", "rust-parity-"));
  try {
    mkdirSync(workDir, { recursive: true });
    const targets = buildFixtures(workDir);
    const tsRaw = join(workDir, "raw-ts.jsonl");
    const rustRaw = join(workDir, "raw-rust.jsonl");

    const tsStats = writeRawDumpTs(targets, tsRaw);
    const rustStats = runRustDecoder(
      REPO_ROOT,
      targets,
      rustRaw,
      join(workDir, "rust.report.json"),
    );
    assert.equal(rustStats.files, tsStats.files);
    assert.equal(rustStats.objects, tsStats.objects);
    assert.equal(rustStats.typedObjects, tsStats.typedObjects);
    assert.ok(tsStats.objects > 0, "фикстуры должны давать объекты");

    const tsBytes = readFileSync(tsRaw);
    const rustBytes = readFileSync(rustRaw);
    if (!tsBytes.equals(rustBytes)) {
      const tsLines = tsBytes.toString("utf8").split("\n");
      const rustLines = rustBytes.toString("utf8").split("\n");
      for (let i = 0; i < Math.max(tsLines.length, rustLines.length); i++) {
        assert.equal(
          rustLines[i],
          tsLines[i],
          `rd1 разошёлся на строке ${i + 1}: ` +
            `TS=${(tsLines[i] ?? "").slice(0, 200)} RUST=${(rustLines[i] ?? "").slice(0, 200)}`,
        );
      }
    }
    assert.ok(statSync(tsRaw).size === statSync(rustRaw).size);
  } finally {
    if (process.env.RUST_PARITY_KEEP) console.error(`каталог сохранён: ${workDir}`);
    else rmSync(workDir, { recursive: true, force: true });
  }
});

test("паритет дампа: dumpAssets(TS) == dumpAssetsFromRaw(rd1 из Rust)", { skip }, () => {
  const workDir = mkdtempSync(join(REPO_ROOT, "tmp", "rust-parity-dump-"));
  try {
    const targets = buildFixtures(workDir);
    const tsDir = join(workDir, "dump-ts");
    const rustDir = join(workDir, "dump-rust");
    const rustRaw = join(workDir, "raw-rust.jsonl");

    const tsStats = dumpAssets(targets, tsDir);
    runRustDecoder(REPO_ROOT, targets, rustRaw);
    const rustStats = dumpAssetsFromRaw(rustRaw, rustDir);

    assert.deepEqual(rustStats, tsStats);
    const names = readdirSync(tsDir).sort();
    assert.deepEqual(readdirSync(rustDir).sort(), names);
    for (const name of names) {
      assert.deepEqual(
        readFileSync(join(rustDir, name)),
        readFileSync(join(tsDir, name)),
        `файл дампа ${name} разошёлся`,
      );
    }

    // Без лимита хвост raw_strings (150 строк в одном объекте) сохранён целиком.
    const rows = readFileSync(join(tsDir, "level_parity.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { path_id: number; raw_strings?: string[] });
    const long = rows.find((row) => String(row.path_id) === "43");
    assert.equal(long?.raw_strings?.length, 150, "хвост raw_strings должен быть в дампе");

    // Лимит применяется одинаково в обоих путях (паритет счётчиков и выхода).
    const tsLimited = defaultDumpOptions();
    tsLimited.rawStringLimit = 100;
    const rustLimited = defaultDumpOptions();
    rustLimited.rawStringLimit = 100;
    dumpAssets(targets, join(workDir, "dump-ts-limited"), tsLimited);
    dumpAssetsFromRaw(rustRaw, join(workDir, "dump-rust-limited"), rustLimited);
    assert.deepEqual(rustLimited.truncation, tsLimited.truncation);
    assert.deepEqual(
      readFileSync(join(workDir, "dump-rust-limited", "level_parity.jsonl")),
      readFileSync(join(workDir, "dump-ts-limited", "level_parity.jsonl")),
      "выход с лимитом разошёлся между TS и Rust",
    );
    assert.equal(tsLimited.truncation.rawStrings.units, 1);
    assert.equal(tsLimited.truncation.rawStrings.dropped, 50);
  } finally {
    if (process.env.RUST_PARITY_KEEP) console.error(`каталог сохранён: ${workDir}`);
    else rmSync(workDir, { recursive: true, force: true });
  }
});
