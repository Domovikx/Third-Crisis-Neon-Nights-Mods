/**
 * truncation.test.mts — учёт обрезок: лимиты, счётчики, человеческий отчёт.
 *
 * Смысл тестов: обрезка допустима только вместе со счётчиком, а «без лимита»
 * обязано отдавать ВСЁ. Молчаливое усечение — регрессия (аудит POT 2026-11-22).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { scanGlobalStrings } from "../scripts/rawscan.mts";
import {
  capList,
  createTruncationReport,
  formatLimits,
  formatTruncations,
  hasTruncations,
  parseLimit,
} from "../scripts/truncation.mts";

test("capList: без лимита массив не меняется", () => {
  const items = ["a", "b", "c"];
  const bucket = { units: 0, dropped: 0, limit: 12 as number | null };
  const out = capList(items, null, bucket);
  assert.equal(out.length, 3);
  assert.equal(bucket.dropped, 0);
  assert.equal(bucket.limit, null);
});

test("capList: лимит режет и считает объект/строки/лимит", () => {
  const bucket = { units: 0, dropped: 0, limit: null as number | null };
  const out = capList([1, 2, 3, 4, 5], 2, bucket);
  assert.deepEqual(out, [1, 2]);
  assert.deepEqual(bucket, { units: 1, dropped: 3, limit: 2 });
});

test("capList: ровно в лимит — не обрезка", () => {
  const bucket = { units: 0, dropped: 0, limit: null as number | null };
  assert.deepEqual(capList([1, 2], 2, bucket), [1, 2]);
  assert.deepEqual(bucket, { units: 0, dropped: 0, limit: 2 });
});

test("отчёт: пустой молчит, непустой печатает счётчик и лимит", () => {
  const report = createTruncationReport();
  assert.equal(hasTruncations(report), false);
  assert.deepEqual(formatTruncations(report), []);

  capList([1, 2, 3], 1, report.rawStrings);
  assert.equal(hasTruncations(report), true);
  const lines = formatTruncations(report);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /raw_strings: отброшено 2 /);
  assert.match(lines[0], /затронуто: 1/);
  assert.match(lines[0], /лимит: 1/);
});

test("formatLimits: все три предела видны в журнале прогона", () => {
  const report = createTruncationReport();
  report.rawStrings.limit = null;
  report.globalStrings.limit = 500;
  report.dotnetUi.limit = 2000;
  assert.equal(
    formatLimits(report),
    "raw_strings=без лимита/объект, global_strings=500/ассет, #US=2000/сборка",
  );
});

test("parseLimit: число, all/none/0 — без лимита, мусор — ошибка", () => {
  assert.equal(parseLimit("100"), 100);
  assert.equal(parseLimit(" 7 "), 7);
  assert.equal(parseLimit("all"), null);
  assert.equal(parseLimit("none"), null);
  assert.equal(parseLimit("0"), null);
  assert.equal(parseLimit("-1"), null);
  assert.equal(parseLimit("abc"), undefined);
  assert.equal(parseLimit("-5"), undefined);
});

test("scanGlobalStrings: без лимита отдаёт всех кандидатов, с лимитом — считает", () => {
  // Печатные ASCII-строки через NUL: все проходят isGlobalStringCandidate.
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const text of ["New Game", "Dialogue Log", "Save Game"]) {
    for (const b of encoder.encode(text)) bytes.push(b);
    bytes.push(0);
  }
  const data = new Uint8Array(bytes);

  const all = scanGlobalStrings(data, null);
  assert.equal(all.length, 3);

  const report = createTruncationReport();
  const capped = scanGlobalStrings(data, 2, report.globalStrings);
  assert.equal(capped.length, 2);
  assert.deepEqual(report.globalStrings, { units: 1, dropped: 1, limit: 2 });
});
