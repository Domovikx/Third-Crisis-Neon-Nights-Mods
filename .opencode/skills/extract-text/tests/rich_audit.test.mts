/**
 * Тесты аудита TMP-разметки (`rich_audit.mts`).
 *
 * Классы — это ФАКТЫ для человека, а не фильтр: тест фиксирует, что каждая
 * ситуация попадает в свой класс и что «здоровое» не шумит.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { audit, richProblems, tokenizeTags } from "../scripts/rich_audit.mts";
import { newEntry } from "../scripts/po_file.mts";

test("tokenizeTags: имена, закрытие и порядок", () => {
  assert.deepEqual(
    tokenizeTags("<color=#fff><i>x</i></color>").map((t) => [t.name, t.closing]),
    [
      ["color", false],
      ["i", false],
      ["i", true],
      ["color", true],
    ],
  );
});

test("здоровая разметка не даёт проблем", () => {
  const p = richProblems("<i><color=#EB83FF>Yesss...!~</color></i>");
  assert.deepEqual(p.unbalanced, []);
  assert.deepEqual(p.crossed, []);
  assert.deepEqual(p.unclosed, []);
  assert.deepEqual(p.strayClose, []);
  assert.deepEqual(p.unknownTag, []);
  assert.equal(p.namedColor.length, 0);
});

test("unclosed / unclosed+unbalanced: данные игры (незакрытый <i>)", () => {
  const p = richProblems('<i>"However, the Blocker can deliver an infinite number."');
  assert.deepEqual(p.unclosed, ["<i>"]);
  assert.deepEqual(p.unbalanced, ["i: 1 откр / 0 закр"]);
});

test("crossed: закрытие нарушает порядок вложенности", () => {
  const p = richProblems(
    "<i>(<color=#EB83FF>C'mon Zoey.</color> <color=#EB83FF>Th</color>is not the time to get <color=#EB83FF>turned on.)</i></color>",
  );
  assert.ok(p.crossed.length > 0, JSON.stringify(p));
  assert.ok(
    p.crossed.some((c) => c.includes("</i> закрывает <color>")),
    JSON.stringify(p),
  );
});

test("stray-close: закрывающий тег без открывающего", () => {
  assert.deepEqual(richProblems("Text</i>").strayClose, ["</i>"]);
});

test("unknown-tag: имя вне списка TMP — это баг, а не данные", () => {
  assert.deepEqual(richProblems("<foo>x</foo>").unknownTag, ["<foo>", "</foo>"]);
});

test("malformed: обрыв внутри тега", () => {
  assert.deepEqual(richProblems("text <i").malformed, ["<i"]);
});

test("цвет: CSS-имя — норма, игровое имя без hex — потеря цвета", () => {
  const css = richProblems("<color=red>Wow</color>");
  assert.equal(css.cssColor.length, 1, "считаем открывающий тег; закрывающий не дублируется");
  assert.deepEqual(css.namedColor, []);

  const game = richProblems("<color=perversion>Wow</color>");
  assert.deepEqual(game.namedColor, ["<color=perversion>"]);
});

test("literal-angle: авторские кавычки не считаются тегами", () => {
  const p = richProblems("<i>< Like this, hmmm...? I love them. >");
  assert.equal(p.literalAngle, 1);
  assert.deepEqual(p.unknownTag, []);
  assert.deepEqual(p.malformed, []);
});

test("duplicate-tag: <i> внутри <i>", () => {
  assert.deepEqual(richProblems("<i>a <i>b</i></i>").duplicateTag, ["<i> внутри <i>"]);
});

test("audit: теги в ключе и обрывки различаются по src", () => {
  const mk = (msgid: string, src: string, rich?: string) => {
    const e = newEntry();
    e.msgid = msgid;
    e.comments = [`src: ${src}`, ...(rich ? [`rich_text: ${rich}`] : [])];
    return e;
  };
  const report = audit([
    mk(">> Message #23 - 03:23am", "dialog"),
    mk("(Finally, they", "dialog", "<i>(Finally, they"),
    mk("you request them. >", "dialog", "<i>< Like this, hmmm...? like <b>you</b> request them. >"),
    mk("Tail of bundle", "bundle", "<i>This is the beginning. Tail of bundle"),
  ]);
  assert.equal(report.counts["tag-in-msgid"], 1);
  assert.equal(report.counts["game-fragment"], 1, "dialog: обрезка пришла из данных игры");
  assert.equal(
    report.counts["self-fragment"],
    1,
    "bundle: ключ = хвост — это уже наша обрезка, а не данные",
  );
  assert.equal(report.withRich, 3);
});
