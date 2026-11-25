/**
 * Тесты упаковки релиза: аргументы, контракт файлов, проверка источников.
 * Реальная архивация — интеграционно (нужен 7-Zip и собранные артефакты).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  expectedEntries,
  installScript,
  listFiles,
  parseArgs,
  planSources,
  validateSources,
} from "./package_release.mts";

const REPO = resolve(import.meta.dirname, "..");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "rel-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

test("parseArgs: значения по умолчанию", () => {
  assert.deepEqual(parseArgs([]), { lang: "ru", version: "1.0", format: "zip", out: "dist" });
});

test("parseArgs: язык, версия, формат, каталог", () => {
  const a = parseArgs(["--lang", "de", "--version", "2.5", "--format", "7z", "--out", "out"]);
  assert.equal(a.lang, "de");
  assert.equal(a.version, "2.5");
  assert.equal(a.format, "7z");
  assert.equal(a.out, "out");
});

test("parseArgs: неизвестный формат — ошибка", () => {
  assert.throws(() => parseArgs(["--format", "rar"]), /zip\|7z/);
});

test("parseArgs: неизвестная опция — ошибка", () => {
  assert.throws(() => parseArgs(["--nope"]), /неизвестная опция/);
});

test("контракт: ожидаемые файлы зависят от языка", () => {
  const ru = expectedEntries("ru");
  const de = expectedEntries("de");
  assert.ok(ru.includes("NeonTranslatorDX/patch_ru.dat"));
  assert.ok(de.includes("NeonTranslatorDX/patch_de.dat"));
  assert.ok(!de.includes("NeonTranslatorDX/patch_ru.dat"));
  assert.ok(ru.includes("NeonTranslatorDX/NeonTranslatorDX.dll"));
  assert.equal(ru.length, 6);
});

test("planSources: раскладка повторяет контракт", () => {
  const plan = planSources("ru");
  assert.deepEqual(
    plan.map((p) => p.to).sort(),
    expectedEntries("ru")
      .filter((e) => e !== "install.ps1")
      .sort(),
  );
});

test("validateSources: полный набор — проблем нет", () => {
  const dir = join(root, "full");
  for (const { from } of planSources("ru")) {
    const p = join(dir, from);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x");
  }
  assert.deepEqual(validateSources(dir, "ru"), []);
});

test("validateSources: отсутствующий и пустой файл ловятся", () => {
  const dir = join(root, "broken");
  mkdirSync(join(dir, "fonts"), { recursive: true });
  writeFileSync(join(dir, "dwmapi.dll"), "");
  const problems = validateSources(dir, "ru");
  assert.ok(problems.some((p) => p.includes("пустой файл: dwmapi.dll")));
  assert.ok(problems.some((p) => p.includes("нет файла: runtime/patch_ru.dat")));
});

test("listFiles: рекурсивно, с '/' в путях, отсортировано", () => {
  const dir = join(root, "tree");
  mkdirSync(join(dir, "runtime"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "x");
  writeFileSync(join(dir, "runtime", "b.dat"), "x");
  assert.deepEqual(listFiles(dir), ["a.txt", "runtime/b.dat"]);
});

test("installScript: подставляет язык и пишет LF, без CRLF", () => {
  const s = installScript("de");
  assert.ok(s.includes("$LANG = 'de'"));
  assert.ok(!s.includes("\r"), "в скрипте не должно быть CRLF");
  assert.ok(s.includes("active_lang.txt"));
});
