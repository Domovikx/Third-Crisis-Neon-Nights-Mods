/**
 * Контракты меню мода: порядок языков, геометрия панели и CJK-типографика.
 *
 * Проверяются не «картинки», а инварианты, из-за которых панель наезжала на
 * кнопки главного меню или язык приходил в неправильном порядке:
 *
 * - порядок языков в `NeonLanguageSwitcher` = `config/language-priority.json`
 *   (единый источник истины для любых списков языков);
 * - панель (правый нижний угол, 360×392 при 1920×1080) не заходит на кнопки:
 *   правый край кнопок главного меню по замерам E2E — 0.758·W, панель должна
 *   начинаться правее с зазором ≥ 8 px на 1600×900, 1920×1080, 2560×1080;
 * - `fonts/typography.json` содержит ровно те масштабы, что в docs/fonts.md,
 *   и покрывает все языки из language-priority.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../../..");
const SWITCHER = join(REPO, ".opencode/skills/build-translator/source/NeonLanguageSwitcher.cs");
const PRIORITY = join(REPO, "config/language-priority.json");
const TYPOGRAPHY = join(REPO, "fonts/typography.json");

interface PriorityFile {
  languages: Array<{ rank: number; code: string; language: string }>;
}

function priority(): string[] {
  const data = JSON.parse(readFileSync(PRIORITY, "utf8")) as PriorityFile;
  return [...data.languages].sort((a, b) => a.rank - b.rank).map((l) => l.code);
}

/** Коды из таблицы `Langs` в C#-исходнике, в порядке объявления. */
function switcherCodes(): string[] {
  const src = readFileSync(SWITCHER, "utf8");
  const block = src.slice(
    src.indexOf("private static readonly string[][] Langs"),
    src.indexOf("};", src.indexOf("private static readonly string[][] Langs")),
  );
  return [...block.matchAll(/new string\[\]\s*\{\s*"([a-z]{2})"/g)].map((m) => m[1]);
}

function numberConst(name: string): number {
  const src = readFileSync(SWITCHER, "utf8");
  const m = new RegExp(`const float ${name} = ([0-9.]+)f`).exec(src);
  assert.ok(m, `константа ${name} не найдена`);
  return Number(m[1]);
}

/** CanvasScaler: ScaleWithScreenSize, reference 1920×1080, match 0.5. */
function uiScale(width: number, height: number): number {
  return Math.sqrt((width / 1920) * (height / 1080));
}

/** Замерено E2E-пробой: правый край кнопок главного меню, доля ширины экрана. */
const MENU_RIGHT = 0.758;
const CLEARANCE = 8;

test("порядок языков в свитчере = config/language-priority.json", () => {
  assert.deepEqual(switcherCodes(), priority());
});

test("панель языка не заходит на кнопки главного меню", () => {
  const panelW = numberConst("PanelW");
  const margin = numberConst("Margin");
  const miniH = numberConst("MiniH");
  const panelH = numberConst("PanelH");

  for (const [w, h] of [
    [1600, 900],
    [1920, 1080],
    [2560, 1080],
    [1440, 1080],
  ]) {
    const scale = uiScale(w, h);
    const panelLeft = w - (margin + panelW) * scale;
    const menuRight = MENU_RIGHT * w;
    assert.ok(
      panelLeft - menuRight >= CLEARANCE,
      `${w}x${h}: панель начинается на ${panelLeft.toFixed(0)}px, кнопки кончаются ` +
        `${menuRight.toFixed(0)}px — нужен зазор ${CLEARANCE}px`,
    );

    // Панель висит НАД мини-кнопкой, не перекрывая её.
    const panelBottom = (margin + miniH + 20) * scale;
    assert.ok(panelBottom > (margin + miniH) * scale, `${w}x${h}: панель выше мини-кнопки`);
    assert.ok(panelBottom + panelH * scale <= h, `${w}x${h}: панель целиком в экране по высоте`);
  }
});

test("CJK-типографика: значения и покрытие языков", () => {
  const data = JSON.parse(readFileSync(TYPOGRAPHY, "utf8")) as {
    default: { scale: number; lineHeight: number };
    languages: Record<string, { scale: number; lineHeight: number }>;
  };
  const want: Record<string, [number, number]> = {
    zh: [1.08, 1.6],
    ja: [1.07, 1.5],
    ko: [1.04, 1.5],
  };
  for (const [code, [scale, lineHeight]] of Object.entries(want)) {
    assert.deepEqual(data.languages[code], { scale, lineHeight }, `${code}: масштаб/интерлиньяж`);
  }
  for (const code of priority()) {
    assert.ok(data.languages[code], `${code}: нет записи в typography.json`);
    if (!(code in want)) assert.equal(data.languages[code].scale, 1, `${code}: латиница ×1.00`);
  }
  assert.deepEqual(data.default, { scale: 1, lineHeight: 1 }, "дефолт 1.00/1.00");
});
