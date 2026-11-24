/**
 * Тесты TS-части QA: `renderHtml` (HTML-дашборд) и конвертация отчёта Rust.
 *
 * Вычисления — на Rust (`tools/rust-qa`), здесь проверяется то, что осталось на TS:
 * сводка из JSON-отчёта превращается в карты, а находки — в экранированный HTML
 * с фильтром (рендер не дублируем на Rust, решение 2026-11-22).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { renderHtml, rustQaBinary, toSummary, type Summary } from "./qa.mts";

const SUMMARY: Summary = {
  total: 1,
  filled: 1,
  coverage: 100,
  errors: 0,
  warnings: 1,
  bySpeaker: new Map([["Z", { filled: 1, total: 1 }]]),
  byDir: new Map([["ui", { filled: 1, total: 1 }]]),
};

test("toSummary: массивы отчёта Rust -> карты рендера", () => {
  const summary = toSummary({
    lang: "ru",
    summary: {
      total: 10,
      filled: 4,
      coverage: 40,
      errors: 2,
      warnings: 3,
      by_speaker: [["Zoey", { filled: 4, total: 10 }]],
      by_dir: [["ui", { filled: 4, total: 10 }]],
    },
    findings: [],
  });
  assert.equal(summary.total, 10);
  assert.equal(summary.coverage, 40);
  assert.equal(summary.bySpeaker.get("Zoey")?.filled, 4);
  assert.equal(summary.byDir.get("ui")?.total, 10);
});

test("renderHtml: полноценный документ, фильтр и экранирование", () => {
  const html = renderHtml(SUMMARY, [
    { level: "warning", rule: "latin-leftover", rel: "po", text: "<b>Hello</b>", detail: "x" },
  ]);
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.trimEnd().endsWith("</html>"));
  assert.ok(html.includes("latin-leftover"));
  assert.ok(html.includes("&lt;b&gt;Hello&lt;/b&gt;"), "текст экранирован");
  assert.ok(html.includes('id="q"'), "есть поле фильтра");
});

test("renderHtml: карточки, бары по персонажам, таблица папок", () => {
  const html = renderHtml(SUMMARY, []);
  assert.ok(html.includes("100.0%"), "покрытие в карточке");
  assert.ok(html.includes(">Z<"), "спикер в барах");
  assert.ok(html.includes("1/1"), "счётчик в барах");
  assert.ok(html.includes("<td>ui</td>"), "папка в таблице");
  assert.ok(html.includes("Находки (0)"), "число находок");
});

test("renderHtml: тысячи разделены пробелом, многострочный текст не ломает разметку", () => {
  const html = renderHtml({ ...SUMMARY, total: 40256, filled: 33321 }, [
    { level: "error", rule: "empty-dialogue", rel: "po", text: "a\nb", detail: "" },
  ]);
  assert.ok(html.includes("33 321 / 40 256"), "разряды с пробелом");
  assert.ok(html.includes('<tr class="error">'));
});

test("rustQaBinary: путь к бинарю или null для чужого корня", () => {
  const bin = rustQaBinary();
  assert.ok(bin === null || bin.endsWith(`rust-qa${process.platform === "win32" ? ".exe" : ""}`));
  assert.equal(rustQaBinary(join(process.cwd(), "tmp", "нет-такого-репо-qa")), null);
});
