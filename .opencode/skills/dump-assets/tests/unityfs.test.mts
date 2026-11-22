/**
 * Тесты контейнера UnityFS на синтетических бандлах (файлы игры не кладём).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BinaryFormatError } from "../scripts/binary.mts";
import {
  FLAG_BLOCKS_INFO_AT_END,
  FLAG_BLOCK_INFO_NEED_PADDING_AT_START,
  isUnityFs,
  readUnityFs,
  usesLegacyArchiveFlags,
} from "../scripts/unityfs.mts";
import {
  buildBlocksInfo,
  buildUnityFs,
  LZMA_TEXT,
  lzmaVectorBytes,
  lz4Literals,
} from "./helpers.mts";

const PAYLOAD = new TextEncoder().encode("hello unity bundle");

function bundle(flags: number, blocksInfoAtEnd = false): Uint8Array {
  const compression = flags & 0x3f;
  const storedBlock = compression ? lz4Literals(PAYLOAD) : PAYLOAD;
  const blocksInfo = buildBlocksInfo(
    [{ uncompressedSize: PAYLOAD.length, compressedSize: storedBlock.length, flags: compression }],
    [{ path: "CAB-test", offset: 0, size: PAYLOAD.length }],
  );
  const storedInfo = compression ? lz4Literals(blocksInfo) : blocksInfo;
  return buildUnityFs({
    blocksInfo,
    blocksInfoStored: storedInfo,
    blocks: [{ stored: storedBlock, uncompressedSize: PAYLOAD.length, flags: compression }],
    nodes: [{ path: "CAB-test", offset: 0, size: PAYLOAD.length }],
    flags,
    blocksInfoAtEnd,
  });
}

test("UnityFS: заголовок, entry и данные без сжатия", () => {
  const archive = readUnityFs(bundle(0x40));
  assert.equal(archive.header.signature, "UnityFS");
  assert.equal(archive.header.formatVersion, 8);
  assert.equal(archive.header.playerVersion, "5.x.x");
  assert.equal(archive.header.engineVersion, "2022.3.62f3");
  assert.equal(archive.entries.length, 1);
  assert.equal(archive.entries[0].path, "CAB-test");
  assert.equal(archive.entries[0].offset, 0);
  assert.equal(archive.entries[0].size, PAYLOAD.length);
  assert.equal(new TextDecoder().decode(archive.readEntry("CAB-test")), "hello unity bundle");
});

test("UnityFS: blocksInfo и данные сжаты LZ4 (флаг 2)", () => {
  const archive = readUnityFs(bundle(0x42));
  assert.equal(archive.blocks[0].flags, 2);
  assert.equal(
    new TextDecoder().decode(archive.readEntry(archive.entries[0])),
    "hello unity bundle",
  );
});

test("UnityFS: LZ4HC (флаг 3) распаковывается тем же декодером", () => {
  const blocks = buildBlocksInfo(
    [{ uncompressedSize: PAYLOAD.length, compressedSize: lz4Literals(PAYLOAD).length, flags: 3 }],
    [{ path: "CAB-hc", offset: 0, size: PAYLOAD.length }],
  );
  const data = buildUnityFs({
    blocksInfo: blocks,
    blocks: [{ stored: lz4Literals(PAYLOAD), uncompressedSize: PAYLOAD.length, flags: 3 }],
    nodes: [{ path: "CAB-hc", offset: 0, size: PAYLOAD.length }],
    flags: 0x40,
  });
  const archive = readUnityFs(data);
  assert.equal(new TextDecoder().decode(archive.readEntry("CAB-hc")), "hello unity bundle");
});

test("UnityFS: blocksInfo в конце файла (флаг 0x80)", () => {
  const archive = readUnityFs(bundle(0x40 | FLAG_BLOCKS_INFO_AT_END, true));
  assert.equal(new TextDecoder().decode(archive.readEntry("CAB-test")), "hello unity bundle");
});

test("UnityFS: паддинг до 16 перед блоками данных (флаг 0x200)", () => {
  const archive = readUnityFs(bundle(0x40 | FLAG_BLOCK_INFO_NEED_PADDING_AT_START));
  assert.equal(new TextDecoder().decode(archive.readEntry("CAB-test")), "hello unity bundle");
});

test("UnityFS: LZMA-блок (флаг 1) — фолбэк работает", () => {
  const stored = lzmaVectorBytes();
  const payload = new TextEncoder().encode(LZMA_TEXT);
  const blocksInfo = buildBlocksInfo(
    [{ uncompressedSize: payload.length, compressedSize: stored.length, flags: 1 }],
    [{ path: "CAB-lzma", offset: 0, size: payload.length }],
  );
  const data = buildUnityFs({
    blocksInfo,
    blocks: [{ stored, uncompressedSize: payload.length, flags: 1 }],
    nodes: [{ path: "CAB-lzma", offset: 0, size: payload.length }],
    flags: 0x40,
  });
  const archive = readUnityFs(data);
  assert.equal(new TextDecoder().decode(archive.readEntry("CAB-lzma")), LZMA_TEXT);
});

test("UnityFS: битая сигнатура — понятная ошибка", () => {
  const data = bundle(0x40);
  data[0] = 0x58; // 'X'
  assert.throws(() => readUnityFs(data), /сигнатура/);
});

test("UnityFS: усечённый заголовок — понятная ошибка", () => {
  const data = bundle(0x40).subarray(0, 12);
  assert.throws(
    () => readUnityFs(data),
    (err: unknown) => {
      assert.ok(err instanceof BinaryFormatError);
      assert.match(err.message, /усечённые данные|терминатор/);
      return true;
    },
  );
});

test("UnityFS: entry вне данных — понятная ошибка", () => {
  const blocks = buildBlocksInfo(
    [{ uncompressedSize: PAYLOAD.length, compressedSize: PAYLOAD.length, flags: 0 }],
    [{ path: "CAB-bad", offset: 0, size: PAYLOAD.length + 100 }],
  );
  const data = buildUnityFs({
    blocksInfo: blocks,
    blocks: [{ stored: PAYLOAD, uncompressedSize: PAYLOAD.length, flags: 0 }],
    nodes: [{ path: "CAB-bad", offset: 0, size: PAYLOAD.length + 100 }],
    flags: 0x40,
  });
  const archive = readUnityFs(data);
  assert.throws(() => archive.readEntry("CAB-bad"), /выходит за данные/);
});

test("UnityFS: неизвестный entry по имени — понятная ошибка", () => {
  const archive = readUnityFs(bundle(0x40));
  assert.throws(() => archive.readEntry("CAB-nope"), /не найден/);
});

test("UnityFS: битое число блоков — понятная ошибка", () => {
  const data = bundle(0x40);
  // blocksInfo у такого бандла начинается после выравнивания (offset 64):
  // ставим огромный счётчик блоков сразу после hash.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setInt32(64 + 16, 1_000_000, false);
  assert.throws(() => readUnityFs(data), /число блоков/);
});

test("usesLegacyArchiveFlags: границы версий Unity", () => {
  assert.equal(usesLegacyArchiveFlags("2019.4.40f1"), true);
  assert.equal(usesLegacyArchiveFlags("2020.3.33f1"), true);
  assert.equal(usesLegacyArchiveFlags("2020.3.34f1"), false);
  assert.equal(usesLegacyArchiveFlags("2021.3.1f1"), true);
  assert.equal(usesLegacyArchiveFlags("2021.3.2f1"), false);
  assert.equal(usesLegacyArchiveFlags("2022.1.0f1"), true);
  assert.equal(usesLegacyArchiveFlags("2022.1.1f1"), false);
  assert.equal(usesLegacyArchiveFlags("2022.3.62f3"), false);
});

test("isUnityFs: сигнатура и мусор", () => {
  assert.equal(isUnityFs(bundle(0x40)), true);
  assert.equal(isUnityFs(new TextEncoder().encode("not a bundle")), false);
});
