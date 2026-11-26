/**
 * Тесты лендинга: цифры страницы обязаны совпадать с данными, языки — идти
 * в порядке `config/language-priority.json`, обе версии (ru/en) — собираться
 * без неподставленных плейсхолдеров, а скриншоты — существовать.
 *
 * Снимок чисел (14 365 / 2 374 / 10 / 0) закреплён намеренно: рост корпуса или
 * потеря строк — повод осознанно обновить лендинг, а не молчаливая правда.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, translateLangs } from "./languages.mts";
import { SITE_VERSION, langRows, renderSite, siteStats } from "./build_site.mts";
import { NATIVE_NAMES } from "../site/i18n.mts";

const RU = renderSite("ru");
const EN = renderSite("en");
const ROWS = langRows();
const STATS = siteStats(ROWS);

test("обе версии собираются без неподставленных плейсхолдеров", () => {
  for (const [name, html] of [
    ["ru", RU],
    ["en", EN],
  ] as const) {
    assert.ok(!/\{\{[\w.]+\}\}/.test(html), `${name}: остался плейсхолдер`);
  }
});

test("языки идут в порядке приоритета, английского в сетке нет", () => {
  const expected = translateLangs();
  assert.deepEqual(
    expected,
    ["zh", "ru", "es", "pt", "de", "ja", "fr", "pl", "ko", "it"],
    "порядок должен совпадать с config/language-priority.mts",
  );

  const grid = RU.slice(
    RU.indexOf('<ul class="lang-grid">'),
    RU.indexOf("</ul>", RU.indexOf('<ul class="lang-grid">')),
  );
  let cursor = -1;
  for (const code of expected) {
    const pos = grid.indexOf(`lang="${code}"`);
    assert.ok(pos > cursor, `${code}: карточка вне порядка или отсутствует`);
    cursor = pos;
    assert.ok(grid.includes(NATIVE_NAMES[code]), `${code}: нет нативного названия`);
  }
  assert.ok(!grid.includes('lang="en"'), "английский — источник, не карточка перевода");
});

test("цифры страницы совпадают с po/ и шаблоном", () => {
  assert.equal(STATS.lines, 14_365);
  assert.equal(STATS.rich, 2_374);
  assert.equal(STATS.langs, 10);
  assert.equal(STATS.missing, 0);

  assert.ok(RU.includes("14 365"), "строк на язык");
  assert.ok(RU.includes("2 374"), "строк с разметкой");
  assert.ok(RU.includes('stat-value">0<'), "непереведённых строк");
  assert.ok(RU.includes(`v${SITE_VERSION}`), "версия в бейджах");
});

test("каждый язык переведён полностью (страница не врёт про 0)", () => {
  const translated = ROWS.filter((r) => r.code !== "en");
  for (const row of translated) {
    assert.equal(row.total, STATS.lines, `${row.code}: другое число строк`);
    assert.equal(row.filled, row.total, `${row.code}: есть непереведённые строки`);
    assert.equal(row.pct, 100, `${row.code}: покрытие не 100%`);
  }
});

test("английская версия действительно английская", () => {
  assert.ok(EN.includes('<html lang="en">'));
  assert.ok(EN.includes("What is translated"));
  assert.ok(EN.includes("Download (exe)"));
  assert.ok(EN.includes('href="index.html"'), "переключатель ведёт на русскую версию");
  assert.ok(!EN.includes("Что переводится"), "русский текст не протёк в en");
});

test("скриншоты на месте и упомянуты в разметке", () => {
  const shots = [
    "menu-en.jpg",
    "menu-ru.jpg",
    "language-panel.jpg",
    "specimen-zh.jpg",
    "font-demo-ru.jpg",
  ];
  for (const file of shots) {
    assert.ok(existsSync(join(REPO_ROOT, "site", "shots", file)), `нет файла ${file}`);
    assert.ok(RU.includes(`shots/${file}`), `нет ссылки на ${file}`);
  }
});

test("страница без эмодзи и с базовой структурой", () => {
  for (const html of [RU, EN]) {
    assert.ok(!/\p{Extended_Pictographic}/u.test(html), "эмодзи в разметке");
    assert.equal(html.match(/<h1>/g)?.length, 1, "должен быть ровно один h1");
    assert.ok(html.includes('name="viewport"'));
    assert.ok(html.includes('rel="alternate"'));
    assert.ok(html.includes('id="install"'));
    assert.ok(html.includes('id="faq"'));
  }
});

test("текст с угловыми скобками экранирован, а не съеден как тег", () => {
  assert.ok(RU.includes("po/&lt;lang&gt;.po"));
  assert.ok(EN.includes("po/&lt;lang&gt;.po"));
});
