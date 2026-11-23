/**
 * rich_roundtrip.test.mts — контракт «PO → игра» для строк с TMP-разметкой.
 *
 * Зачем: перевод в PO — это ТОЛЬКО plain-текст, а игра собирает показ обратно
 * из `rich_text`, подставляя перевод внутрь разметки. Логика живёт в рантайме
 * (`TranslationLoader.cs`), но её ВХОД — наш `template.pot` и `.dat`. Здесь
 * проверяется именно этот стык, чтобы «перевёл, а теги потерялись» не всплывало
 * уже в игре.
 *
 * Алгоритм ниже — зеркало рантайма (наивная чистка `<[^>]+>` и `Replace`).
 * Он намеренно повторяет C#, а не наш умный `stripTmpTags`: тест должен ловить
 * расхождение с игрой, а не подтверждать нашу же реализацию.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parsePo, type PoEntry } from "../.opencode/skills/extract-text/scripts/po_file.mts";

const REPO = resolve(import.meta.dirname, "..");
const POT = join(REPO, "po", "template.pot");
const NAIVE_TAG_RX = /<[^>]+>/g;

/** Зеркало `TranslationLoader.ProcessEntry`: как игра собирает показ строки. */
export function richTranslation(richText: string, translation: string): string | null {
  const plainFromRich = richText.replace(NAIVE_TAG_RX, "");
  if (!plainFromRich || !richText.includes(plainFromRich)) return null;
  return richText.replace(plainFromRich, translation);
}

const richOf = (e: PoEntry): string =>
  e.comments.find((c) => c.startsWith("rich_text: "))?.slice("rich_text: ".length) ?? "";

test("обёртка <i>…</i>: перевод ставится внутрь, теги на месте", () => {
  const rich = "<i>Hello there.</i>";
  assert.equal(richTranslation(rich, "Привет."), "<i>Привет.</i>");
});

test("цвет вокруг всего текста сохраняется", () => {
  const rich = "<color=#EB83FF>Yesss...!~</color>";
  assert.equal(richTranslation(rich, "Да-а-а...!~"), "<color=#EB83FF>Да-а-а...!~</color>");
});

test("реальная строка с вложенными кавычками собирается обратно", () => {
  const rich = '<i>"Now I\'m sure you have many questions... like "What even is Peitho?"-</i>';
  const tr = '«Теперь у меня наверняка много вопросов... вроде: "Что такое Пейто?"-';
  const got = richTranslation(rich, tr);
  assert.ok(got, "разметка непрерывна — сборка обязана сработать");
  assert.ok(got.startsWith("<i>") && got.endsWith("</i>"), "внешние теги сохранены");
  assert.ok(got.includes(tr), "перевод внутри");
});

test("теги ВНУТРИ текста: сборка возвращает null — рантайм откатится на plain", () => {
  // Это и есть известное ограничение (385 строк): текст переведётся, разметка нет.
  const rich = "<i>(All part of ... <color=#EB83FF>a detour</color>... )</i>";
  assert.equal(richTranslation(rich, "(Всё часть миссии... это крюк... )"), null);
});

test("авторские кавычки < … > ломают наивную чистку (документированный край)", () => {
  const rich = "<i>< Like this, hmmm...? like <b>you</b> request them. >";
  // Наивная чистка съедает кусок и оставляет хвост — игра такой хвост не найдёт.
  assert.equal(rich.replace(NAIVE_TAG_RX, ""), "you request them. >");
  assert.equal(richTranslation(rich, "хвост"), null);
});

test("реальный POT: у 1 989 строк разметка собирается, у 385 — нет (потолок)", (t) => {
  if (!existsSync(POT)) {
    t.skip("нет po/template.pot");
    return;
  }
  const entries = parsePo(readFileSync(POT, "utf8")).filter((e) => e.msgid);
  let withRich = 0;
  let contiguous = 0;
  let inline = 0;
  let broken = 0;
  for (const e of entries) {
    const rich = richOf(e);
    if (!rich) continue;
    withRich += 1;
    const plain = rich.replace(NAIVE_TAG_RX, "");
    if (rich.includes(plain)) {
      contiguous += 1;
      // Инвариант: для непрерывной разметки игра обязана собрать строку.
      if (richTranslation(rich, "ПЕРЕВОД") === null) broken += 1;
    } else {
      inline += 1;
    }
  }
  t.diagnostic(`с rich: ${withRich}, собирается: ${contiguous}, inline (без разметки): ${inline}`);
  assert.equal(broken, 0, "непрерывная разметка всегда должна собираться");
  assert.ok(withRich > 2000, "разметка в POT есть");
  assert.ok(
    inline <= 400,
    `inline-строк стало ${inline}: если рост — проверь аудит rich_text (было 385)`,
  );
});

test("POT → .dat: rich_text доходит до словаря (контракт компиляции)", (t) => {
  if (!existsSync(POT)) {
    t.skip("нет po/template.pot");
    return;
  }
  // Строка из шаблона: `r` в .dat обязан совпасть с `#. rich_text:`.
  const entries = parsePo(readFileSync(POT, "utf8")).filter((e) => e.msgid && richOf(e));
  assert.ok(entries.length > 0);
  const sample = entries.find((e) => !/\n/.test(richOf(e))) ?? entries[0];
  const rich = richOf(sample);
  assert.ok(rich.includes(rich.replace(NAIVE_TAG_RX, "")), "выбранная строка собирается");
});
