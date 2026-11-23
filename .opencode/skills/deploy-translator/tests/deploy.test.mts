/**
 * Тесты деплоя: план раскладки, native-режим `en`, атомарная запись, паритет
 * `.dat` с независимой сборкой `rust-l10n po2dat`, разбор CLI.
 *
 * Игра НЕ нужна: фейковая установка и фейковый репозиторий собираются во
 * временной папке `tmp/`. Реальный деплой проверяется вручную (см. SKILL.md).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { GAME_DATA_FOLDER } from "../../../../scripts/game_dir.mts";
import { l10nBinary } from "../../../../scripts/text_cli.mts";
import {
  CJK_FONTS,
  MAIN_FONT,
  copyAtomic,
  executeDeploy,
  parseArgs,
  planDeploy,
  writeAtomic,
} from "../scripts/deploy.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "deploy-test-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

const POT = `msgid ""
msgstr ""

#. rich_text: <color=#EB83FF>Yesss...!~</color>
msgid "Yesss...!~"
msgstr ""
`;

const RU_PO = `msgid ""
msgstr ""

msgid "Yesss...!~"
msgstr "Да-а-а...!~"

msgid "Dialogue Log"
msgstr "Журнал диалогов"
`;

/** Фейковая установка игры с маркерами. */
function fakeGame(name: string): string {
  const dir = join(root, name);
  const managed = join(dir, GAME_DATA_FOLDER, "Managed");
  mkdirSync(managed, { recursive: true });
  writeFileSync(join(dir, "Third Crisis Neon Nights.exe"), "");
  writeFileSync(join(managed, "Assembly-CSharp.dll"), "");
  return dir;
}

/** Фейковый репозиторий: артефакты сборки, шрифты, po, прокси. */
function fakeRepo(name: string, options: { proxy?: boolean; runtime?: boolean } = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "runtime"), { recursive: true });
  mkdirSync(join(dir, "fonts"), { recursive: true });
  mkdirSync(join(dir, "po"), { recursive: true });
  if (options.runtime !== false) {
    writeFileSync(join(dir, "runtime", "NeonTranslatorRuntime.dll"), "MZ fake runtime");
  }
  writeFileSync(join(dir, "fonts", MAIN_FONT), "ttf");
  for (const font of CJK_FONTS) writeFileSync(join(dir, "fonts", font), "ttf");
  writeFileSync(join(dir, "po", "template.pot"), POT);
  writeFileSync(join(dir, "po", "ru.po"), RU_PO);
  if (options.proxy !== false) writeFileSync(join(dir, "dwmapi.dll"), "MZ fake proxy");
  return dir;
}

test("parseArgs: значения по умолчанию и все опции", () => {
  assert.deepEqual(parseArgs([]), {
    lang: "ru",
    dryRun: false,
    rebuild: false,
    proxy: false,
    help: false,
  });
  assert.equal(parseArgs(["--lang", "de"]).lang, "de");
  assert.equal(parseArgs(["--lang=ja"]).lang, "ja");
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--rebuild", "--proxy"]).proxy, true);
  assert.throws(() => parseArgs(["--lang"]), /без значения/);
  assert.throws(() => parseArgs(["--nope"]), /неизвестная опция/);
});

test("planDeploy(ru): словарь из po/ru.po, прокси и active_lang в плане", () => {
  const game = fakeGame("plan-game");
  const repo = fakeRepo("plan-repo");
  const plan = planDeploy(game, "ru", repo);

  assert.equal(plan.native, false);
  assert.deepEqual(plan.missing, []);
  const kinds = plan.ops.map((o) => o.kind);
  assert.ok(kinds.includes("build-dat"));
  assert.ok(kinds.includes("write-active-lang"));

  const dat = plan.ops.find((o) => o.kind === "build-dat");
  assert.equal(dat?.from, join(repo, "po", "ru.po"));
  assert.equal(dat?.to, join(game, GAME_DATA_FOLDER, "Managed", "patch_ru.dat"));

  const proxy = plan.ops.find((o) => o.what.includes("dwmapi.dll"));
  assert.equal(proxy?.to, join(game, "dwmapi.dll"), "прокси — в корень игры, не в Managed");
});

test("planDeploy(en): native-режим без словаря", () => {
  const game = fakeGame("en-game");
  const repo = fakeRepo("en-repo");
  const plan = planDeploy(game, "en", repo);

  assert.equal(plan.native, true);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.ops.filter((o) => o.kind === "build-dat").length, 0, "словарь не собирается");
  assert.ok(plan.ops.some((o) => o.kind === "write-active-lang"));
});

test("planDeploy: нет sources — понятный список с подсказкой", () => {
  const game = fakeGame("miss-game");
  const repo = fakeRepo("miss-repo", { runtime: false, proxy: false });
  const plan = planDeploy(game, "ru", repo);

  assert.equal(plan.missing.length, 2);
  const text = plan.missing.join("\n");
  assert.match(text, /рантайм/);
  assert.match(text, /npm run build/);
  assert.match(text, /dwmapi\.dll/);
  assert.match(text, /npm run build:proxy/);
});

test("planDeploy: нет po/<lang>.po — подсказка, что язык не переведён", () => {
  const game = fakeGame("nopo-game");
  const repo = fakeRepo("nopo-repo");
  const plan = planDeploy(game, "de", repo);

  assert.equal(plan.missing.length, 1);
  assert.match(plan.missing[0], /po[\\/]de\.po/);
});

test("planDeploy: прокси нет в репо, но есть в игре — не missing, а предупреждение", () => {
  const game = fakeGame("proxy-game");
  const repo = fakeRepo("proxy-repo", { proxy: false });
  writeFileSync(join(game, "dwmapi.dll"), "MZ installed proxy");
  const plan = planDeploy(game, "ru", repo);

  assert.deepEqual(plan.missing, []);
  assert.ok(
    plan.warnings.some((w) => w.includes("build:proxy")),
    plan.warnings.join(" | "),
  );
  assert.equal(plan.ops.find((o) => o.what.includes("dwmapi.dll"))?.exists, false);
});

test("planDeploy: необязательный CJK-шрифт попадает в предупреждения, не в missing", () => {
  const game = fakeGame("cjk-game");
  const repo = fakeRepo("cjk-repo");
  rmSync(join(repo, "fonts", "NotoSansJP.ttf"));
  const plan = planDeploy(game, "ru", repo);

  assert.deepEqual(plan.missing, []);
  assert.ok(plan.warnings.some((w) => w.includes("NotoSansJP.ttf")));
});

test("planDeploy: не пишет в игру и в репо (dry-run-семантика)", () => {
  const game = fakeGame("dry-game");
  const repo = fakeRepo("dry-repo");
  planDeploy(game, "ru", repo);

  const managed = join(game, GAME_DATA_FOLDER, "Managed");
  assert.deepEqual(
    readdirSafe(managed).sort(),
    ["Assembly-CSharp.dll"],
    "в Managed/ ничего не появилось",
  );
  assert.equal(existsSync(join(repo, "runtime", "patch_ru.dat")), false);
});

test("executeDeploy(ru): DLL, шрифты, словарь, active_lang на месте; .part не остаётся", () => {
  const game = fakeGame("exec-game");
  const repo = fakeRepo("exec-repo");
  const plan = planDeploy(game, "ru", repo);
  const result = executeDeploy(plan, repo);
  const managed = plan.managed;

  for (const name of [
    "NeonTranslatorRuntime.dll",
    MAIN_FONT,
    ...CJK_FONTS,
    "patch_ru.dat",
    "active_lang.txt",
  ]) {
    assert.ok(existsSync(join(managed, name)), `${name} в Managed/`);
  }
  assert.equal(readFileSync(join(managed, "active_lang.txt"), "utf8"), "ru", "без перевода строки");
  assert.equal(result.dat?.rows, 2);
  assert.ok(existsSync(join(game, "dwmapi.dll")), "прокси в корне игры");
  assert.deepEqual(result.copied.length, plan.ops.length, "все операции выполнены");
  assert.deepEqual(
    readdirSafe(managed).filter((f) => f.endsWith(".part")),
    [],
    "атомарная запись не оставляет .part",
  );
});

test("executeDeploy(ru): .dat байт-в-байт равен независимой сборке rust-l10n", (t) => {
  const bin = l10nBinary();
  if (!bin) {
    t.skip("rust-l10n не собран (npm run l10n:build)");
    return;
  }
  const game = fakeGame("parity-game");
  const repo = fakeRepo("parity-repo");
  executeDeploy(planDeploy(game, "ru", repo), repo);

  const installed = readFileSync(join(game, GAME_DATA_FOLDER, "Managed", "patch_ru.dat"));
  const staged = readFileSync(join(repo, "runtime", "patch_ru.dat"));

  // Независимая сборка тем же Rust-компилятором, но отдельным процессом.
  const reference = join(repo, "reference.dat");
  const run = spawnSync(bin, ["po2dat", "ru", "--root", repo, "--out", reference], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);

  assert.deepEqual(installed, staged, "Managed/ = staging из deploy");
  assert.deepEqual(installed, readFileSync(reference), "Managed/ = сборка rust-l10n po2dat");
});

test("executeDeploy(en): словарь не кладётся, старый patch_en.dat не удаляется", () => {
  const game = fakeGame("en-exec-game");
  const repo = fakeRepo("en-exec-repo");
  const plan = planDeploy(game, "en", repo);
  const managed = plan.managed;
  const stale = join(managed, "patch_en.dat");
  writeFileSync(stale, "OLD");

  const result = executeDeploy(plan, repo);
  assert.equal(readFileSync(join(managed, "active_lang.txt"), "utf8"), "en");
  assert.equal(existsSync(join(managed, "patch_ru.dat")), false);
  assert.equal(readFileSync(stale, "utf8"), "OLD", "чужой/старый файл не тронут");
  assert.equal(result.dat, null);
});

test("executeDeploy: неполный план — отказ до первой записи", () => {
  const game = fakeGame("refuse-game");
  const repo = fakeRepo("refuse-repo", { runtime: false });
  const plan = planDeploy(game, "ru", repo);

  assert.throws(() => executeDeploy(plan, repo), /деплой невозможен/);
  assert.deepEqual(readdirSafe(plan.managed).sort(), ["Assembly-CSharp.dll"]);
});

test("writeAtomic / copyAtomic: .part → rename, вложенные каталоги создаются", () => {
  const dir = join(root, "atomic");
  writeAtomic(join(dir, "deep", "a.txt"), "hi");
  assert.equal(readFileSync(join(dir, "deep", "a.txt"), "utf8"), "hi");
  assert.equal(existsSync(join(dir, "deep", "a.txt.part")), false);

  copyAtomic(join(dir, "deep", "a.txt"), join(dir, "b.txt"));
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "hi");

  assert.throws(() => copyAtomic(join(dir, "nope.txt"), join(dir, "c.txt")), /нет источника/);
});

/** Содержимое каталога (пустой список, если его нет). */
function readdirSafe(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
