/**
 * Контракт лога рантайма по шрифтам (золотая выдержка реального прогона ru).
 *
 * Проверяем ровно те утверждения, из-за которых раньше «русский не работал»:
 * - игровой ассет НЕ пытаются растить (нет `preload ... = False chars 236->236`);
 * - видно, что кириллица рисуется клоном игрового ассета (source/point/padding/material);
 * - preload цепочки = True и прирост 236 → 319;
 * - печатается выбранный кегль (typography).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LOG = join(resolve(import.meta.dirname, ".."), "test_data", "runtime-font.log");
const lines = readFileSync(LOG, "utf8").split(/\r?\n/);

test("лог: статический атлас игры больше не растят", () => {
  assert.ok(
    !lines.some((l) => /preload Roboto-Condensed_DialogueUI .* = False/.test(l)),
    "старая строка preload ... = False chars 236->236 не должна появляться",
  );
  assert.ok(!lines.some((l) => /chars 236->236/.test(l)), "нет прироста 236->236");
});

test("лог: кириллица — клон игрового ассета с его TTF/материалом", () => {
  const clone = lines.find((l) => l.includes("Fonts: cloned 'Roboto-Condensed_DialogueUI'"));
  assert.ok(clone, "строка клонирования есть");
  assert.match(clone, /source='Roboto-Condensed'/);
  assert.match(clone, /point=95/);
  assert.match(clone, /padding=9/);
  assert.match(clone, /material='Roboto-Condensed Atlas Material \(DX clone\)'/);
  assert.ok(
    lines.some((l) => l.includes("Fonts: fallback front font='DXclone-")),
    "клон поставлен первым фолбэком игрового меню",
  );
});

test("лог: preload цепочки = True и прирост 236 -> 319", () => {
  const line = lines.find((l) => l.includes("Font: preload chain ru = True"));
  assert.ok(line, "строка preload chain ru = True есть");
  assert.match(line, /236 \+ dynamic 83 -> 319 glyphs/);
  assert.match(line, /unrenderable 0/);
});

test("лог: выбранный кегль меню виден", () => {
  assert.ok(
    lines.some((l) => /typography: ru scale=1\.00 size=36->38/.test(l)),
    "typography: ru scale=1.00 size=36->38",
  );
});
