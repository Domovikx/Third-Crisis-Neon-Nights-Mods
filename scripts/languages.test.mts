/**
 * Тесты приоритета языков: конфиг ↔ фактические `po/*.po`.
 * Это страж DRY: список языков живёт в одном файле и не расходится с данными.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SOURCE_LANG,
  allLangs,
  checkPoFiles,
  loadLanguagePriority,
  translateLangs,
} from "./languages.mts";

test("конфиг читается и содержит 11 языков", () => {
  const p = loadLanguagePriority();
  assert.equal(p.languages.length, 11);
  assert.ok(p.source.length > 0);
});

test("порядок: английский первым, дальше по убыванию доли", () => {
  const langs = allLangs();
  assert.equal(langs[0], "en");
  const p = loadLanguagePriority();
  const shares = [...p.languages].sort((a, b) => a.rank - b.rank).map((l) => l.share);
  for (let i = 1; i < shares.length; i++) {
    assert.ok(shares[i] <= shares[i - 1], `доля ${i} больше предыдущей — ранг/доля разошлись`);
  }
});

test("языки перевода — все, кроме источника", () => {
  const langs = translateLangs();
  assert.equal(langs.length, 10);
  assert.ok(!langs.includes(SOURCE_LANG));
  assert.deepEqual(langs, ["zh", "ru", "es", "pt", "de", "ja", "fr", "pl", "ko", "it"]);
});

test("po/*.po совпадает с приоритетом (нет пропусков и лишних)", () => {
  const chk = checkPoFiles();
  assert.deepEqual(chk.missing, [], "язык есть в конфиге, но нет po-файла");
  assert.deepEqual(chk.extra, [], "есть po-файл, которого нет в приоритете");
  assert.equal(chk.ok, true);
});

test("битый конфиг отлавливается (дубликаты кодов)", () => {
  const p = loadLanguagePriority();
  const broken = { ...p, languages: [p.languages[0], p.languages[0]] };
  assert.throws(() => {
    const codes = broken.languages.map((l) => l.code);
    if (new Set(codes).size !== codes.length) throw new Error("дубликаты");
  });
});
