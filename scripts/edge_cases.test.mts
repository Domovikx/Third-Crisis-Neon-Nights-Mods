/**
 * edge_cases.test.mts — скрытые дефекты пайплайна PO/POT/дамп.
 *
 * Каждый тест — воспроизводимый краевой случай, которого НЕ ловит текущая
 * матрица (`npm test`): фикстура собирается тут же в `tmp/`, проверяется
 * поведение рабочего кода (Rust-бинарники `rust-l10n`/`rust-lint` и TS-парсер
 * PO, который остался оракулом гейтов).
 *
 * Тесты НАМЕРЕННО красные на текущем коде: это дефекты, а не регрессии.
 * Чинить — в прод-коде (другой поток) по строкам отчёта «где чинить»;
 * правок `po/*.po` и прод-кода здесь нет by design.
 *
 * Найдено 2026-11-25 разбором границ строк, PO-механики и потребителя `.dat`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parsePo, renderPo, newEntry } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import { auditPoText } from "./rich_gate.mts";
import { l10nBinary } from "./text_cli.mts";

const REPO = resolve(import.meta.dirname, "..");
const TMP = join(REPO, "tmp");
mkdirSync(TMP, { recursive: true });
const WORK = mkdtempSync(join(TMP, "edge-cases-"));
after(() => rmSync(WORK, { recursive: true, force: true }));

const bin = l10nBinary(REPO);
const skipL10n = bin ? false : "rust-l10n не собран (npm run l10n:build)";
const lintBin = [
  join(REPO, "tools", "rust-lint", "target", "release", "rust-lint.exe"),
  join(REPO, "tools", "rust-lint", "target", "release", "rust-lint"),
].find((p) => existsSync(p));
const skipLint = lintBin ? false : "rust-lint не собран (npm run rust:lint:build)";

/** Шапка POT: контракт `pot_invariants` (без неё po2dat не проверить). */
const POT_HEAD = [
  'msgid ""',
  'msgstr "Project-Id-Version: t\\nPOT-Creation-Date: 2000-01-01 00:00+0000\\nContent-Type: text/plain; charset=UTF-8\\nContent-Transfer-Encoding: 8bit\\n"',
  "",
];

/** Корень прогона: `<dir>/po/template.pot` + `<dir>/po/ru.po`. */
function fixture(
  name: string,
  potLines: string[],
  poLines: string[],
): { dir: string; poDir: string } {
  const dir = mkdtempSync(join(WORK, `${name}-`));
  const poDir = join(dir, "po");
  mkdirSync(poDir, { recursive: true });
  writeFileSync(join(poDir, "template.pot"), `${potLines.join("\n")}\n`);
  writeFileSync(join(poDir, "ru.po"), `${poLines.join("\n")}\n`);
  return { dir, poDir };
}

const MIN_POT = [...POT_HEAD, "#. src: ui", 'msgctxt "ui"', 'msgid "Hello"', 'msgstr ""', ""];

/** Строка `.dat` → строки полезных полей. */
function datRows(path: string): Array<Record<string, string>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>);
}

// ---------------------------------------------------------------------------
// 1. PO-механика: fuzzy
// ---------------------------------------------------------------------------

test(
  "po2dat: `#, fuzzy` не должен молча становиться финальным переводом",
  { skip: skipL10n },
  () => {
    // На реальных данных 28 таких строк уже уехали в runtime/patch_ru.dat
    // (например «Dialogue 1» → «ДИАЛОГ», где потерян номер).
    const { dir } = fixture(
      "fuzzy",
      [
        ...POT_HEAD,
        "#. src: ui",
        'msgctxt "ui"',
        'msgid "Dialogue 1"',
        'msgstr ""',
        "",
        "#. src: ui",
        'msgctxt "ui"',
        'msgid "Plain"',
        'msgstr ""',
        "",
      ],
      [
        'msgid ""',
        'msgstr "Project-Id-Version: t\\nContent-Type: text/plain; charset=UTF-8\\nContent-Transfer-Encoding: 8bit\\n"',
        "",
        "#, fuzzy",
        'msgctxt "ui"',
        'msgid "Dialogue 1"',
        'msgstr "ДИАЛОГ"',
        "",
        'msgctxt "ui"',
        'msgid "Plain"',
        'msgstr "Обычный"',
        "",
      ],
    );
    const out = join(dir, "out.dat");
    const run = spawnSync(bin as string, ["po2dat", "ru", "--root", dir, "--out", out], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const shipped = datRows(out).find((row) => row.t === "Dialogue 1");
    assert.ok(
      !shipped,
      `fuzzy-перевод скомпилирован в .dat без единого упоминания в отчёте: ${JSON.stringify(shipped)}. ` +
        "Ожидание: `#, fuzzy` = «перевод не готов» (так его понимает gettext и так же уже " +
        "обрабатывается `auto-normalized`); строка либо не компилируется, либо попадает в счётчик отчёта.",
    );
  },
);

// ---------------------------------------------------------------------------
// 2. Пайплайн: пустой PO
// ---------------------------------------------------------------------------

test("po2dat: пустой PO не должен давать 0-байтный словарь с кодом 0", { skip: skipL10n }, () => {
  const { dir, poDir } = fixture("empty-po", MIN_POT, [""]);
  writeFileSync(join(poDir, "ru.po"), "");
  const out = join(dir, "out.dat");
  const run = spawnSync(bin as string, ["po2dat", "ru", "--root", dir, "--out", out], {
    encoding: "utf8",
  });
  // Проверка «успех = словарь» есть у выпуска (validateSources), но не у po2dat:
  // усечённый/чужой PO даёт короткий .dat, а полнота языков нигде не гейтится.
  assert.notEqual(
    run.status,
    0,
    `пустой PO собрался в ${readFileSync(out).byteLength} байт с кодом 0 — потеря всего словаря неотличима от успеха`,
  );
});

test(
  "po2dat: гейт одной догадки не должен удалять человеческий перевод того же текста",
  { skip: skipL10n },
  () => {
    // Дубли текста решаются «earliest-ref-wins», и гейт `auto-normalized`
    // смотрит ТОЛЬКО на победителя, а потом делает `continue` — на весь текст.
    // Если догадка оказалась первой по ссылке, валидный перевод человека
    // под другим контекстом исчезает вместе с ней (0 строк в .dat).
    const { dir } = fixture(
      "gate-winner",
      [
        ...POT_HEAD,
        "#. src: ui",
        'msgctxt "ui"',
        'msgid "Same"',
        'msgstr ""',
        "",
        "#. src: ui",
        'msgctxt "speaker:A"',
        'msgid "Same"',
        'msgstr ""',
        "",
      ],
      [
        'msgid ""',
        'msgstr "Project-Id-Version: t\\nContent-Type: text/plain; charset=UTF-8\\nContent-Transfer-Encoding: 8bit\\n"',
        "",
        "#: translations/aaa.yaml",
        "#, auto-normalized",
        'msgctxt "ui"',
        'msgid "Same"',
        'msgstr "догадка"',
        "",
        "#: translations/zzz.yaml",
        'msgctxt "speaker:A"',
        'msgid "Same"',
        'msgstr "человек"',
        "",
      ],
    );
    const out = join(dir, "out.dat");
    const run = spawnSync(bin as string, ["po2dat", "ru", "--root", dir, "--out", out], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const row = datRows(out).find((r) => r.t === "Same");
    assert.equal(
      row?.x,
      "человек",
      `перевод человека удалён вместе с гейтнутой догадкой (строк в .dat: ${datRows(out).length}). ` +
        "Ожидание: гейт скрывает ОДИН вариант, а не текст целиком — нужен фолбэк на следующий вариант.",
    );
  },
);

// ---------------------------------------------------------------------------
// 3. Форматирование: множественное число (msgstr[N])
// ---------------------------------------------------------------------------

test("parsePo: msgstr[N] не должен теряться молча (шапка объявляет Plural-Forms)", () => {
  // Шапка ru.po/prefill объявляет `Plural-Forms: nplurals=3`, Poedit по ней
  // вправе писать msgid_plural/msgstr[N]. Парсер (и TS, и Rust-зеркало) знает
  // только `msgstr`, поэтому перевод целой записи исчезает без ошибки.
  const text = [
    'msgid ""',
    'msgstr "Content-Type: text/plain; charset=UTF-8\\nPlural-Forms: nplurals=3;\\n"',
    "",
    'msgctxt "ui"',
    'msgid "%d item"',
    'msgid_plural "%d items"',
    'msgstr[0] "Предмет"',
    'msgstr[1] "Предмета"',
    'msgstr[2] "Предметов"',
    "",
  ].join("\n");
  const entry = parsePo(text).find((e) => e.msgid === "%d item");
  assert.ok(entry, "запись с msgid_plural не разобрана");
  assert.notEqual(
    entry.msgstr,
    "",
    "msgstr[0..2] потеряны: запись выглядит непереведённой, .dat получит пустой перевод, " +
      "и отчёт скажет `filled: 0` вместо «в PO форма, которую пайплайн не понимает»",
  );
});

// ---------------------------------------------------------------------------
// 4–5. Гейт rich_translation
// ---------------------------------------------------------------------------

/** Блок PO с rich-парой (текст намеренно параметризуется). */
function richBlock(richText: string, richTranslation: string, msgstr: string): string {
  return [
    "#. src: ui",
    `#. rich_text: ${richText}`,
    `#. rich_translation: ${richTranslation}`,
    'msgctxt "ui"',
    'msgid "Hello"',
    `msgstr "${msgstr}"`,
    "",
  ].join("\n");
}

test("rich_gate: CRLF не должен отключать проверку (0 записей = ложный зелёный)", () => {
  const lf = `${richBlock("<i>Hello</i>", "<i>Привет</i>", "Привет")}\n`;
  const crlf = lf.replace(/\n/g, "\r\n");
  const ok = auditPoText("ru", lf);
  const crlfResult = auditPoText("ru", crlf);
  assert.equal(ok.rich, 1, "контроль: LF-фикстура обязана проверяться");
  assert.equal(
    crlfResult.rich,
    1,
    "на CRLF гейт не нашёл НИ ОДНОЙ rich-записи (block-split по `\\n\\n` + `$` без /m не матчит `\\r`): " +
      "exit 0 и «нарушений нет» на любом CRLF-PO",
  );
});

test("rich_gate: потерянный пробел в rich_translation не должен считаться совпадением", () => {
  // denseText() удаляет ВСЕ пробелы, поэтому «Привет мир» и «Приветмир»
  // («склеенные» слова — видимый дефект) проходят как равные.
  const text = richBlock("<i>Hello world</i>", "<i>Приветмир</i>", "Приветмир");
  const r = auditPoText("ru", text);
  assert.equal(
    r.textMismatch.length,
    1,
    "текст rt отличается от msgstr только пробелом — и это не поймано: " +
      "пробел в переводе может исчезнуть или удвоиться, гейт зелёный",
  );
});

// ---------------------------------------------------------------------------
// 6–7. po_update: шапка и гейт ревью
// ---------------------------------------------------------------------------

test(
  "po_update: шапка PO не должна теряться, если после неё нет пустой строки",
  { skip: skipL10n },
  () => {
    const { poDir } = fixture("noblank", MIN_POT, [
      'msgid ""',
      'msgstr "Project-Id-Version: NeonTranslator 1.0\\nLanguage: ru\\nContent-Type: text/plain; charset=UTF-8\\nContent-Transfer-Encoding: 8bit\\nPlural-Forms: nplurals=3;\\n"',
      // пустой строки между шапкой и первой записью нет
      'msgctxt "ui"',
      'msgid "Hello"',
      'msgstr "Привет"',
      "",
    ]);
    const run = spawnSync(bin as string, ["po_update", "ru", "--po-dir", poDir, "--no-backup"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const out = readFileSync(join(poDir, "ru.po"), "utf8");
    assert.match(
      out,
      /Project-Id-Version: NeonTranslator 1\.0/,
      "шапка выброшена: extract_header принял первый блок за запись (entry_ahead), " +
        "а перевод ушёл в файл без Language/Plural-Forms — молча и без предупреждения",
    );
  },
);

test("po_update: флаг auto-normalized не должен сниматься до ревью", { skip: skipL10n }, () => {
  const { poDir } = fixture("autonorm", MIN_POT, [
    'msgid ""',
    'msgstr "Project-Id-Version: t\\nContent-Type: text/plain; charset=UTF-8\\nContent-Transfer-Encoding: 8bit\\n"',
    "",
    "#, fuzzy, auto-normalized",
    'msgctxt "ui"',
    'msgid "Hello"',
    'msgstr "Привет"',
    "",
  ]);
  const run = spawnSync(bin as string, ["po_update", "ru", "--po-dir", poDir, "--no-backup"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const out = readFileSync(join(poDir, "ru.po"), "utf8");
  assert.match(
    out,
    /auto-normalized/,
    "флаг снят: `po2dat` пропускает строки с `auto-normalized` именно как «догадка ждёт человека», " +
      "но po_update стирает флаг, и машинная догадка prefill уезжает в .dat без ревью (гейт мёртв)",
  );
});

// ---------------------------------------------------------------------------
// 8. Аудит данных: `#, skip` не должен считаться пропавшим ключом
// ---------------------------------------------------------------------------

test(
  "rust-lint: ключи POT с `#, skip` не должны попадать в po.missing-key",
  { skip: skipLint },
  () => {
    const dir = mkdtempSync(join(WORK, "lint-"));
    const pot = [
      ...POT_HEAD,
      "#. src: ui",
      "#, skip",
      "#. skip: reviewed",
      'msgctxt "ui"',
      'msgid "Apl_Noise"',
      'msgstr ""',
      "",
      "#. src: ui",
      'msgctxt "ui"',
      'msgid "Hello"',
      'msgstr ""',
      "",
    ].join("\n");
    const po = [
      'msgid ""',
      'msgstr "Content-Type: text/plain; charset=UTF-8\\n"',
      "",
      "#. src: ui",
      'msgctxt "ui"',
      'msgid "Hello"',
      'msgstr "Привет"',
      "",
    ].join("\n");
    writeFileSync(join(dir, "template.pot"), pot);
    writeFileSync(join(dir, "ru.po"), po);
    const jsonDir = join(dir, "out");
    const run = spawnSync(
      lintBin as string,
      [
        "--root",
        REPO,
        "--lang",
        "ru",
        "--pot",
        join(dir, "template.pot"),
        "--po",
        join(dir, "ru.po"),
        "--no-dat",
        "--json-dir",
        jsonDir,
        "--no-report",
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(readFileSync(join(jsonDir, "lint-ru.json"), "utf8")) as {
      classes: Record<string, { count: number; samples: Array<{ text: string }> }>;
    };
    const missing = report.classes["po.missing-key"];
    assert.equal(
      missing.count,
      0,
      `ключа с \`#, skip\` нет в PO — это норма (po_update их не заводит), а аудит считает error: ` +
        `${JSON.stringify(missing.samples)}. На реальных данных это 4080 ложных error ` +
        `(ровно число skip-записей POT 18445−14365), из-за которых настоящие находки не видны, ` +
        "а `--fail-on-error` не подключается",
    );
  },
);

// ---------------------------------------------------------------------------
// 9. Потребитель .dat: парсер C# не умеет \n / \t / \uXXXX
// ---------------------------------------------------------------------------

/** Ровно `TranslationLoader.UnescapeDat` (build-translator/source): только `\"` и `\\`. */
function csharpUnescapeDat(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Строка в том виде, в каком она лежит в `.dat` (без внешних кавычек). */
const wireForm = (value: string): string => JSON.stringify(value).slice(1, -1);

test("dat: значения с переводом строки должен переживать парсер рантайма", () => {
  // Производитель (`json.rs`) экранирует как JSON.stringify, потребитель
  // (`TranslationLoader.ParseDatLine` + `UnescapeDat`) — ручной парсер с двумя
  // заменами. Тест гоняет реальные `runtime/patch_*.dat` через модель потребителя.
  const broken: string[] = [];
  for (const lang of ["ru", "de", "zh"]) {
    const path = join(REPO, "runtime", `patch_${lang}.dat`);
    if (!existsSync(path)) continue;
    for (const row of datRows(path)) {
      for (const key of ["t", "x", "r", "rt"]) {
        const value = row[key];
        if (typeof value !== "string") continue;
        if (csharpUnescapeDat(wireForm(value)) === value) continue;
        broken.push(`${lang}:${key}: ${JSON.stringify(value.slice(0, 50))}`);
      }
    }
  }
  assert.deepEqual(
    broken.slice(0, 8),
    [],
    `значения с \\n рантайм прочитает как литеральные «\\n» (16 строк в ru): ключ не совпадёт с текстом ` +
      `игрока, перевод покажет «\\n» вместо переноса. Нужен либо JSON-unescape в рантайме, либо запрет ` +
      `переводов строк в .dat`,
  );
});

// ---------------------------------------------------------------------------
// 10. Управляющие символы: запись PO
// ---------------------------------------------------------------------------

test("po_update: управляющие символы не должны попадать в PO сырыми", { skip: skipL10n }, () => {
  // pot_invariants ловит NUL/0x0B в POT (инвариант 10), но у PO такого гейта нет,
  // а `escape_po` экранирует только \\ " \r \n \t — 0x00/0x0B пишутся в файл байтом.
  const { poDir } = fixture("ctrl", MIN_POT, [
    'msgid ""',
    'msgstr "Project-Id-Version: t\\nContent-Type: text/plain; charset=UTF-8\\nContent-Transfer-Encoding: 8bit\\n"',
    "",
    'msgctxt "ui"',
    'msgid "Hello"',
    'msgstr "a\u0000b\u000bc"',
    "",
  ]);
  const run = spawnSync(bin as string, ["po_update", "ru", "--po-dir", poDir, "--no-backup"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const out = readFileSync(join(poDir, "ru.po"), "utf8");
  assert.ok(
    !out.includes("\u0000") && !out.includes("\u000b"),
    "в PO записаны сырые U+0000/U+000B: файл перестаёт быть текстовым (msgfmt/редакторы " +
      "и наш собственный round-trip на них не рассчитаны), а .dat унесёт их в игру",
  );
});

test("renderPo: контрольный пример — сырые управляющие байты видны и в TS-рендере", () => {
  // Тот же дефект в TS-зеркале (`po_file.mts`): гейты (pot_invariants) читают
  // им файл, поэтому «побайтно как эталон» не спасает от невалидного control-символа.
  const entry = newEntry();
  entry.msgid = "a\u0000b";
  entry.msgstr = "c\u000bd";
  const out = renderPo([entry], []);
  assert.ok(
    !out.includes("\u0000") && !out.includes("\u000b"),
    `renderPo выпускает управляющие символы как есть: ${JSON.stringify(out)}`,
  );
});
