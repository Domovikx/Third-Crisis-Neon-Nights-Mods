/**
 * script_guard.test.mts — гомоглифы и чужая письменность.
 *
 * Эталон — реальные порчи из корпуса: ru `Lio` тайскими и арабскими буквами,
 * ja `エンفورサー` с арабской `ف` (9 строк), ko `поезд`/`음مم`/тайский вперемешку
 * (22 строки), pl `zmiennые` (2026-11-24).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import {
  foreignScriptHits,
  foreignScriptHitsFor,
  GUARDED_LANGS,
  hasForeignScript,
  hasForeignScriptFor,
} from "./script_guard.mts";

const REPO = join(import.meta.dirname, "..");

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

test("foreignScriptHitsFor: арабская буква внутри катаканы (ja)", () => {
  assert.deepEqual(foreignScriptHitsFor("ja", "エンفورサーを無効化せよ"), ["ف", "و", "ر"]);
  assert.equal(hasForeignScriptFor("ja", "エンフォーサーを無効化せよ"), false);
  assert.equal(hasForeignScriptFor("ja", "エステ的な感じ"), false, "латиница и катакана — норма");
});

test("foreignScriptHitsFor: кириллица/тайский/арабица внутри корейского (ko)", () => {
  assert.deepEqual(foreignScriptHitsFor("ko", "이번 поезд에서도 욕구가"), [
    "п",
    "о",
    "е",
    "з",
    "д",
  ]);
  assert.deepEqual(foreignScriptHitsFor("ko", "음مم..."), ["م"]);
  assert.equal(hasForeignScriptFor("ko", "이번 여정에서도 욕구가"), false);
});

test("foreignScriptHitsFor: кириллица внутри польского/латиницы", () => {
  assert.equal(hasForeignScriptFor("pl", "Ustaw zmiennые"), true);
  assert.equal(hasForeignScriptFor("pl", "Ustaw zmienne"), false);
  assert.equal(hasForeignScriptFor("de", "Машинный перевод"), true);
});

test("foreignScriptHitsFor: письменность оригинала разрешена (название языка)", () => {
  const src = "Russian Machine Translated / Русский Машинный Перевод";
  assert.equal(hasForeignScriptFor("fr", "Машинный перевод с русского / Traduction", src), false);
  assert.equal(
    hasForeignScriptFor("de", "中文机器翻译", "Simplified Chinese / 中文机器翻译"),
    false,
  );
  // Латиница в CJK-переводе разрешена всегда (имена, бренды).
  assert.equal(hasForeignScriptFor("zh", "这是 Lio 的数据"), false);
  // Греческие буквы в zh — обозначение, а не подмена письменности.
  assert.equal(hasForeignScriptFor("zh", "颈部芯片——利奥的数据α"), false);
});

test("script_guard: в 10 PO нет чужой письменности (реальный корпус)", () => {
  const hits: string[] = [];
  for (const lang of GUARDED_LANGS) {
    const po = parsePo(readFileSync(join(REPO, "po", `${lang}.po`), "utf8"));
    for (const e of po) {
      if (!e.msgstr) continue;
      const bad = foreignScriptHitsFor(lang, e.msgstr, e.msgid);
      if (bad.length) hits.push(`${lang}: [${bad.join(" ")}] ${e.msgstr.slice(0, 70)}`);
    }
  }
  assert.deepEqual(hits, [], `чужая письменность:\n${hits.slice(0, 20).join("\n")}`);
});
