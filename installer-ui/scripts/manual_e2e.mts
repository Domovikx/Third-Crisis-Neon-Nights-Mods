/**
 * manual_e2e.mts — E2E ручного пути (без exe у игрока):
 *
 *   собрать .7z → распаковать в тестовую «игру» → проверить, что внутри нет
 *   .exe/.cmd/.ps1 → собрать тестовый harness из РЕАЛЬНОГО ModManifest.cs →
 *   рантайм создаёт install-manifest.json → менеджер `--verify` OK →
 *   «обновление распаковкой» (DLL заменена) → манифест пересобирается →
 *   `--uninstall` убирает папку мода и лоадер.
 *
 * Ничего не пишет в реальную игру: «игра» создаётся в installer-ui/tmp.
 *
 *   node installer-ui/scripts/manual_e2e.mts [--manager <exe>] [--keep]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";

import {
  FORBIDDEN_EXTENSIONS,
  buildArchive,
  forbiddenEntries,
  parseArgs as parseManualArgs,
} from "./build_manual_archive.mts";
import { DEFAULT_OUT as DEFAULT_PAYLOAD, find7z } from "./build_payload.mts";
import { cscCandidates } from "../../.opencode/skills/build-translator/scripts/build.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const SOURCE_DIR = join(REPO_ROOT, ".opencode", "skills", "build-translator", "source");
export const WORK = join(REPO_ROOT, "installer-ui", "tmp", "manual-e2e");

const PATCH_DEFAULT = "2026.11.25";

/** Все файлы дерева с `/` (для проверок состава). */
function listFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, base));
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join("/"));
  }
  return out.sort();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findManager(explicit: string | null): string {
  if (explicit) return resolve(explicit);
  for (const profile of ["debug", "release"]) {
    const path = join(REPO_ROOT, "installer-ui", "target", profile, "NeonTranslatorDXManager.exe");
    if (existsSync(path)) return path;
  }
  throw new Error("менеджер не собран: cargo build -p neon-translator-dx-manager");
}

function findCsc(): string {
  for (const candidate of cscCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("csc.exe не найден (нужен .NET Framework 4.x)");
}

function run(command: string, args: string[], cwd?: string): { status: number; out: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { status: result.status ?? -1, out };
}

function main(argv: string[]): number {
  let managerArg: string | null = null;
  let keep = false;
  let version = PATCH_DEFAULT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manager") managerArg = argv[++i] ?? null;
    else if (arg === "--version") version = argv[++i] ?? version;
    else if (arg === "--keep") keep = true;
    else throw new Error(`неизвестная опция: ${arg}`);
  }

  const manager = findManager(managerArg);
  const sevenZip = find7z();
  if (!sevenZip) throw new Error("нужен 7-Zip");
  const csc = findCsc();

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const game = join(WORK, "game");
  const data = join(game, "Third Crisis Neon Nights_Data", "Managed");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(game, "Third Crisis Neon Nights.exe"), "fake");
  writeFileSync(join(data, "Assembly-CSharp.dll"), "fake");

  // 1. Архив из того же payload, что у менеджера.
  const report = buildArchive(
    parseManualArgs([
      "--version",
      version,
      "--out",
      join(WORK, "dist"),
      "--payload",
      DEFAULT_PAYLOAD,
    ]),
  );
  const forbidden = forbiddenEntries(report.entries);
  if (forbidden.length) {
    throw new Error(`в архиве исполняемые файлы: ${forbidden.join(", ")}`);
  }
  for (const ext of FORBIDDEN_EXTENSIONS) {
    if (report.entries.some((entry) => entry.toLowerCase().endsWith(ext))) {
      throw new Error(`в архиве есть ${ext}`);
    }
  }
  console.log(`==> архив: ${report.entries.length} файлов, запрещённых типов нет`);

  // 2. Ручная установка = распаковка всего архива в папку игры.
  const unpack = run(sevenZip, ["x", report.archive, `-o${game}`, "-y"]);
  if (unpack.status !== 0) throw new Error(`7z x: ${unpack.out}`);
  const markers = new Set([
    "Third Crisis Neon Nights.exe",
    "Third Crisis Neon Nights_Data/Managed/Assembly-CSharp.dll",
  ]);
  const unpacked = listFiles(game)
    .filter((entry) => !markers.has(entry))
    .sort();
  const packed = [...report.entries].sort();
  if (JSON.stringify(packed) !== JSON.stringify(unpacked)) {
    throw new Error(
      `распаковка не совпала с архивом:\n  архив: ${packed.join(", ")}\n  диск: ${unpacked.join(", ")}`,
    );
  }
  if (unpacked.some((entry) => /\.(exe|cmd|ps1)$/i.test(entry))) {
    throw new Error("после распаковки появились исполняемые файлы");
  }
  console.log("==> распаковка: состав совпал, install.ps1/.cmd/.exe нет");

  // 3. Рантайм создаёт манифест (реальный ModManifest.cs).
  const harness = join(WORK, "ManifestHarness.exe");
  const compile = run(csc, [
    "/nologo",
    "/target:exe",
    `/out:${harness}`,
    join(SOURCE_DIR, "ModManifest.cs"),
    join(REPO_ROOT, "installer-ui", "scripts", "manifest_harness.cs"),
  ]);
  if (compile.status !== 0) throw new Error(`csc harness: ${compile.out}`);

  const modDir = join(game, "mods", "NeonTranslatorDX");
  const manifestPath = join(modDir, "install-manifest.json");
  if (existsSync(manifestPath)) throw new Error("манифест уже есть до запуска рантайма");
  const created = run(harness, [modDir, game]);
  if (created.status !== 0) throw new Error(`harness: ${created.out}`);
  if (!existsSync(manifestPath)) throw new Error("рантайм не создал манифест");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version: number;
    lang: string;
    files: Array<{ path: string; size: number; sha256: string }>;
  };
  const paths = manifest.files.map((file) => file.path);
  if (manifest.version !== 1) throw new Error("manifest.version != 1");
  if (!paths.includes("dwmapi.dll")) throw new Error("в манифесте нет dwmapi.dll");
  if (!paths.includes("mods/NeonTranslatorDX/NeonTranslatorDX.dll")) {
    throw new Error("в манифесте нет DLL");
  }
  if (paths.some((path) => path.includes("README") || path.startsWith("fomod/"))) {
    throw new Error("в манифест попали файлы архива (README/fomod)");
  }
  for (const file of manifest.files) {
    const abs = join(game, file.path.split("/").join(sep));
    if (!existsSync(abs)) throw new Error(`манифест ссылается на отсутствующий ${file.path}`);
    if (statSync(abs).size !== file.size) throw new Error(`размер не совпал: ${file.path}`);
    if (sha256(abs) !== file.sha256) throw new Error(`sha256 не совпал: ${file.path}`);
  }
  const active = readFileSync(join(modDir, "active_lang.txt"), "utf8").trim();
  if (manifest.lang !== active) throw new Error("lang в манифесте != active_lang.txt");
  console.log(
    `==> рантайм создал манифест: ${manifest.files.length} файлов, lang ${manifest.lang}`,
  );

  // 3b. Повторный запуск не переписывает актуальный манифест, а версию
  //     пакета, записанную менеджером, рантайм не стирает.
  const before = readFileSync(manifestPath, "utf8");
  const upToDate = run(harness, [modDir, game]);
  if (!/up to date/.test(upToDate.out)) {
    throw new Error(`повторный запуск переписал манифест: ${upToDate.out}`);
  }
  if (readFileSync(manifestPath, "utf8") !== before) {
    throw new Error("манифест изменился без причины");
  }
  const withVersion = before.replace(
    '"version": 1,',
    `"version": 1,\n  "payloadVersion": "2026.11.25",`,
  );
  writeFileSync(manifestPath, withVersion, "utf8");
  const managerManifest = readFileSync(manifestPath, "utf8");
  if (!/up to date/.test(run(harness, [modDir, game]).out)) {
    throw new Error("рантайм не распознал манифест менеджера");
  }
  if (readFileSync(manifestPath, "utf8") !== managerManifest) {
    throw new Error("рантайм перезаписал манифест менеджера (payloadVersion потерян)");
  }
  console.log("==> повторный запуск: манифест актуален, payloadVersion менеджера сохранён");

  // 4. Менеджер видит установку и говорит, что она цела.
  const verified = run(manager, ["--verify", game]);
  if (verified.status !== 0) throw new Error(`--verify: ${verified.out}`);
  const status = run(manager, ["--status", game]);
  if (status.status !== 0) throw new Error(`--status: ${status.out}`);
  console.log(`==> менеджер: ${verified.out.trim()}`);
  console.log(`==> статус:   ${status.out.trim()}`);

  // 5. «Обновление распаковкой»: DLL заменена, манифест пересобирается.
  const dll = join(modDir, "NeonTranslatorDX.dll");
  writeFileSync(dll, `// updated ${version}\n`, { flag: "a" });
  const refreshed = run(harness, [modDir, game]);
  if (refreshed.status !== 0) throw new Error(`harness update: ${refreshed.out}`);
  const after = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    files: Array<{ path: string; sha256: string }>;
  };
  const dllEntry = after.files.find(
    (file) => file.path === "mods/NeonTranslatorDX/NeonTranslatorDX.dll",
  );
  if (!dllEntry || dllEntry.sha256 !== sha256(dll)) {
    throw new Error(`манифест не пересобрался после замены DLL: ${refreshed.out.trim()}`);
  }
  if (run(manager, ["--verify", game]).status !== 0) {
    throw new Error("--verify после обновления распаковкой");
  }
  console.log("==> обновление распаковкой: манифест пересобран, целостность OK");

  // 6. Удаление: папка мода и лоадер уходят, файлы архива остаются.
  const removed = run(manager, ["--uninstall", game]);
  if (removed.status !== 0) throw new Error(`--uninstall: ${removed.out}`);
  for (const leftover of [join(game, "dwmapi.dll"), join(game, "mods")]) {
    if (existsSync(leftover)) throw new Error(`остался ${leftover}`);
  }
  if (!existsSync(join(game, "README-INSTALL.md"))) {
    throw new Error("README-INSTALL.md из архива не должен удаляться менеджером");
  }
  console.log(`==> удаление: ${removed.out.trim()}`);

  if (!keep) rmSync(WORK, { recursive: true, force: true });
  console.log("MANUAL E2E PASS: архив чистый, манифест рантайма, verify/update/uninstall работают");
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`MANUAL E2E FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
