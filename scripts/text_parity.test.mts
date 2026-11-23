/**
 * text_parity.test.mts — паритет Rust-генераторов против TS-эталонов.
 *
 * Гейт миграции (`tasks/2026-11-22-rust-text-core.md`, `docs/language-audit.md`):
 *   - `potgen`: POT байт-в-байт с `potgen.mts` (даты фиксируются `--created`);
 *   - `po_update`: `<lang>.po` байт-в-байт с `po_update.mts` на всех 10 языках
 *     (`tasks/2026-11-22-rust-po-update.md`). Работа — на копиях в `tmp/`,
 *     `po/` не перезаписывается.
 *
 * `po2dat`, `prefill` и `find_source` из паритета выведены: TS-эталоны удалены
 * после доказанной миграции (правило — `docs/rust-vs-ts.md`), их поведение
 * стерегут тесты Rust (`tools/rust-l10n/tests/`) и слепки в
 * `scripts/text_golden.test.mts`.
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

import { newEntry, renderPo } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import { runPotgen } from "../.opencode/skills/extract-text/scripts/potgen.mts";
import { runPoUpdate } from "../.opencode/skills/extract-text/scripts/po_update.mts";

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

/** Все языки репозитория (порядок — как в `po/`). */
const LANGS = ["de", "es", "fr", "it", "ja", "ko", "pl", "pt", "ru", "zh"];

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

/** `#, skip` в POT: TS и Rust одинаково не создают пустых строк в PO. */
test("паритет po_update с `#, skip`: PO и счётчики совпадают", { skip }, () => {
  const makeEntry = (id: string, str = "", ctxt = "ui"): ReturnType<typeof newEntry> => {
    const e = newEntry();
    e.msgid = id;
    e.msgctxt = ctxt;
    e.msgstr = str;
    return e;
  };
  const potEntries = [
    makeEntry("junk-empty"),
    makeEntry("Normal line"),
    { ...makeEntry("junk-translated"), flags: ["skip"] },
  ];
  potEntries[0].flags = ["skip"];

  const dirs = ["ts", "rust"].map((side) => {
    const dir = join(tmp, `po-update-skip-${side}`, "po");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "template.pot"),
      renderPo(potEntries, ['msgid ""', 'msgstr ""']),
      "utf8",
    );
    writeFileSync(
      join(dir, "ru.po"),
      renderPo([makeEntry("junk-translated", "уже есть")], ['msgid ""', 'msgstr ""']),
      "utf8",
    );
    return dir;
  });

  const res = runPoUpdate({ lang: "ru", poDir: dirs[0] });
  const report = join(dirs[1], "report.json");
  rust(["po_update", "ru", "--po-dir", dirs[1], "--json", report]);

  assert.equal(
    readFileSync(join(dirs[1], "ru.po"), "utf8"),
    readFileSync(join(dirs[0], "ru.po"), "utf8"),
    "PO с skip байт-в-байт",
  );
  const text = readFileSync(join(dirs[0], "ru.po"), "utf8");
  assert.ok(!text.includes("junk-empty"), "пустая skip-строка не заведена");
  assert.ok(!text.includes("junk-translated"), "переведённая skip-строка тоже не заведена");
  assert.ok(!/#, skip/.test(text), "ни одной skip-метки в PO");
  assert.equal(res.stats.skipped, 2, "обе skip-записи POT пропущены");
  assert.equal(res.stats.skipDropped, 0, "их ключи есть в POT — хвостом ничего не шло");

  const stats = JSON.parse(readFileSync(report, "utf8")) as Record<string, number>;
  assert.equal(stats.skipped, 2, "Rust: skipped");
  assert.equal(stats.skipDropped, 0, "Rust: skipDropped");
});
