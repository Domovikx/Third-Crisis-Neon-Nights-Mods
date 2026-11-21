/**
 * Тесты сборки: разбор/сборка аргументов csc и cl, выбор компилятора, ссылки
 * из `Managed/`, поиск MSVC/Windows SDK, разрешение пути к игре.
 *
 * Игра и компиляторы НЕ нужны: проверяются чистые функции на фейковых
 * каталогах в `tmp/`. Сами прогоны `csc.exe`/`cl.exe` — только локально
 * (см. SKILL.md и MAP.md).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  MIN_REFS,
  REF_DLLS,
  SOURCE_DIR,
  SOURCE_FILES,
  buildArgs,
  chooseCsc,
  collectRefs,
  cscCandidates,
  missingSources,
  resolveGame,
} from "../scripts/build.mts";
import {
  compareVersions,
  discoverMsvc,
  missingLayoutPaths,
  msvcLayout,
  pickLatestVersion,
  proxyArgs,
} from "../scripts/build_proxy.mts";
import { GAME_FOLDER, GAME_DATA_FOLDER, REQUIRED_MARKERS } from "../../../../scripts/game_dir.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "build-test-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Фейковая установка игры с маркерами и (опционально) сборками Unity. */
function fakeGame(name: string, options: { refs?: string[]; markers?: boolean } = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, GAME_DATA_FOLDER, "Managed"), { recursive: true });
  if (options.markers !== false) {
    for (const marker of REQUIRED_MARKERS) {
      const path = join(dir, marker);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "");
    }
  }
  for (const ref of options.refs ?? []) {
    writeFileSync(join(dir, GAME_DATA_FOLDER, "Managed", ref), "");
  }
  return dir;
}

test("cscCandidates: TCNN_CSC первым, иначе .NET Framework 4.x из WINDIR", () => {
  const candidates = cscCandidates({ WINDIR: "D:\\Win", TCNN_CSC: "E:\\csc.exe" });
  assert.equal(candidates[0], "E:\\csc.exe");
  assert.ok(candidates.some((p) => p.includes(join("Framework64", "v4.0.30319", "csc.exe"))));
  assert.ok(
    candidates.every((p) => !p.includes("C:\\Windows")),
    "WINDIR уважается",
  );
  assert.ok(cscCandidates({}).every((p) => p.includes("csc.exe")));
});

test("chooseCsc: первый существующий, иначе null", () => {
  const existing = new Set(["b", "c"]);
  assert.equal(
    chooseCsc(["a", "b", "c"], (p) => existing.has(p)),
    "b",
  );
  assert.equal(
    chooseCsc(["x", "y"], () => false),
    null,
  );
});

test("missingSources: пустой список, когда исходники на месте", () => {
  assert.deepEqual(missingSources(), [], "все SOURCE_FILES лежат в source/");
  assert.deepEqual(
    SOURCE_FILES.filter((f) => !existsSync(join(SOURCE_DIR, f))),
    [],
    "SOURCE_FILES совпадает с файлами на диске",
  );
});

test("missingSources: перечисляет отсутствующие исходники", () => {
  const dir = join(root, "empty-src");
  mkdirSync(dir, { recursive: true });
  const missing = missingSources(dir);
  assert.equal(missing.length, SOURCE_FILES.length);
});

test("collectRefs: только существующие DLL, отсутствующие — списком", () => {
  const game = fakeGame("refs-game", { refs: ["UnityEngine.dll", "netstandard.dll"] });
  const managed = join(game, GAME_DATA_FOLDER, "Managed");
  const { refs, missing } = collectRefs(managed);
  assert.deepEqual(
    refs.map((r) => r.split(/[\\/]/).at(-1)),
    ["UnityEngine.dll", "netstandard.dll"],
  );
  assert.equal(missing.length, REF_DLLS.length - 2);
  assert.ok(refs.length < MIN_REFS, "двух ссылок мало для порога");
});

test("buildArgs: цель, платформа, unsafe и все пути", () => {
  const args = buildArgs({
    outPath: "out.dll",
    refs: ["a.dll", "b.dll"],
    sources: ["s1.cs", "s2.cs"],
  });
  assert.deepEqual(args.slice(0, 5), [
    "/target:library",
    "/out:out.dll",
    "/platform:x64",
    "/unsafe",
    "/nologo",
  ]);
  assert.ok(args.includes("/r:a.dll") && args.includes("/r:b.dll"));
  assert.equal(args.at(-1), "s2.cs");
  assert.equal(args.filter((a) => a.startsWith("/r:")).length, 2);
});

test("resolveGame: несуществующий TCNN_GAME_DIR — ошибка, а не тихий автопоиск", () => {
  const bogus = join(root, "no-such-game");
  const game = resolveGame({ TCNN_GAME_DIR: bogus });
  assert.equal(game.dir, null);
  assert.ok(game.error?.includes("TCNN_GAME_DIR"), `ошибка называет env: ${game.error}`);
  assert.ok(game.error?.includes("no-such-game"));
});

test("resolveGame: полная фейковая установка принимается", () => {
  const dir = fakeGame("ok-game");
  const game = resolveGame({ TCNN_GAME_DIR: dir });
  assert.equal(game.error, null);
  assert.equal(game.dir, dir);
});

test("resolveGame: папка без маркеров — ошибка со списком отсутствующего", () => {
  const dir = join(root, "bare-game");
  mkdirSync(dir, { recursive: true });
  const game = resolveGame({ TCNN_GAME_DIR: dir });
  assert.equal(game.dir, dir);
  assert.ok(game.error?.includes(GAME_FOLDER) || game.error?.includes("Managed"));
  assert.equal(game.missing.length, REQUIRED_MARKERS.length);
});

test("compareVersions / pickLatestVersion: числовое сравнение, мусор отбрасывается", () => {
  assert.ok(compareVersions("14.50.35717", "14.44.1") > 0);
  assert.equal(compareVersions("10.0.26100.0", "10.0.26100.0"), 0);
  assert.equal(pickLatestVersion(["14.44.1", "14.50.35717", "latest", "14.4"]), "14.50.35717");
  assert.equal(pickLatestVersion([]), null);
  assert.equal(pickLatestVersion(["nope"]), null);
});

test("msvcLayout: include/lib по MSVC + версии Windows SDK", () => {
  const layout = msvcLayout("C:\\msvc", "C:\\kits", "10.0.26100.0");
  assert.equal(layout.cl, join("C:\\msvc", "bin", "Hostx64", "x64", "cl.exe"));
  assert.deepEqual(layout.includes, [
    join("C:\\msvc", "include"),
    join("C:\\kits", "Include", "10.0.26100.0", "shared"),
    join("C:\\kits", "Include", "10.0.26100.0", "um"),
    join("C:\\kits", "Include", "10.0.26100.0", "ucrt"),
  ]);
  assert.deepEqual(layout.libs, [
    join("C:\\msvc", "lib", "x64"),
    join("C:\\kits", "Lib", "10.0.26100.0", "ucrt", "x64"),
    join("C:\\kits", "Lib", "10.0.26100.0", "um", "x64"),
  ]);
});

test("proxyArgs: DLL, /MD, include/lib, kernel32", () => {
  const layout = msvcLayout("C:\\msvc", "C:\\kits", "10.0.1");
  const args = proxyArgs(layout, "src.c", "out.dll", "obj.obj");
  assert.equal(args[0], layout.cl);
  for (const flag of ["/LD", "/MD", "/O1", "/MACHINE:X64"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.includes("/Foobj.obj"));
  assert.ok(args.includes("/Feout.dll"));
  assert.equal(args.filter((a) => a.startsWith("/I")).length, layout.includes.length);
  assert.equal(args.filter((a) => a.startsWith("/LIBPATH:")).length, layout.libs.length);
  assert.equal(args.at(-1), "kernel32.lib");
});

test("discoverMsvc: оверрайды TCNN_MSVC_TOOLS и TCNN_WINDOWS_SDK", () => {
  const tools = join(root, "tools", "14.50.35717");
  const kits = join(root, "kits");
  for (const dir of [join(tools, "include"), join(tools, "lib", "x64")]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const dir of [
    join(kits, "Include", "10.0.26100.0", "shared"),
    join(kits, "Include", "10.0.26100.0", "um"),
    join(kits, "Include", "10.0.26100.0", "ucrt"),
    join(kits, "Lib", "10.0.26100.0", "ucrt", "x64"),
    join(kits, "Lib", "10.0.26100.0", "um", "x64"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  // Версия без Lib должна быть отброшена.
  mkdirSync(join(kits, "Include", "10.0.99999.0", "shared"), { recursive: true });

  const layout = discoverMsvc({ env: { TCNN_MSVC_TOOLS: tools, TCNN_WINDOWS_SDK: kits } });
  assert.equal(layout.cl, join(tools, "bin", "Hostx64", "x64", "cl.exe"));
  assert.ok(layout.includes.includes(join(kits, "Include", "10.0.26100.0", "ucrt")));
  assert.ok(!layout.includes.some((p) => p.includes("10.0.99999.0")), "SDK без Lib отброшен");

  const missing = missingLayoutPaths(layout);
  assert.deepEqual(missing, [layout.cl], "нет только cl.exe — его создаёт установка MSVC");
});

test("discoverMsvc: без MSVC и без vswhere — понятная ошибка", () => {
  const empty = join(root, "no-vs");
  mkdirSync(empty, { recursive: true });
  assert.throws(
    () => discoverMsvc({ env: { "ProgramFiles(x86)": empty }, vsRoots: [empty] }),
    /MSVC не найден/,
  );
});
