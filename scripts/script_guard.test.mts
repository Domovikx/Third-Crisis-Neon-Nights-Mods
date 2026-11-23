/**
 * script_guard.test.mts — гомоглифы и чужая письменность.
 *
 * Эталон — реальные порчи из ru.po (2026-11-23): имя Lio тайскими и арабскими
 * буквами, латиница внутри кириллического слова.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { foreignScriptHits, hasForeignScript } from "./script_guard.mts";

test("foreignScriptHits: тайские/арабские буквы в русском имени", () => {
  // Тайская диакритика `ิ` — комбинирующая марка, она разрешена; буквы `โ`/`อ` — нет.
  assert.deepEqual(foreignScriptHits("Лิโอ"), ["โ", "อ"]);
  assert.deepEqual(foreignScriptHits("Прости, Лيو."), ["ي", "و"]);
  assert.equal(hasForeignScript("Лио"), false, "кириллица чистая");
});

test("foreignScriptHits: обычный русский текст, латиница и цифры разрешены", () => {
  assert.equal(hasForeignScript("«Shift+клик» и VR-шлем — 3D-сцена."), false);
  assert.equal(hasForeignScript("HTML-лог, VIP-гостей, Deluxe-издание"), false);
  assert.equal(hasForeignScript("Добавить Лิโอ в группу"), true);
});

test("foreignScriptHits: марки и символы не считаются чужой письменностью", () => {
  assert.equal(hasForeignScript("н̶е̶"), false, "комбинирующая марка — оформление");
  assert.equal(hasForeignScript("Привет 👋"), false, "эмодзи — символ, не буква");
});
