/**
 * Тесты обёртки релиза: старый CLI принимается, но всё собирает новый
 * ручной путь (7z без скриптов). Реальная упаковка — в
 * `installer-ui/scripts/manual_e2e.mts` (нужен 7-Zip и payload).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as releaseModule from "./package_release.mts";
import { parseArgs, toManualArgs } from "./package_release.mts";

test("parseArgs: значения по умолчанию", () => {
  const args = parseArgs([]);
  assert.equal(args.version, null);
  assert.ok(args.out.endsWith("dist"));
  assert.equal(args.reuse, false);
  assert.deepEqual(args.ignored, []);
});

test("parseArgs: версия, каталог и повторное использование payload", () => {
  const args = parseArgs(["--version", "2026.11.25", "--out", "tmp/out", "--reuse"]);
  assert.equal(args.version, "2026.11.25");
  assert.ok(args.out.endsWith("out"));
  assert.equal(args.reuse, true);
});

test("parseArgs: старые --lang/--format принимаются, но игнорируются", () => {
  const args = parseArgs(["--lang", "ru", "--format", "zip"]);
  assert.equal(args.ignored.length, 2);
  assert.equal(args.version, null);
  assert.ok(!toManualArgs(args).includes("--lang"));
  assert.ok(!toManualArgs(args).includes("--format"));
});

test("parseArgs: неизвестная опция — ошибка", () => {
  assert.throws(() => parseArgs(["--nope"]), /неизвестная опция/);
});

test("toManualArgs: только новые ключи", () => {
  const argv = toManualArgs(parseArgs(["--version=1.2.3", "--out", "dist"]));
  assert.deepEqual(argv, ["--out", parseArgs(["--out", "dist"]).out, "--version", "1.2.3"]);
});

test("скриптового installScript больше нет", () => {
  assert.equal("installScript" in releaseModule, false);
  assert.equal("expectedEntries" in releaseModule, false);
  assert.equal(typeof releaseModule.release, "function");
});
