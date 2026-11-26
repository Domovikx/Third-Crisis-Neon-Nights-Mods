/**
 * Тесты сборки .ico: структура контейнера (заголовок, записи, смещения) и
 * BMP-тело. Без ffmpeg: пиксели синтетические, проверяется только формат —
 * визуальное качество смотрит человек.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ICO_SIZES, bmpEntry, buildIco, scaleFilter } from "./make_icons.mts";

function solid(size: number, b = 0x40, g = 0x20, r = 0x10): Buffer {
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = b;
    out[i + 1] = g;
    out[i + 2] = r;
    out[i + 3] = 255;
  }
  return out;
}

test("ICO: заголовок, число записей и смещения сходятся", () => {
  const images = [
    { size: 16, bgra: solid(16) },
    { size: 32, bgra: solid(32) },
    { size: 256, png: Buffer.from([1, 2, 3, 4]) },
  ];
  const ico = buildIco(images);
  assert.equal(ico.readUInt16LE(0), 0); // reserved
  assert.equal(ico.readUInt16LE(2), 1); // type: icon
  assert.equal(ico.readUInt16LE(4), images.length);

  let expectedOffset = 6 + 16 * images.length;
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    const width = ico.readUInt8(at);
    const height = ico.readUInt8(at + 1);
    const want = image.size >= 256 ? 0 : image.size; // 0 = 256
    assert.equal(width, want, `width ${image.size}`);
    assert.equal(height, want, `height ${image.size}`);
    assert.equal(ico.readUInt16LE(at + 4), 1); // planes
    assert.equal(ico.readUInt16LE(at + 6), 32); // bpp
    const size = ico.readUInt32LE(at + 8);
    assert.equal(ico.readUInt32LE(at + 12), expectedOffset, `offset ${image.size}`);
    // У PNG-записи тело совпадает с переданным буфером.
    if (image.png) {
      assert.deepEqual(ico.subarray(expectedOffset, expectedOffset + size), image.png);
    }
    expectedOffset += size;
  });
  assert.equal(ico.length, expectedOffset);
});

test("BMP-запись: BITMAPINFOHEADER, двойная высота, XOR снизу вверх", () => {
  const size = 4;
  const bgra = solid(size);
  // Верхняя строка — красная, чтобы проверить переворот.
  for (let x = 0; x < size; x++) {
    const at = x * 4;
    bgra[at] = 0;
    bgra[at + 1] = 0;
    bgra[at + 2] = 255;
  }
  const entry = bmpEntry(bgra, size);
  const maskRow = Math.floor((size + 31) / 32) * 4;
  assert.equal(entry.readUInt32LE(0), 40); // biSize
  assert.equal(entry.readInt32LE(4), size); // biWidth
  assert.equal(entry.readInt32LE(8), size * 2); // biHeight = XOR + AND
  assert.equal(entry.readUInt16LE(14), 32); // bpp
  assert.equal(entry.readUInt32LE(20), size * size * 4 + maskRow * size);
  assert.equal(entry.length, 40 + size * size * 4 + maskRow * size);

  // BMP хранит снизу вверх: последняя строка XOR — исходная верхняя (красная).
  const lastRow = 40 + (size - 1) * size * 4;
  assert.equal(entry.readUInt8(lastRow), 0); // B
  assert.equal(entry.readUInt8(lastRow + 1), 0); // G
  assert.equal(entry.readUInt8(lastRow + 2), 255); // R
});

test("набор .ico содержит 16/24/32/48/64/128/256", () => {
  assert.deepEqual(ICO_SIZES, [16, 24, 32, 48, 64, 128, 256]);
});

test("мелкие размеры кадрируют внешнюю рамку, крупные — нет", () => {
  assert.match(scaleFilter(16), /crop=iw\*0\.82/);
  assert.match(scaleFilter(32), /crop=iw\*0\.82/);
  assert.doesNotMatch(scaleFilter(128), /crop=/);
  assert.match(scaleFilter(256), /scale=256:256/);
});
