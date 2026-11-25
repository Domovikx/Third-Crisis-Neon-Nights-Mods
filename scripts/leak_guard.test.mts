/**
 * leak_guard.test.mts — две утечки в текст: промпт переводчика и подпись спикера.
 *
 * Первая часть — устойчивые обороты промпта. Вторая — скобка «(speaker: …)»,
 * которую модель переводит вместе с репликой: в корпусе 2026-11-24 было 310
 * таких строк только в pt/es/it/fr/ru (`(falante: Zoey, feminina)`,
 * `(hablante: Cliente, masculino)`, `(parlante: …)`, `(parleur : …)`,
 * `(говорит Ругнар)`), плюс de/ja/ko/pl. В игре подпись видна как часть реплики.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import { stripSpeakerLeak } from "../.opencode/skills/translate-local/scripts/translate_local.mts";
import { isPromptLeak, leakHits } from "./leak_guard.mts";

const REPO = join(import.meta.dirname, "..");
const LANGS = ["zh", "ru", "es", "pt", "de", "ja", "fr", "pl", "ko", "it"];

test("leakHits: реальная утечка промпта из корпуса", () => {
  const line =
    "Перевод каждой строки. Отвечайте ровно одной строкой в формате «N. перевод». Никогда не повторяйте тег говорящего в переводах.";
  assert.equal(isPromptLeak(line), true);
  assert.equal(leakHits(line).length >= 2, true);
});

test("leakHits: английские формы и JSON-инструкция", () => {
  assert.equal(
    isPromptLeak('Translate each line. Reply with exactly 5 lines in format "N. translation".'),
    true,
  );
  assert.equal(isPromptLeak('Answer ONLY JSON {"verdict":"ok"}'), true);
});

test("leakHits: реплики героев об инструкциях не флагаются", () => {
  assert.equal(isPromptLeak("Он прочитал инструкцию и перевёл каждую строку договора."), false);
  assert.equal(isPromptLeak("Переведи это, пожалуйста, на нормальный язык."), false);
  assert.equal(isPromptLeak("Ты никогда не повторяешь дважды, да?"), false);
});

test("stripSpeakerLeak: подписи всех десяти языков корпуса (фикстуры 2026-11-24)", () => {
  const leaks: [string, string][] = [
    ["«Corre... Aquí. (hablante: Cliente, masculino)»", "«Corre... Aquí.»"],
    ["Entre e... me ajude... por favor! (falante: Intercom)", "Entre e... me ajude... por favor!"],
    ['"Coursee... Ecco. (parlante: Cliente, maschio)"', '"Coursee... Ecco."'],
    [
      "Recule. Tu n'as pas entendu parler du confinement ? (parler: Enforcer, homme)",
      "Recule. Tu n'as pas entendu parler du confinement ?",
    ],
    ["E-et puis, je... je ne... je... (par Zoey, femme)", "E-et puis, je... je ne... je..."],
    [
      "Не похоже на «никакого человека», малыш. (говорит Леона)",
      "Не похоже на «никакого человека», малыш.",
    ],
    [
      "金に困ってたから…断らなかったの、えへへ…（話し手：Customer、男性）",
      "金に困ってたから…断らなかったの、えへへ…",
    ],
    ['"어이, 웨이트리스..." (말하는 사람: 고객, 남성)', '"어이, 웨이트리스..."'],
    ["Lorem ipsum. (mówi: Zoey, kobieta)", "Lorem ipsum."],
    ["Verdammt noch mal. (Sprecherin: Zoey, weiblich)", "Verdammt noch mal."],
  ];
  for (const [src, want] of leaks) assert.equal(stripSpeakerLeak(src).clean, want, src);
});

test("stripSpeakerLeak: подпись перед закрывающими тегами rich-строки", () => {
  // Реальная строка es: хвост утечки стоит ВНУТРИ </i></color>.
  assert.deepEqual(stripSpeakerLeak("(No puedo... Yo...) (hablante: Zoey, mujer)</i></color>"), {
    clean: "(No puedo... Yo...)</i></color>",
    leaked: true,
  });
});

test("stripSpeakerLeak: честные скобки не срезаются", () => {
  for (const ok of [
    "Каллиах Недоступен (Голосовой файл)",
    "Он говорит тихо (voz suave).",
    "Тише, пожалуйста (speaker notes).",
    "Просто текст",
  ]) {
    assert.deepEqual(stripSpeakerLeak(ok), { clean: ok, leaked: false }, ok);
  }
});

test("stripSpeakerLeak: в 10 PO нет подписи спикера (реальный корпус)", () => {
  const hits: string[] = [];
  for (const lang of LANGS) {
    const po = parsePo(readFileSync(join(REPO, "po", `${lang}.po`), "utf8"));
    for (const e of po) {
      if (!e.msgstr || e.flags.includes("skip")) continue;
      if (stripSpeakerLeak(e.msgstr).leaked) hits.push(`${lang}: ${e.msgstr.slice(-70)}`);
    }
  }
  assert.deepEqual(hits, [], `утечки подписи:\n${hits.slice(0, 20).join("\n")}`);
});
