/**
 * dotnet.test.mts — сканер .NET-кучи `#US` (строки DLL-настроек и UI).
 *
 * Метаданные .NET собираются байтами в тесте: минимальный PE-«хвост»
 * с сигнатурой BSJB и одним потоком `#US`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  findDotnetUsHeap,
  keyToDisplay,
  looksLikeDisplayText,
  readCompressedInt,
  scanDotnetSettings,
  scanDotnetUiStrings,
} from "../scripts/dotnet.mts";
import { Buf } from "./helpers.mts";
import { createTruncationReport } from "../scripts/truncation.mts";

/** Одна строка кучи #US: compressed length + UTF-16LE + терминатор. */
function usEntry(text: string, terminal = 0): Uint8Array {
  const utf16 = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    utf16[i * 2] = code & 0xff;
    utf16[i * 2 + 1] = code >> 8;
  }
  const total = utf16.length + 1;
  assert.ok(total < 0x80, "в тестах хватает однобайтного префикса");
  return new Buf().u8(total).raw(utf16).u8(terminal).toBytes();
}

/** Минимальная .NET-метадата с одним потоком #US. */
function buildDotnet(entries: string[]): Uint8Array {
  const version = new TextEncoder().encode("v4.0.30319\u0000\u0000\u0000\u0000");
  const header = new Buf();
  header.raw(new TextEncoder().encode("BSJB"));
  header.u16(1).u16(1).u32(0); // major/minor/reserved (итого 12 байт)
  header.u32(version.length).raw(version);
  header.align(4);
  header.u16(0).u16(1); // flags, streamsCount
  const streamHeaderOffset = header.length;
  header.u32(0).u32(0).cstring("#US"); // offset/size заполним ниже
  header.align(4);
  const dataStart = header.length;

  const us = new Buf();
  for (const text of entries) us.raw(usEntry(text));
  const usBytes = us.toBytes();

  header.patchU32(streamHeaderOffset, dataStart);
  header.patchU32(streamHeaderOffset + 4, usBytes.length);
  return new Buf().raw(header.toBytes()).raw(usBytes).toBytes();
}

test("readCompressedInt: 1- и 2-байтные значения", () => {
  assert.deepEqual(readCompressedInt(new Uint8Array([0x25]), 0), [0x25, 1]);
  assert.deepEqual(readCompressedInt(new Uint8Array([0x80, 0x25]), 0), [0x25, 2]);
  assert.deepEqual(readCompressedInt(new Uint8Array([]), 0), [-1, 0]);
});

test("findDotnetUsHeap: находит поток #US", () => {
  const data = buildDotnet(["Hello"]);
  const heap = findDotnetUsHeap(data);
  assert.ok(heap, "куча должна найтись");
  assert.ok(heap[1] > 0);
  assert.equal(findDotnetUsHeap(new TextEncoder().encode("no metadata here")), null);
});

test("keyToDisplay: CamelCase и под-ключи", () => {
  assert.equal(keyToDisplay("Settings.EnableVSync"), "Enable V Sync");
  assert.equal(keyToDisplay("Settings.EnvironmentEffects"), "Environment Effects");
  assert.equal(keyToDisplay("Settings.DialogueAutoplay.Off"), "Off");
  assert.equal(keyToDisplay("Settings.K12"), "K 12");
  assert.equal(keyToDisplay("Settings."), null);
});

test("looksLikeDisplayText: подписи проходят, идентификаторы нет", () => {
  assert.equal(looksLikeDisplayText("Video Tab"), true);
  assert.equal(looksLikeDisplayText("EnvironmentEffects"), true);
  assert.equal(looksLikeDisplayText("back"), false);
  assert.equal(looksLikeDisplayText("_Foo"), false);
  assert.equal(looksLikeDisplayText("Settings.X"), false);
  assert.equal(looksLikeDisplayText("{}"), false);
});

test("scanDotnetSettings: ключи Settings.* из кучи", () => {
  const data = buildDotnet(["Settings.VideoTab", "Settings.DialogueAutoplay.Off", "NotASetting"]);
  assert.deepEqual(scanDotnetSettings(data), [
    { key: "Settings.VideoTab", display: "Video Tab" },
    { key: "Settings.DialogueAutoplay.Off", display: "Off" },
  ]);
});

test("scanDotnetUiStrings: автономные UI-строки, без ключей-настроек", () => {
  const data = buildDotnet(["Environment Effects", "Post Processing", "back", "Settings.X"]);
  const found = scanDotnetUiStrings(data);
  assert.deepEqual(found, ["Environment Effects", "Post Processing"]);
});

test("scanDotnetSettings: без метадаты — пусто, без падения", () => {
  assert.deepEqual(scanDotnetSettings(new TextEncoder().encode("plain")), []);
  assert.deepEqual(scanDotnetUiStrings(new TextEncoder().encode("plain")), []);
});

test("scanDotnetUiStrings: больше 500 строк — без лимита ничего не режется", () => {
  const entries = Array.from({ length: 620 }, (_, i) => `Label ${i}`);
  const found = scanDotnetUiStrings(buildDotnet(entries));
  assert.equal(found.length, 620);
});

test("scanDotnetUiStrings: заданный лимит режет И считается в отчёте", () => {
  const entries = Array.from({ length: 620 }, (_, i) => `Label ${i}`);
  const truncation = createTruncationReport();
  const found = scanDotnetUiStrings(buildDotnet(entries), undefined, 500, truncation.dotnetUi);
  assert.equal(found.length, 500);
  assert.deepEqual(truncation.dotnetUi, { units: 1, dropped: 120, limit: 500 });
});
