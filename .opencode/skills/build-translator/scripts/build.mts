/**
 * build.mts — сборка `NeonTranslatorDX.dll` из C#-исходников через `csc.exe`.
 *
 * Порт `build.py` (поведение 1:1): те же исходники, те же ссылки на сборки
 * Unity из `Managed/` установленной игры, тот же набор ключей csc. Отличие
 * только в пути к игре: он берётся из `scripts/game_dir.mts` (env
 * `TCNN_GAME_DIR` → Steam-библиотеки), а не «родитель репозитория».
 *
 * CLI:
 *   node .opencode/skills/build-translator/scripts/build.mts
 *   TCNN_GAME_DIR="<игра>" node .../build.mts        # явный путь к игре
 *   TCNN_CSC="<csc.exe>" node .../build.mts          # нестандартная установка .NET
 *
 * Результат: `runtime/NeonTranslatorDX.dll` (артефакт сборки, не в git).
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { GAME_DATA_FOLDER, checkGameDir, findGameDir } from "../../../../scripts/game_dir.mts";

/** Корень репозитория: `scripts` → `build-translator` → `skills` → `.opencode` → корень. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** Каталог C#-исходников рантайма. */
export const SOURCE_DIR = join(import.meta.dirname, "..", "source");

/** Порядок исходников — как в `build.py` (csc порядок не важен, но логи стабильны). */
export const SOURCE_FILES = [
  "NativeMethods.cs",
  "TranslationLoader.cs",
  "TranslatorPlugin.cs",
  "NeonLateUpdate.cs",
  "NeonLanguageSwitcher.cs",
  "NeonFontCore.cs",
  "NeonFonts.cs",
  "NeonTypography.cs",
  "NeonFit.cs",
  "NeonUiKit.cs",
  "NeonUiStrings.cs",
  "NeonFontDebug.cs",
  "NeonUiProbe.cs",
];

/** Сборки Unity/BCL, без которых рантайм не собрать. */
export const REF_DLLS = [
  "UnityEngine.dll",
  "UnityEngine.CoreModule.dll",
  "UnityEngine.UI.dll",
  "UnityEngine.UIModule.dll",
  "UnityEngine.TextRenderingModule.dll",
  "UnityEngine.InputLegacyModule.dll",
  "UnityEngine.InputModule.dll",
  "Unity.TextMeshPro.dll",
  "UnityEngine.TextCoreFontEngineModule.dll",
  "UnityEngine.TextCoreTextEngineModule.dll",
  "netstandard.dll",
];

/** Порог «игра на месте»: без четырёх сборок Unity csc выдаст сотни ошибок. */
export const MIN_REFS = 4;

export interface GameResolution {
  dir: string | null;
  /** Обязательные маркеры игры, которых нет. */
  missing: string[];
  /** Готовая ошибка для CLI (`null` — всё хорошо). */
  error: string | null;
}

/**
 * Папка игры: явный `TCNN_GAME_DIR` важнее автопоиска.
 *
 * Если env задан, но папки нет — это ОШИБКА, а не повод тихо уехать на
 * Steam-копию: иначе сборка/деплой уходят в другую установку, и это
 * замечают уже по поведению игры.
 */
export function resolveGame(env: NodeJS.ProcessEnv = process.env): GameResolution {
  const override = env.TCNN_GAME_DIR;
  if (override) {
    const dir = resolve(override);
    if (!existsSync(dir)) {
      return {
        dir: null,
        missing: [],
        error: `TCNN_GAME_DIR указывает на несуществующую папку: ${dir}`,
      };
    }
    return describe(dir);
  }
  const found = findGameDir(env);
  if (!found) {
    return {
      dir: null,
      missing: [],
      error: "игра не найдена. Задайте TCNN_GAME_DIR=<папка игры> (или установите игру в Steam).",
    };
  }
  return describe(found);
}

/** Папка игры или исключение — общий вход для сборки и прокси. */
export function requireGameDir(): string {
  const game = resolveGame();
  if (game.error || !game.dir) throw new Error(game.error ?? "игра не найдена");
  return game.dir;
}

/** Проверка маркеров установки; ошибка перечисляет, чего не хватает. */
function describe(dir: string): GameResolution {
  const check = checkGameDir(dir);
  if (check.ok) return { dir, missing: [], error: null };
  return {
    dir,
    missing: check.missing,
    error: `в папке игры нет обязательных файлов (${dir}): ${check.missing.join(", ")}`,
  };
}

/** Кандидаты на `csc.exe` в порядке приоритета. */
export function cscCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const windir = env.WINDIR ?? "C:\\Windows";
  const out: string[] = [];
  if (env.TCNN_CSC) out.push(env.TCNN_CSC);
  for (const framework of ["Framework64", "Framework"]) {
    for (const version of ["v4.0.30319", "v3.5"]) {
      out.push(join(windir, "Microsoft.NET", framework, version, "csc.exe"));
    }
  }
  return out;
}

/** Первый существующий кандидат (или null). */
export function chooseCsc(
  candidates: string[],
  exists: (path: string) => boolean = existsSync,
): string | null {
  return candidates.find((p) => exists(p)) ?? null;
}

export interface RefCollection {
  refs: string[];
  /** Имена отсутствующих сборок (в том же порядке, что `REF_DLLS`). */
  missing: string[];
}

/** Существующие ссылки из `Managed/`; отсутствующие — списком, без «молча пропустить». */
export function collectRefs(
  managedDir: string,
  refDlls: string[] = REF_DLLS,
  exists: (path: string) => boolean = existsSync,
): RefCollection {
  const refs: string[] = [];
  const missing: string[] = [];
  for (const name of refDlls) {
    const path = join(managedDir, name);
    if (exists(path)) refs.push(path);
    else missing.push(name);
  }
  return { refs, missing };
}

/** Отсутствующие исходники скилла. */
export function missingSources(
  sourceDir: string = SOURCE_DIR,
  sourceFiles: string[] = SOURCE_FILES,
  exists: (path: string) => boolean = existsSync,
): string[] {
  return sourceFiles.filter((f) => !exists(join(sourceDir, f)));
}

export interface BuildArgsOptions {
  outPath: string;
  refs: string[];
  sources: string[];
}

/** Аргументы csc (порядок как в `build.py`: ключи → ссылки → исходники). */
export function buildArgs(o: BuildArgsOptions): string[] {
  return [
    "/target:library",
    `/out:${o.outPath}`,
    "/platform:x64",
    "/unsafe",
    "/nologo",
    ...o.refs.map((r) => `/r:${r}`),
    ...o.sources,
  ];
}

export interface BuildOptions {
  repoRoot?: string;
  sourceDir?: string;
  /** Папка игры; без неё определяется через `resolveGame()`. */
  gameDir?: string;
  cscPath?: string;
  timeoutMs?: number;
}

export interface BuildResult {
  outPath: string;
  size: number;
  cscPath: string;
  refs: string[];
}

/**
 * Собрать рантайм. Ошибки — исключениями с понятным текстом (CLI печатает их
 * и выходит с кодом 1). Возвращает путь и размер готовой DLL.
 */
export function buildRuntime(o: BuildOptions = {}): BuildResult {
  const repoRoot = o.repoRoot ?? REPO_ROOT;
  const sourceDir = o.sourceDir ?? SOURCE_DIR;

  const missing = missingSources(sourceDir);
  if (missing.length) {
    throw new Error(`нет исходников в ${sourceDir}: ${missing.join(", ")}`);
  }

  const gameDir = o.gameDir ?? requireGameDir();

  const managed = join(gameDir, GAME_DATA_FOLDER, "Managed");
  const { refs, missing: noRefs } = collectRefs(managed);
  if (refs.length < MIN_REFS) {
    throw new Error(
      `в ${managed} мало сборок Unity: ${refs.length} из ${REF_DLLS.length}` +
        (noRefs.length ? `; нет: ${noRefs.join(", ")}` : ""),
    );
  }

  const cscPath = o.cscPath ?? chooseCsc(cscCandidates());
  if (!cscPath) {
    throw new Error(
      "csc.exe не найден (искал: " +
        cscCandidates().join(", ") +
        "). Нужен .NET Framework 4.x или TCNN_CSC=<путь к csc.exe>.",
    );
  }

  const outDir = join(repoRoot, "runtime");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "NeonTranslatorDX.dll");
  const sources = SOURCE_FILES.map((f) => join(sourceDir, f));

  console.log("NeonTranslatorDX — сборка\n");
  console.log(`  исходники: ${SOURCE_FILES.length} файлов — OK`);
  console.log(`  ссылки Unity: ${refs.length} DLL (нет ${noRefs.length})`);
  console.log(`  компилятор: ${cscPath}`);
  console.log(`  вывод: ${outPath}\n`);

  const run = spawnSync(cscPath, buildArgs({ outPath, refs, sources }), {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: o.timeoutMs ?? 180_000,
  });
  if (run.error) throw new Error(`не удалось запустить csc.exe: ${run.error.message}`);
  if (run.status !== 0) {
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    throw new Error(`сборка не удалась (код ${run.status}):\n${output || "csc не сказал ничего"}`);
  }
  if (!existsSync(outPath)) {
    throw new Error(`csc отчитался успехом, но ${outPath} не появился`);
  }

  const size = statSync(outPath).size;
  if (size === 0) throw new Error(`${outPath} пустой`);
  console.log(`  OK: runtime/NeonTranslatorDX.dll (${(size / 1024).toFixed(1)} KB)`);
  return { outPath, size, cscPath, refs };
}

const USAGE = `Сборка рантайм-переводчика (C# → DLL)

  node .opencode/skills/build-translator/scripts/build.mts [--help]

  Игра: TCNN_GAME_DIR=<папка игры> (иначе автопоиск по Steam-библиотекам);
        нужны Managed/UnityEngine*.dll.
  csc:  TCNN_CSC=<csc.exe> (иначе .NET Framework 4.x из C:\\Windows).
`;

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const unknown = argv.filter((a) => a.startsWith("-"));
  if (unknown.length) {
    console.error(`неизвестная опция: ${unknown.join(", ")}\n\n${USAGE}`);
    return 1;
  }
  try {
    buildRuntime();
    return 0;
  } catch (e) {
    console.error(`ОШИБКА: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
