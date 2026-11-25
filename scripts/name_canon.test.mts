/**
 * name_canon.test.mts — имена по канону: строки `speaker-name` и текст.
 *
 * Эталон — реальные порчи 2026-11-24: zh `Lio` латиницей (42 строки), ja `ハイメ`
 * вместо `ジェイミー` (25), it `speaker-name` Mira = `Guarda` («смотри» вместо
 * имени), `Rungar`/`Rugnar` в одном языке перепутаны (в оригинале это два разных
 * написания, и перевод обязан повторять написание строки).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parsePo, type PoEntry } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import {
  REPO_ROOT,
  loadNameCanon,
  mentions,
  variantRx,
  wrongNameHits,
  speakerNameMismatches,
} from "./name_canon.mts";

const LANGS = ["zh", "ru", "es", "pt", "de", "ja", "fr", "pl", "ko", "it"];

function entry(ctxt: string, msgid: string, msgstr: string): PoEntry {
  return { msgid, msgctxt: ctxt, msgstr, refs: [], comments: [], flags: [], translator: [] };
}

function readPo(lang: string): PoEntry[] {
  return parsePo(readFileSync(join(REPO_ROOT, "po", `${lang}.po`), "utf8"));
}

const canon = loadNameCanon();

test("name_canon: POT и каждый PO содержат канон в speaker-name", () => {
  const pot = parsePo(readFileSync(join(REPO_ROOT, "po", "template.pot"), "utf8"));
  const potNames = new Set(
    pot.filter((e) => e.msgctxt === "speaker-name" && e.msgid).map((e) => e.msgid),
  );
  for (const name of Object.keys(canon.canon)) {
    assert.equal(potNames.has(name), true, `в POT нет speaker-name «${name}»`);
    for (const lang of LANGS) {
      assert.ok(canon.canon[name][lang], `в каноне нет «${name}» для ${lang}`);
    }
  }
});

test("name_canon: все speaker-name в 10 PO совпадают с каноном", () => {
  const bad: string[] = [];
  for (const lang of LANGS) bad.push(...speakerNameMismatches(canon, lang, readPo(lang)));
  assert.deepEqual(bad, [], `расхождения speaker-name:\n${bad.join("\n")}`);
});

test("name_canon: в тексте нет запрещённых форм имён (реальный корпус)", () => {
  const bad: string[] = [];
  for (const lang of LANGS) bad.push(...wrongNameHits(canon, lang, readPo(lang)));
  assert.deepEqual(bad, [], `запрещённые формы:\n${bad.slice(0, 20).join("\n")}`);
});

test("name_canon: реальные порчи ловятся (фикстуры из задачи)", () => {
  // zh: латиница вместо 利奥 в 42 строках.
  const zh = [
    entry("ui", "Ask about Lio", "问关于Lio的事"),
    entry(
      "speaker:Leona",
      "Ah, no. Lio just skipped his breakfast.",
      "啊，不，别担心。莉奥只是没吃早餐而已。",
    ),
    entry("ui", "Ask about Lio", "问关于利奥的事"),
  ];
  assert.deepEqual(wrongNameHits(canon, "zh", zh).length, 2);
  // ja: два прочтения имени Jaime.
  const ja = [
    entry("ui", "Are you sure, Jaime? You don't have to be alone.", "本当にそう思うの、ハイメ？"),
    entry("ui", "Jaime Arm FSM", "ハイム・アーム FSM"),
    entry("ui", "Are you sure, Jaime?", "本当にそう思うの、ジェイミー？"),
  ];
  assert.equal(wrongNameHits(canon, "ja", ja).length, 2);
});

test("name_canon: Rungar и Rugnar не смешиваются, но два написания живут", () => {
  const de = [
    entry("ui", "Do it, Rungar babe!", "Mach es, Rugnar-Schatz!"),
    entry("ui", "Rugnar Cole", "Rugnar Cole"),
  ];
  assert.equal(wrongNameHits(canon, "de", de).length, 1);
  // Ровно те написания, что в оригинале, — чисто.
  const ok = [
    entry("ui", "Do it, Rungar babe!", "Mach es, Rungar-Schatz!"),
    entry("ui", "Rugnar Cole", "Rugnar Cole"),
  ];
  assert.deepEqual(wrongNameHits(canon, "de", ok), []);
});

test("name_canon: it Mira — имя, а не «Guarda» (повелительное «смотри»)", () => {
  const bad = [entry("speaker-name", "Mira", "Guarda")];
  assert.equal(speakerNameMismatches(canon, "it", bad).filter((m) => m.includes("Mira")).length, 1);
  const ok = [entry("speaker-name", "Mira", "Mira")];
  assert.deepEqual(
    speakerNameMismatches(canon, "it", ok).filter((m) => m.includes("Mira")),
    [],
  );
  // В тексте итальянское «Guarda» у строки про Mira — дефект.
  assert.equal(
    wrongNameHits(canon, "it", [entry("speaker:Mira", "Mira is here.", "Guarda è qui.")]).length,
    1,
  );
});

test("name_canon: границы и префиксы вариантов", () => {
  assert.equal(mentions("Is Cypher at FindLio?", "Lio"), false, "FindLio — идентификатор, не имя");
  assert.equal(mentions("Ask about Lio", "Lio"), true);
  assert.equal(
    variantRx("伦加", "伦加尔").test("伦加尔"),
    false,
    "префикс канона не считается вариантом",
  );
  assert.equal(variantRx("伦加", "伦加尔").test("伦加根本"), true);
  // Склонение в pl/de: запрещённая форма ловится вместе с окончанием.
  assert.equal(variantRx("Rugnar").test("Rugnara"), true);
  assert.equal(variantRx("Rungar").test("Rungarowi"), true);
  assert.equal(variantRx("Lio").test("Lion"), false, "короткое имя — строго по границам");
});
