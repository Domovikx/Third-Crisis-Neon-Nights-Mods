/**
 * Гард шрифтов: в `fonts/` лежат файлы цепочки, и ни один символ корпуса не
 * остаётся без глифа (иначе в игре — «тофу»). Политика — `docs/fonts.md`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  FACE_FOR_LANG,
  FONT_CHAIN,
  REPO_ROOT,
  checkFonts,
  corpusChars,
  covers,
  glyphRanges,
} from "./font_coverage.mts";

test("шрифты цепочки на месте и не пустые", () => {
  for (const font of FONT_CHAIN) {
    const path = join(REPO_ROOT, "fonts", font);
    assert.ok(existsSync(path), `нет шрифта ${font}`);
    assert.ok(statSync(path).size > 1000, `подозрительно маленький ${font}`);
  }
  for (const font of new Set(Object.values(FACE_FOR_LANG))) {
    assert.ok(FONT_CHAIN.includes(font), `${font} нет в цепочке фолбэков`);
  }
});

test("каждый язык po имеет основной шрифт", () => {
  for (const lang of Object.keys(FACE_FOR_LANG)) {
    assert.ok(corpusChars(lang).length > 0, `пустой корпус ${lang}`);
  }
});

test("ни одного тофу: все символы корпуса покрыты цепочкой", () => {
  const bad = checkFonts().filter((r) => r.uncovered.length > 0);
  const detail = bad
    .map(
      (r) =>
        `${r.lang}: ${r.uncovered.map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(" ")}`,
    )
    .join("; ");
  assert.deepEqual(
    bad.map((r) => r.lang),
    [],
    `не покрыто: ${detail}`,
  );
});

test("covers: границы диапазона включительные", () => {
  const ranges = glyphRanges(join(REPO_ROOT, "fonts", FONT_CHAIN[0]));
  assert.equal(covers(ranges, 0x41), true); // A
  assert.equal(covers(ranges, 0x0a), false); // перевод строки — не глиф
});
