/**
 * text_parity.test.mts — паритет Rust-генераторов против TS-эталонов.
 *
 * Гейт миграции (`tasks/2026-11-22-rust-text-core.md`, `docs/language-audit.md`):
 *   - `potgen`: POT байт-в-байт с `potgen.mts` (даты фиксируются `--created`);
 *   - `po2dat`: `.dat` байт-в-байт с `po2dat.mts` на всех языках репозитория;
 *   - `po_update`: `<lang>.po` байт-в-байт с `po_update.mts` на всех 10 языках
 *     (`tasks/2026-11-22-rust-po-update.md`). Работа — на копиях в `tmp/`,
 *     `po/` не перезаписывается;
 *   - `prefill`: `<lang>.po` байт-в-байт с `prefill_po.mts` (фиксированная дата
 *     заголовка) на всех 10 языках + синтетический YAML-корпус (exact/fuzzy/
 *     auto-normalized/conflict/skip/blocklist);
 *   - `find_source`: тот же вывод `[kind:source#idx]` на мини-дампе и на реальном
 *     дампе (нужен `tmp/dump-new`, иначе тест пропускается).
 *
 * Без собранного `rust-l10n` тесты пропускаются (как `qa_parity.test.mts`):
 * сборка — `npm run l10n:build`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { buildDat, writeDat } from "../.opencode/skills/extract-text/scripts/po2dat.mts";
import { runPotgen } from "../.opencode/skills/extract-text/scripts/potgen.mts";
import { runPoUpdate } from "../.opencode/skills/extract-text/scripts/po_update.mts";
import { runPrefill } from "../.opencode/skills/extract-text/scripts/prefill_po.mts";
import {
  find as findSource,
  fmt as fmtSource,
} from "../.opencode/skills/extract-text/scripts/find_source.mts";

const REPO = resolve(import.meta.dirname, "..");
const CREATED = "2026-01-02 03:04+0000";

/** Собранный бинарь `rust-l10n` (Windows — .exe). */
function rustL10nBinary(root: string): string | null {
  const candidates = [
    join(root, "tools", "rust-l10n", "target", "release", "rust-l10n.exe"),
    join(root, "tools", "rust-l10n", "target", "release", "rust-l10n"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const bin = rustL10nBinary(REPO);
const skip = bin ? false : "rust-l10n не собран (npm run l10n:build)";

let tmp: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  tmp = mkdtempSync(join(REPO, "tmp", "text-parity-"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function rust(args: string[]): void {
  const run = spawnSync(bin as string, args, { encoding: "utf8" });
  assert.equal(run.status, 0, `rust-l10n ${args.join(" ")}: ${run.stderr}`);
}

/** POT мини-дампа: одинаковый вход, разные реализации. */
test("паритет potgen на мини-дампе: POT байт-в-байт", { skip }, async () => {
  const dump = join(REPO, ".opencode", "skills", "extract-text", "test_data", "tiny-dump");
  const tsOut = join(tmp, "tiny-ts.pot");
  const rustOut = join(tmp, "tiny-rust.pot");

  await runPotgen({ dumpDir: dump, outPath: tsOut, created: CREATED });
  rust(["potgen", "--root", tmp, "--dump", dump, "--out", rustOut, "--created", CREATED]);

  assert.equal(readFileSync(rustOut, "utf8"), readFileSync(tsOut, "utf8"));
});

/** Пот-паритет на реальном дампе (нет дампа — тест пропускается). */
const dumpDir = process.env.TCNN_DUMP_DIR ?? join(REPO, "tmp", "dump-new");
const dumpSkip = !existsSync(dumpDir) ? `нет дампа ${dumpDir}` : false;

test(
  "паритет potgen на реальном дампе: template.pot байт-в-байт (кроме даты)",
  { skip: skip || dumpSkip },
  async () => {
    const tsOut = join(tmp, "real-ts.pot");
    const rustOut = join(tmp, "real-rust.pot");
    await runPotgen({ dumpDir, outPath: tsOut, created: CREATED });
    rust(["potgen", "--root", tmp, "--dump", dumpDir, "--out", rustOut, "--created", CREATED]);
    assert.ok(readFileSync(tsOut).byteLength > 0);
    assert.equal(readFileSync(rustOut, "utf8"), readFileSync(tsOut, "utf8"));
  },
);

/** Все языки репозитория: `.dat` байт-в-байт. */
const LANGS = ["de", "es", "fr", "it", "ja", "ko", "pl", "pt", "ru", "zh"];

for (const lang of LANGS) {
  test(`паритет po2dat на ${lang}: .dat байт-в-байт`, { skip }, () => {
    const tsOut = join(tmp, `ts-${lang}.dat`);
    const rustOut = join(tmp, `rust-${lang}.dat`);
    const { rows } = buildDat(lang, REPO);
    writeDat(rows, tsOut);
    rust(["po2dat", lang, "--root", REPO, "--out", rustOut]);
    assert.ok(existsSync(tsOut));
    assert.equal(readFileSync(rustOut, "utf8"), readFileSync(tsOut, "utf8"));
  });
}

/**
 * Windows: `rename` в атомарной записи иногда получает EPERM от сканера или
 * индексатора (файл на миг занят) — паритетный прогон ретраит, а не краснеет.
 */
function withRetry<T>(fn: () => T, attempts = 20): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= attempts || (code !== "EPERM" && code !== "EBUSY")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** Заморозить даты в выводе PO (паритет сравнивает содержимое, не время). */
function normalizeDates(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\+0000$/gm, "<DATE>");
}

/** Все языки репозитория: `po_update` байт-в-байт (копии в tmp/). */
for (const lang of LANGS) {
  test(`паритет po_update на ${lang}: <lang>.po байт-в-байт`, { skip }, () => {
    const tsDir = join(tmp, `po-update-ts-${lang}`, "po");
    const rustDir = join(tmp, `po-update-rust-${lang}`, "po");
    for (const dir of [tsDir, rustDir]) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(REPO, "po", "template.pot"), join(dir, "template.pot"));
      copyFileSync(join(REPO, "po", `${lang}.po`), join(dir, `${lang}.po`));
    }

    withRetry(() => runPoUpdate({ lang, poDir: tsDir }));
    const reportOut = join(rustDir, "report.json");
    rust(["po_update", lang, "--po-dir", rustDir, "--json", reportOut]);

    const tsText = normalizeDates(readFileSync(join(tsDir, `${lang}.po`), "utf8"));
    const rustText = normalizeDates(readFileSync(join(rustDir, `${lang}.po`), "utf8"));
    assert.equal(rustText, tsText, `расхождение po_update на ${lang}`);

    // Отчёт обязан быть валидным JSON со всеми счётчиками (паритет не только
    // по байтам PO: выпавшие ключи должны быть посчитаны, а не потеряны).
    const report = JSON.parse(readFileSync(reportOut, "utf8")) as Record<string, number>;
    for (const field of [
      "carried",
      "new",
      "retargeted",
      "legacyKept",
      "dropped",
      "orphans",
      "dupKeys",
    ]) {
      assert.equal(typeof report[field], "number", `в отчёте нет ${field}`);
    }
    assert.ok(report.carried > 0 || lang !== "ru", `${lang}: ничего не перенесено`);
  });
}

/** Дата заголовка для паритета `prefill` (одна на обе реализации). */
const PREFILL_NOW = new Date(Date.UTC(2026, 0, 2, 3, 4));
const PREFILL_CREATED = "2026-01-02 03:04+0000";

/** Все языки: `prefill` (без корпуса — `translations/` в репе нет). */
for (const lang of LANGS) {
  test(`паритет prefill на ${lang}: <lang>.po байт-в-байт`, { skip }, () => {
    const tsDir = join(tmp, `prefill-ts-${lang}`, "po");
    const rustDir = join(tmp, `prefill-rust-${lang}`, "po");
    for (const dir of [tsDir, rustDir]) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(REPO, "po", "template.pot"), join(dir, "template.pot"));
      copyFileSync(join(REPO, "po", `${lang}.po`), join(dir, `${lang}.po`));
      copyFileSync(join(REPO, "po", "autofill_blocklist.txt"), join(dir, "autofill_blocklist.txt"));
    }

    withRetry(() => runPrefill({ lang, poDir: tsDir, now: PREFILL_NOW }));
    rust(["prefill", lang, "--po-dir", rustDir, "--created", PREFILL_CREATED]);

    assert.equal(
      readFileSync(join(rustDir, `${lang}.po`), "utf8"),
      readFileSync(join(tsDir, `${lang}.po`), "utf8"),
      `расхождение prefill на ${lang}`,
    );
  });
}

/** Мини-корпус: exact, fuzzy, auto-normalized, conflict, skip, blocklist, orphans. */
test("паритет prefill на синтетическом YAML-корпусе", { skip }, () => {
  const corpusDir = join(tmp, "prefill-corpus", "translations");
  const corpus: Record<string, string> = {
    "dialogues/a.yaml":
      '- text: "Hi"\n  translation: "Привет"\n  speaker: "Zoey"\n' +
      '- text: "Aw, ...!"\n  translation: "Оу..."\n' +
      '- text: "Skip"\n  translation: "Скип"\n  skip_translation: true\n' +
      '- text: "Conflict"\n  translation: "Раз"\n  speaker: "Zoey"\n' +
      '- text: "Conflict"\n  translation: "Два"\n  speaker: "Zoey"\n' +
      '- text: "Orphan"\n  translation: "Сирота"\n',
    "settings/s.yaml": '- text: "Settings"\n  translation: "Настройки"\n',
    "raw/r.yaml": '- text: "Raw"\n  translation: "Сырое"\n',
    "speakers.yaml": '- text: "Zoey"\n  translation: "Зои"\n',
  };
  for (const [rel, body] of Object.entries(corpus)) {
    const path = join(corpusDir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
  }

  const pot = [
    'msgid ""',
    'msgstr ""',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    "",
    'msgctxt "speaker:Zoey"',
    'msgid "Hi"',
    'msgstr ""',
    "",
    'msgctxt "ui"',
    'msgid "000 Aw ... 2"',
    'msgstr ""',
    "",
    'msgctxt "speaker:Zoey"',
    'msgid "Conflict"',
    'msgstr ""',
    "",
    'msgctxt "ui"',
    'msgid "Settings"',
    'msgstr ""',
    "",
    'msgctxt "ui"',
    'msgid "Raw"',
    'msgstr ""',
    "",
    'msgctxt "speaker-name"',
    'msgid "Zoey"',
    'msgstr ""',
    "",
    'msgctxt "ui"',
    'msgid "Missing"',
    'msgstr ""',
    "",
  ].join("\n");

  const dirs = ["ts", "rust"].map((side) => {
    const dir = join(tmp, `prefill-corpus-${side}`, "po");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "template.pot"), pot, "utf8");
    writeFileSync(join(dir, "autofill_blocklist.txt"), "# header\ndildo # marker\n", "utf8");
    return dir;
  });

  withRetry(() => runPrefill({ lang: "ru", poDir: dirs[0], corpusDir, now: PREFILL_NOW }));
  rust(["prefill", "ru", "--po-dir", dirs[1], "--corpus", corpusDir, "--created", PREFILL_CREATED]);

  const text = readFileSync(join(dirs[1], "ru.po"), "utf8");
  assert.equal(text, readFileSync(join(dirs[0], "ru.po"), "utf8"));
  assert.ok(text.includes('msgstr "Привет"'), "exact");
  assert.ok(text.includes('msgstr "Оу..."'), "auto-normalized");
  assert.ok(text.includes('msgstr "Настройки"'), "settings");
  assert.ok(text.includes('msgstr "Зои"'), "speaker-name");
});

/** Фикстура без игры: тот же дамп, что у TS-тестов find_source. */
test("паритет find_source на мини-дампе: вывод байт-в-байт", { skip }, async () => {
  const tiny = join(REPO, ".opencode", "skills", "extract-text", "test_data", "tiny-dump");
  for (const query of [
    "Where are you going now, my dear friend?",
    "New Game",
    "Zoey",
    "Welcome back, Sarah.",
  ]) {
    const run = spawnSync(bin as string, ["find_source", query, "--dump", tiny], {
      encoding: "utf8",
    });
    const expected = (await findSource(query, { dumpDir: tiny })).map(fmtSource).join("\n");
    assert.equal(run.status, 0, `rust-l10n find_source ${query}: ${run.stderr}`);
    assert.equal(run.stdout.replace(/\r\n/g, "\n"), `${expected}\n`, `расхождение на «${query}»`);
  }
});

// --- find_source на реальном дампе (нет дампа — тест пропускается) ---
test(
  "паритет find_source на реальном дампе: провенанс строки из POT",
  { skip: skip || dumpSkip },
  async () => {
    // Запрос берём из POT: это гарантированно существующая строка дампа.
    const msgs = readFileSync(join(REPO, "po", "template.pot"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith('msgid "') && line.length > 30);
    let query = "";
    let tsLines: string[] = [];
    for (const line of msgs.slice(0, 40)) {
      const candidate = JSON.parse(line.slice("msgid ".length)) as string;
      const hits = await findSource(candidate, { dumpDir, first: true });
      if (hits.length > 0) {
        query = candidate;
        tsLines = hits.map(fmtSource);
        break;
      }
    }
    assert.ok(query, "в дампе не нашлось ни одной строки из POT");

    const run = spawnSync(bin as string, ["find_source", query, "--first", "--dump", dumpDir], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      run.stdout.replace(/\r\n/g, "\n"),
      `${tsLines.join("\n")}\n`,
      `расхождение провенанса на «${query.slice(0, 40)}»`,
    );
  },
);
