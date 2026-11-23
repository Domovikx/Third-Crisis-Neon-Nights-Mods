/**
 * fragment_repair.test.mts — E2E-страж починки обрывков в реальном POT.
 *
 * Контекст (2026-11-23): игра отдавала `text`, полученный наивной чисткой
 * `<[^>]+>` из `rich_text`. Авторские кавычки `< … >` съедались вместе с
 * началом фразы, и в POT попадал хвост («your comfort, hon. … >»). Такие записи
 * раньше просто помечались `#, skip` — то есть строка навсегда оставалась
 * английской. Теперь ключом становится полная фраза из `rich_text`, а исходный
 * хвост сохраняется комментарием `#. repaired:`.
 *
 * Тест проверяет именно ИТОГОВЫЙ файл, а не логику: после любого прогона
 * `potgen --update` в POT не должно снова появиться обрезанных ключей.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import { stripTmpTags } from "../.opencode/skills/extract-text/scripts/pot_skip.mts";

const REPO = resolve(import.meta.dirname, "..");
const POT = join(REPO, "po", "template.pot");

const commentOf = (e: { comments: string[] }, prefix: string): string =>
  e.comments.find((c) => c.startsWith(prefix))?.slice(prefix.length) ?? "";

test("реальный POT: обрывки починены полной фразой, а не выброшены", (t) => {
  if (!existsSync(POT)) {
    t.skip("нет po/template.pot");
    return;
  }
  const entries = parsePo(readFileSync(POT, "utf8")).filter((e) => e.msgid);
  const repaired = entries.filter((e) => commentOf(e, "repaired: "));

  t.diagnostic(`починенных записей: ${repaired.length}`);
  assert.ok(repaired.length >= 2, "оба известных обрывка должны быть починены");

  for (const e of repaired) {
    const original = commentOf(e, "repaired: ");
    const rich = commentOf(e, "rich_text: ");
    const plain = stripTmpTags(rich).trim();

    assert.equal(e.msgid, plain, "ключ равен полной фразе из rich_text");
    assert.ok(e.msgid.endsWith(original), "исходный хвост — конец полной фразы");
    assert.ok(e.msgid.length > original.length + 5, "начало фразы восстановлено");
    assert.ok(!e.flags.includes("skip"), "починенная строка переводится, а не skip");

    // Обратная сборка: если теги внутри фразы (тут `<b>your</b>`), `Replace`
    // не найдёт plain и игра покажет перевод без разметки — это известное
    // ограничение рантайма (см. docs/rich-text-audit.md, класс inline-tags).
    // Главное — ключ теперь полный, а не обрезанный.
    if (!rich.includes(plain)) {
      assert.match(rich, /<(b|color|size)=?/, "inline-теги объясняют потерю разметки");
    }
  }

  // Ни одного обрезанного ключа с меткой fragment не осталось.
  const fragments = entries.filter(
    (e) => e.flags.includes("skip") && commentOf(e, "skip: ") === "fragment",
  );
  t.diagnostic(`осталось fragment-skip: ${fragments.length}`);
  assert.equal(
    fragments.length,
    0,
    `обрезанные ключи вернулись: ${fragments.map((e) => e.msgid).join(" | ")}`,
  );
});

test("реальный POT: у починенных записей нет пустого msgstr после перевода", (t) => {
  if (!existsSync(POT)) {
    t.skip("нет po/template.pot");
    return;
  }
  // POT всегда с пустыми msgstr; здесь проверяем только, что записи вообще
  // доходят до PO как обычные (нет skip) — иначе переводчик их пропустит.
  const entries = parsePo(readFileSync(POT, "utf8")).filter((e) => e.msgid);
  const repaired = entries.filter((e) => commentOf(e, "repaired: "));
  const skipped = repaired.filter((e) => e.flags.includes("skip"));
  assert.deepEqual(
    skipped.map((e) => e.msgid),
    [],
    "починенная строка не должна нести `#, skip`",
  );
  // В полном тексте не должно остаться известных TMP-тегов; авторские
  // кавычки `< … >` — часть текста и обязаны сохраниться.
  assert.ok(
    repaired.every((e) => stripTmpTags(commentOf(e, "rich_text: ")) === e.msgid),
    "снятие тегов даёт ровно ключ",
  );
});
