/**
 * Тесты деплоя: раскладка «одна папка» NeonTranslatorDX, манифест, uninstall,
 * migrate, native-режим `en`, атомарная запись, паритет `.dat` с независимой
 * сборкой `rust-l10n po2dat`, разбор CLI.
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
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

import { GAME_DATA_FOLDER } from "../../../../scripts/game_dir.mts";
import { l10nBinary } from "../../../../scripts/text_cli.mts";
import {
  CJK_FONTS,
  LEGACY_MOD_FOLDER,
  MAIN_FONT,
  MANIFEST_NAME,
  MOD_FOLDER,
  RUNTIME_DLL,
  copyAtomic,
  executeDeploy,
  executeMigrate,
  executeUninstall,
  parseArgs,
  planDeploy,
  planMigrate,
  planUninstall,
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
function fakeRepo(
  name: string,
  options: { proxy?: boolean; runtime?: boolean; real?: boolean } = {},
): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "runtime"), { recursive: true });
  mkdirSync(join(dir, "fonts"), { recursive: true });
  mkdirSync(join(dir, "po"), { recursive: true });
  if (options.runtime !== false) {
    writeFileSync(join(dir, "runtime", RUNTIME_DLL), "MZ fake runtime");
  }
  writeFileSync(join(dir, "fonts", MAIN_FONT), "ttf");
  for (const font of CJK_FONTS) writeFileSync(join(dir, "fonts", font), "ttf");
  writeFileSync(join(dir, "po", "template.pot"), POT);
  writeFileSync(join(dir, "po", "ru.po"), RU_PO);
  if (options.proxy !== false) writeFileSync(join(dir, "dwmapi.dll"), "MZ fake proxy");
  if (options.real) writeFileSync(join(dir, "dwmapi_real.dll"), "MZ fake real");
  return dir;
}

/** Все файлы установки относительно корня игры (для проверки «до/после»). */
function snapshot(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) snapshot(path, base, out);
    else out.push(relative(base, path).replaceAll("\\", "/"));
  }
  return out.sort();
}

test("parseArgs: значения по умолчанию и все опции", () => {
  assert.deepEqual(parseArgs([]), {
    lang: "ru",
    dryRun: false,
    rebuild: false,
    proxy: false,
    uninstall: false,
    migrate: false,
    help: false,
  });
  assert.equal(parseArgs(["--lang", "de"]).lang, "de");
  assert.equal(parseArgs(["--lang=ja"]).lang, "ja");
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--rebuild", "--proxy"]).proxy, true);
  assert.equal(parseArgs(["--uninstall"]).uninstall, true);
  assert.equal(parseArgs(["--migrate"]).migrate, true);
  assert.throws(() => parseArgs(["--lang"]), /без значения/);
  assert.throws(() => parseArgs(["--nope"]), /неизвестная опция/);
});

test("planDeploy(ru): всё в NeonTranslatorDX, прокси — в корень", () => {
  const game = fakeGame("plan-game");
  const repo = fakeRepo("plan-repo");
  const plan = planDeploy(game, "ru", repo);

  assert.equal(plan.native, false);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.modDir, join(game, MOD_FOLDER));
  const kinds = plan.ops.map((o) => o.kind);
  assert.ok(kinds.includes("build-dat"));
  assert.ok(kinds.includes("write-active-lang"));
  assert.ok(kinds.includes("write-manifest"));

  const runtime = plan.ops.find((o) => o.what.includes("рантайм"));
  assert.equal(runtime?.to, join(game, MOD_FOLDER, RUNTIME_DLL));

  const dat = plan.ops.find((o) => o.kind === "build-dat");
  assert.equal(dat?.from, join(repo, "po", "ru.po"));
  assert.equal(dat?.to, join(game, MOD_FOLDER, "patch_ru.dat"));

  const font = plan.ops.find((o) => o.what.includes(MAIN_FONT));
  assert.equal(font?.to, join(game, MOD_FOLDER, "fonts", MAIN_FONT));

  const proxy = plan.ops.find((o) => o.what.includes("dwmapi.dll"));
  assert.equal(proxy?.to, join(game, "dwmapi.dll"), "прокси — в корень игры");

  const manifest = plan.ops.find((o) => o.kind === "write-manifest");
  assert.equal(manifest?.to, join(game, MOD_FOLDER, MANIFEST_NAME));
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

test("planDeploy: прокси без строки NeonTranslatorDX — предупреждение о пересборке", () => {
  const game = fakeGame("stale-proxy-game");
  const repo = fakeRepo("stale-proxy-repo");
  const plan = planDeploy(game, "ru", repo);
  assert.ok(
    plan.warnings.some((w) => w.includes("прежнюю раскладку")),
    plan.warnings.join(" | "),
  );

  writeFileSync(join(repo, "dwmapi.dll"), "MZ NeonTranslatorDX proxy");
  const fresh = planDeploy(game, "ru", repo);
  assert.ok(!fresh.warnings.some((w) => w.includes("прежнюю раскладку")));
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
  assert.deepEqual(readdirSafe(join(game, MOD_FOLDER)), [], "папки мода ещё нет");
  assert.equal(existsSync(join(repo, "runtime", "patch_ru.dat")), false);
});

test("executeDeploy(ru): новая раскладка + манифест; в Managed наших файлов нет", () => {
  const game = fakeGame("exec-game");
  const repo = fakeRepo("exec-repo", { real: true });
  const plan = planDeploy(game, "ru", repo);
  const result = executeDeploy(plan, repo);
  const mod = plan.modDir;

  for (const name of [RUNTIME_DLL, "patch_ru.dat", "active_lang.txt", MANIFEST_NAME]) {
    assert.ok(existsSync(join(mod, name)), `${name} в ${MOD_FOLDER}/`);
  }
  for (const name of [MAIN_FONT, ...CJK_FONTS]) {
    assert.ok(existsSync(join(mod, "fonts", name)), `fonts/${name}`);
  }
  assert.equal(readFileSync(join(mod, "active_lang.txt"), "utf8"), "ru", "без перевода строки");
  assert.equal(result.dat?.rows, 2);
  assert.ok(existsSync(join(game, "dwmapi.dll")), "прокси в корне игры");
  assert.ok(existsSync(join(mod, "dwmapi_real.dll")), "dwmapi_real внутри папки мода");
  assert.deepEqual(result.copied.length, plan.ops.length, "все операции выполнены");
  assert.deepEqual(
    readdirSafe(mod).filter((f) => f.endsWith(".part")),
    [],
    "атомарная запись не оставляет .part",
  );

  // Приёмка «в Managed не появилось наших файлов».
  assert.deepEqual(
    readdirSafe(join(game, GAME_DATA_FOLDER, "Managed")).sort(),
    ["Assembly-CSharp.dll"],
    "Managed/ остался исходным",
  );

  // Манифест перечисляет ровно поставленное (с размером и sha256).
  const manifest = JSON.parse(readFileSync(join(mod, MANIFEST_NAME), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.lang, "ru");
  const paths = manifest.files.map((f: { path: string }) => f.path);
  assert.ok(paths.includes("dwmapi.dll"));
  assert.ok(paths.includes(`${MOD_FOLDER}/${RUNTIME_DLL}`));
  assert.ok(paths.includes(`${MOD_FOLDER}/fonts/${MAIN_FONT}`));
  assert.ok(paths.includes(`${MOD_FOLDER}/patch_ru.dat`));
  assert.ok(paths.includes(`${MOD_FOLDER}/active_lang.txt`));
  for (const file of manifest.files) {
    assert.ok(file.size > 0, `${file.path}: размер > 0`);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
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

  const installed = readFileSync(join(game, MOD_FOLDER, "patch_ru.dat"));
  const staged = readFileSync(join(repo, "runtime", "patch_ru.dat"));

  const reference = join(repo, "reference.dat");
  const run = spawnSync(bin, ["po2dat", "ru", "--root", repo, "--out", reference], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);

  assert.deepEqual(installed, staged, "mod folder = staging из deploy");
  assert.deepEqual(installed, readFileSync(reference), "mod folder = сборка rust-l10n po2dat");
});

test("executeDeploy(en): словарь не кладётся", () => {
  const game = fakeGame("en-exec-game");
  const repo = fakeRepo("en-exec-repo");
  const plan = planDeploy(game, "en", repo);
  const mod = plan.modDir;

  const result = executeDeploy(plan, repo);
  assert.equal(readFileSync(join(mod, "active_lang.txt"), "utf8"), "en");
  assert.equal(existsSync(join(mod, "patch_ru.dat")), false);
  assert.equal(result.dat, null);
});

test("executeDeploy: неполный план — отказ до первой записи", () => {
  const game = fakeGame("refuse-game");
  const repo = fakeRepo("refuse-repo", { runtime: false });
  const plan = planDeploy(game, "ru", repo);

  assert.throws(() => executeDeploy(plan, repo), /деплой невозможен/);
  assert.deepEqual(readdirSafe(join(game, GAME_DATA_FOLDER, "Managed")).sort(), [
    "Assembly-CSharp.dll",
  ]);
  assert.deepEqual(readdirSafe(plan.modDir), []);
});

test("uninstall: в игре остаются ровно исходные файлы, папка мода исчезает", () => {
  const game = fakeGame("unin-game");
  const repo = fakeRepo("unin-repo");
  const original = snapshot(game);

  const result = executeDeploy(planDeploy(game, "ru", repo), repo);
  assert.ok(result.copied.length > 0);
  assert.ok(snapshot(game).length > original.length, "файлы появились");

  const plan = planUninstall(game);
  assert.equal(plan.error, null);
  assert.equal(plan.targets.length, result.manifest.files.length);
  const removed = executeUninstall(plan);

  assert.deepEqual(snapshot(game), original, "после uninstall — только исходные файлы");
  assert.equal(existsSync(join(game, MOD_FOLDER)), false, "папка мода удалена");
  assert.equal(existsSync(join(game, "dwmapi.dll")), false, "лоадер удалён");
  assert.equal(removed.manifestDeleted, true);
  assert.ok(removed.removedDirs.length >= 2, "удалены fonts/ и папка мода");
});

test("uninstall: чужие файлы не трогает (в Managed и в папке мода)", () => {
  const game = fakeGame("unin-foreign");
  const repo = fakeRepo("unin-foreign-repo");
  executeDeploy(planDeploy(game, "ru", repo), repo);

  const foreignManaged = join(game, GAME_DATA_FOLDER, "Managed", "user-mod.dll");
  const foreignMod = join(game, MOD_FOLDER, "user-note.txt");
  writeFileSync(foreignManaged, "user");
  writeFileSync(foreignMod, "user");

  executeUninstall(planUninstall(game));

  assert.ok(existsSync(foreignManaged), "чужой файл в Managed сохранён");
  assert.ok(existsSync(foreignMod), "чужой файл в папке мода сохранён");
  assert.equal(existsSync(join(game, MOD_FOLDER, RUNTIME_DLL)), false);
  assert.equal(existsSync(join(game, MOD_FOLDER)), true, "непустая папка осталась");
});

test("uninstall: изменённый вручную файл остаётся (хэш не совпал)", () => {
  const game = fakeGame("unin-modified");
  const repo = fakeRepo("unin-modified-repo");
  executeDeploy(planDeploy(game, "ru", repo), repo);

  const runtime = join(game, MOD_FOLDER, RUNTIME_DLL);
  writeFileSync(runtime, "patched by user");

  const plan = planUninstall(game);
  assert.ok(plan.warnings.some((w) => w.includes("изменён")));
  const result = executeUninstall(plan);
  assert.ok(existsSync(runtime), "изменённый файл не удалён");
  assert.ok(result.kept.some((p) => p.endsWith(RUNTIME_DLL)));
});

test("uninstall: удаляет журнал и дамп рантайма, папка опустевает", () => {
  const game = fakeGame("unin-runtime-artifacts");
  const repo = fakeRepo("unin-runtime-artifacts-repo");
  executeDeploy(planDeploy(game, "ru", repo), repo);

  writeFileSync(join(game, MOD_FOLDER, "NeonTranslatorDX.log"), "log");
  writeFileSync(join(game, MOD_FOLDER, "dump_GUIDictionary.json"), "{}");

  const plan = planUninstall(game);
  assert.ok(plan.targets.some((t) => t.path.endsWith("NeonTranslatorDX.log")));
  executeUninstall(plan);

  assert.equal(existsSync(join(game, MOD_FOLDER)), false, "папка мода удалена");
});

test("uninstall: словари других языков тоже удаляются (смена языка после установки)", () => {
  const game = fakeGame("unin-multilang");
  const repo = fakeRepo("unin-multilang-repo");
  writeFileSync(join(repo, "po", "de.po"), RU_PO);

  executeDeploy(planDeploy(game, "ru", repo), repo);
  executeDeploy(planDeploy(game, "de", repo), repo);
  assert.ok(existsSync(join(game, MOD_FOLDER, "patch_ru.dat")));
  assert.ok(existsSync(join(game, MOD_FOLDER, "patch_de.dat")));

  executeUninstall(planUninstall(game));
  assert.equal(existsSync(join(game, MOD_FOLDER)), false, "папка мода удалена целиком");
});

test("uninstall без манифеста: отказ, ничего не удаляет", () => {
  const game = fakeGame("unin-nomanifest");
  const plan = planUninstall(game);
  assert.match(plan.error ?? "", /манифест не найден/);
  assert.throws(() => executeUninstall(plan), /удаление невозможно/);
  assert.ok(existsSync(join(game, "Third Crisis Neon Nights.exe")));
});

test("migrate: старая раскладка (Managed + NeonTranslator/) удаляется по списку", () => {
  const game = fakeGame("migrate-game");
  const repo = fakeRepo("migrate-repo");
  const managed = join(game, GAME_DATA_FOLDER, "Managed");
  const oldMod = join(game, LEGACY_MOD_FOLDER);

  // Имитация прежней установки: файлы в Managed + старая папка.
  writeFileSync(join(managed, "NeonTranslatorRuntime.dll"), "old");
  writeFileSync(join(managed, "NeonTranslator.log"), "old");
  writeFileSync(join(managed, "patch_ru.dat"), "old");
  mkdirSync(join(oldMod, "fonts"), { recursive: true });
  writeFileSync(join(oldMod, "NeonTranslatorRuntime.dll"), "old");
  writeFileSync(join(oldMod, "patch_ru.dat"), "old");
  writeFileSync(join(oldMod, "fonts", MAIN_FONT), "old");

  const plan = planDeploy(game, "ru", repo);
  assert.ok(
    plan.warnings.some((w) => w.includes("--migrate")),
    "без флага план только предупреждает",
  );

  executeDeploy(plan, repo);
  const legacy = planMigrate(game);
  assert.ok(legacy.length >= 6, `найдено ${legacy.length}`);
  const moved = executeMigrate(legacy, game);

  assert.equal(moved.failed.length, 0);
  for (const name of ["NeonTranslatorRuntime.dll", "NeonTranslator.log", "patch_ru.dat"]) {
    assert.equal(existsSync(join(managed, name)), false, `${name} удалён из Managed`);
  }
  assert.equal(existsSync(oldMod), false, "старая папка удалена (опустела)");
  assert.deepEqual(
    readdirSafe(managed).sort(),
    ["Assembly-CSharp.dll"],
    "в Managed не осталось наших файлов",
  );
  assert.ok(existsSync(join(game, MOD_FOLDER, RUNTIME_DLL)), "новая установка на месте");
});

test("migrate: чужой файл в старой папке сохраняет её", () => {
  const game = fakeGame("migrate-foreign");
  const repo = fakeRepo("migrate-foreign-repo");
  const oldMod = join(game, LEGACY_MOD_FOLDER);
  mkdirSync(oldMod, { recursive: true });
  writeFileSync(join(oldMod, "NeonTranslatorRuntime.dll"), "old");
  writeFileSync(join(oldMod, "keep-me.txt"), "user");

  executeDeploy(planDeploy(game, "ru", repo), repo);
  executeMigrate(planMigrate(game), game);

  assert.equal(existsSync(join(oldMod, "NeonTranslatorRuntime.dll")), false);
  assert.ok(existsSync(join(oldMod, "keep-me.txt")), "чужой файл сохранён");
  assert.ok(existsSync(oldMod), "непустая папка не удалена");
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
