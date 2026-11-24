/**
 * rich_tags.test.mts — парсер TMP-разметки и перенос тегов без догадок.
 *
 * Главные уроки (2026-11-24):
 *   1. регекс `<[^>]+>` принимал авторские `< … >` и `<< … >>` за теги;
 *   2. пропорциональный перенос разметки ставил тег на угаданное место и давал
 *      `<b> </b>` посреди фразы — игрок это видит, поэтому позиция не
 *      угадывается: не нашлось буквально — тег не ставим.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findArtifacts,
  isDegeneratePlacement,
  parseTags,
  placeTags,
  retagKeepingPositions,
  segmentsOf,
  tagRaws,
  tagSignature,
} from "./rich_tags.mts";

test("parseTags: настоящие теги и параметры", () => {
  assert.deepEqual(
    parseTags("<i>a <color=#EB83FF>b</color></i>").map((t) => t.raw),
    ["<i>", "<color=#EB83FF>", "</color>", "</i>"],
  );
  assert.deepEqual(
    parseTags("<b><size=55>x</b></size>").map((t) => t.name),
    ["b", "size", "b", "size"],
  );
});

test("parseTags: авторские угловые кавычки — НЕ теги", () => {
  assert.deepEqual(parseTags("< Like this, hmmm...? >"), []);
  assert.deepEqual(parseTags("<< Declination processed. Proceeding relocation. >>"), []);
  assert.deepEqual(parseTags("While making out>"), []);
});

test("parseTags: <color=yellow> внутри << … >> разбирается верно", () => {
  const tags = parseTags("<<color=yellow>5297</color>>");
  assert.deepEqual(
    tags.map((t) => t.raw),
    ["<color=yellow>", "</color>"],
    "внешние << и >> остаются текстом",
  );
});

test("findArtifacts: тег на пробеле/пунктуации и пустая пара — артефакты", () => {
  assert.ok(findArtifacts("Всё дело в твоём<b> </b>комфорте").length > 0);
  assert.ok(findArtifacts("<i></i>текст").length > 0);
  assert.ok(findArtifacts("Текст <color=#fff>…</color>).").length > 0);
  assert.ok(findArtifacts("текст <b>").length > 0, "открывающий тег в конце");
  assert.deepEqual(findArtifacts("<i>нормальный текст</i>"), []);
  assert.deepEqual(findArtifacts("Просто <b>слово</b> в фразе"), []);
});

test("placeTags: обёртка переносится точно, вложенность сохраняется", () => {
  assert.equal(placeTags("<i>Hello there.</i>", "Привет.").rt, "<i>Привет.</i>");
  assert.equal(
    placeTags("<color=#EB83FF><i>Hey</i></color>", "Эй").rt,
    "<color=#EB83FF><i>Эй</i></color>",
  );
});

test("placeTags: реордер перевода — тег НЕ выдумывается", () => {
  // «bold word» переставлено так, что подсвеченное слово не находится.
  const rich = "A <b>bold</b> word";
  const placed = placeTags(rich, "Слово жирным шрифтом");
  assert.equal(placed.rt, "Слово жирным шрифтом", "тегов нет — позиция не подтверждена");
  assert.equal(placed.dropped, 2, "оба тега пары ушли в отчёт");
  assert.deepEqual(findArtifacts(placed.rt), [], "мусора не появилось");
});

test("placeTags: буквально найденный фрагмент ставится на своё место", () => {
  const rich = "Ask <b>Zoey</b> about it.";
  const placed = placeTags(rich, "Спроси Зои об этом. Zoey тут?");
  assert.equal(placed.rt, "Спроси Зои об этом. <b>Zoey</b> тут?");
  assert.equal(placed.dropped, 0);
});

test("placeTags: тег на пробел/пунктуацию не появляется никогда", () => {
  const cases: [string, string][] = [
    ["A <b>bold</b> word", "Слово"],
    ["x <color=#fff>.</color> y", "x . y"],
    ["<i>a</i>", "а"],
  ];
  for (const [rich, text] of cases) {
    const rt = placeTags(rich, text).rt;
    assert.deepEqual(findArtifacts(rt), [], `${rich} → ${rt}: артефактов нет`);
  }
});

test("placeTags: непарный тег игры (обрезка хвоста) переносится на край", () => {
  assert.equal(placeTags("<i>> Aaahhh!!", "> Ааахх!!").rt, "<i>> Ааахх!!");
  assert.equal(placeTags("Text.. </i>", "Текст..").rt, "Текст..", "закрытие без открытия не тащим");
});

test("placeTags: детерминированность и идемпотентность", () => {
  const rich = "A <b>bold</b> word";
  const a = placeTags(rich, "Слово жирным шрифтом");
  const b = placeTags(rich, "Слово жирным шрифтом");
  assert.equal(a.rt, b.rt);
  assert.equal(placeTags(rich, a.rt).rt, a.rt);
});

test("segmentsOf: пары и чистый текст, перекрещенные закрытия не ломают разбор", () => {
  const s = "<i>a <color=#fff>b</i>c</color>";
  assert.equal(segmentsOf(s).plain, "a bc");
  assert.deepEqual(tagSignature(s), ["i", "color", "/i", "/color"]);
});

test("retagKeepingPositions: перверсивный <font> снимается, теги — из rich_text", () => {
  const rich = "<i>(He wants <color=#EB83FF>more</color>.)</i>";
  const legacy = '<i>(Он хочет <color=#B867FF><font="F" material="M">больше</font></color>.)</i>';
  assert.equal(
    retagKeepingPositions(legacy, rich),
    "<i>(Он хочет <color=#EB83FF>больше</color>.)</i>",
  );
  assert.deepEqual(tagRaws(retagKeepingPositions(legacy, rich) as string), tagRaws(rich));
  assert.equal(retagKeepingPositions("<i>текст</i>", rich), null, "структура разошлась");
});

test("isDegeneratePlacement: «вся строка выделена» вместо фрагмента", () => {
  const rich = "A <b>bold</b> word";
  assert.equal(isDegeneratePlacement("<b>Жирное слово</b>", rich), true);
  assert.equal(isDegeneratePlacement("Жирное <b>слово</b>", rich), false);
});
