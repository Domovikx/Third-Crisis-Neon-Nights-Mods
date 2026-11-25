/**
 * build_proxy.mts — сборка нативного прокси `dwmapi.dll` из `dwmapi_proxy.c` (MSVC).
 *
 * Порт `build_proxy.py`. Прокси подменяет системную `dwmapi.dll` рядом с exe
 * (DLL-hijack) и загружает рантайм-переводчик; все прочие экспорты
 * форвардятся в `dwmapi_real.dll` (копия системной DLL, лежит там же).
 *
 * Отличия от Python-версии:
 * - пути MSVC и Windows SDK не зашиты: ищутся через `vswhere.exe`, с оверрайдами
 *   `TCNN_MSVC_TOOLS` / `TCNN_WINDOWS_SDK` / `TCNN_SDK_VERSION`;
 * - игра — только через `scripts/game_dir.mts` (см. `resolveGame` в `build.mts`);
 * - `.obj/.lib/.exp` уходят в `tmp/build_proxy/`, а не в корень репозитория;
 * - старые легаси-файлы (`version.dll`, `winhttp.dll`, `version_proxy.c`) в папке
 *   игры НЕ удаляются, а перечисляются в предупреждении: чужое не трогаем.
 *
 * CLI:
 *   node .opencode/skills/build-translator/scripts/build_proxy.mts
 *   TCNN_MSVC_TOOLS="<...>/VC/Tools/MSVC/14.50.35717" node .../build_proxy.mts
 *
 * Результат: `<игра>/dwmapi.dll` + `<игра>/mods/NeonTranslatorDX/dwmapi_real.dll`; копия
 * прокси синхронизируется в корень репозитория (`dwmapi.dll`, трекается).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { REPO_ROOT, requireGameDir } from "./build.mts";

/** Исходник прокси (C). */
export const PROXY_SOURCE = join(import.meta.dirname, "..", "source", "dwmapi_proxy.c");
export const PROXY_NAME = "dwmapi.dll";
export const REAL_COPY_NAME = "dwmapi_real.dll";
/** Папка мода: всё, кроме лоадера `dwmapi.dll`, живёт здесь. */
export const MODS_FOLDER = "mods";
export const MOD_FOLDER = "NeonTranslatorDX";

/** Легаси-лоадеры прошлых версий: только предупреждаем, не удаляем. */
export const LEGACY_FILES = ["version.dll", "version_proxy.c", "winhttp.dll"];

export interface MsvcLayout {
  cl: string;
  includes: string[];
  libs: string[];
}

/** Сравнение версий вида `14.50.35717` / `10.0.26100.0` по числовым частям. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Самая новая версия из списка имён каталогов (`null` — версий нет). */
export function pickLatestVersion(names: string[]): string | null {
  const versions = names.filter((n) => /^\d+(\.\d+)+$/.test(n));
  if (!versions.length) return null;
  return versions.sort(compareVersions).at(-1) ?? null;
}

/** Раскладка include/lib для MSVC + Windows SDK (чистая функция, без ФС). */
export function msvcLayout(toolsDir: string, kitsRoot: string, sdkVersion: string): MsvcLayout {
  const sdkInclude = join(kitsRoot, "Include", sdkVersion);
  const sdkLib = join(kitsRoot, "Lib", sdkVersion);
  return {
    cl: join(toolsDir, "bin", "Hostx64", "x64", "cl.exe"),
    includes: [
      join(toolsDir, "include"),
      join(sdkInclude, "shared"),
      join(sdkInclude, "um"),
      join(sdkInclude, "ucrt"),
    ],
    libs: [join(toolsDir, "lib", "x64"), join(sdkLib, "ucrt", "x64"), join(sdkLib, "um", "x64")],
  };
}

export interface DiscoverOptions {
  env?: NodeJS.ProcessEnv;
  /** Каталоги установок Visual Studio (для фолбэка, если vswhere молчит). */
  vsRoots?: string[];
}

const DEFAULT_VS_ROOTS = [
  "C:\\Program Files\\Microsoft Visual Studio",
  "C:\\Program Files (x86)\\Microsoft Visual Studio",
];

/** Каталог инструментов MSVC: `<VS>/<год>/<продукт>/VC/Tools/MSVC/<версия>`. */
function findToolsDir(env: NodeJS.ProcessEnv, vsRoots: string[]): string | null {
  if (env.TCNN_MSVC_TOOLS) return env.TCNN_MSVC_TOOLS;

  const vsWhere = join(
    env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (existsSync(vsWhere)) {
    const run = spawnSync(
      vsWhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    const install = (run.stdout ?? "").trim();
    if (run.status === 0 && install) {
      const toolsRoot = join(install, "VC", "Tools", "MSVC");
      const version = pickLatestVersion(safeReaddir(toolsRoot));
      if (version) return join(toolsRoot, version);
    }
  }

  // Фолбэк: vswhere может отсутствовать (Build Tools без Installer-обвязки).
  for (const root of vsRoots) {
    for (const edition of safeReaddir(root)) {
      for (const product of safeReaddir(join(root, edition))) {
        const toolsRoot = join(root, edition, product, "VC", "Tools", "MSVC");
        const version = pickLatestVersion(safeReaddir(toolsRoot));
        if (version) return join(toolsRoot, version);
      }
    }
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Найти cl.exe и каталоги include/lib. Ошибки — с подсказкой, что задать.
 * Наличие самих каталогов проверяет `buildProxy` (там же понятный список).
 */
export function discoverMsvc(o: DiscoverOptions = {}): MsvcLayout {
  const env = o.env ?? process.env;
  const vsRoots = o.vsRoots ?? DEFAULT_VS_ROOTS;

  const toolsDir = findToolsDir(env, vsRoots);
  if (!toolsDir) {
    throw new Error(
      "MSVC не найден: нет ни vswhere с C++ Build Tools, ни TCNN_MSVC_TOOLS. " +
        "Поставьте Visual Studio Build Tools (C++ x64) или задайте " +
        "TCNN_MSVC_TOOLS=<...>/VC/Tools/MSVC/<версия>.",
    );
  }

  const kitsRoot =
    env.TCNN_WINDOWS_SDK ??
    join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10");

  let sdkVersion = env.TCNN_SDK_VERSION;
  if (!sdkVersion) {
    const withLib = safeReaddir(join(kitsRoot, "Include")).filter((v) =>
      existsSync(join(kitsRoot, "Lib", v)),
    );
    sdkVersion = pickLatestVersion(withLib) ?? undefined;
  }
  if (!sdkVersion) {
    throw new Error(
      `Windows SDK не найден в ${kitsRoot}: нет версии с каталогом Lib. ` +
        "Поставьте Windows 10/11 SDK или задайте TCNN_WINDOWS_SDK=<...>\\Windows Kits\\10.",
    );
  }
  return msvcLayout(toolsDir, kitsRoot, sdkVersion);
}

/** Аргументы cl.exe (ключи как в `build_proxy.py`). */
export function proxyArgs(
  layout: MsvcLayout,
  source: string,
  outPath: string,
  objPath: string,
  implibPath?: string,
): string[] {
  return [
    layout.cl,
    "/nologo",
    "/O1",
    "/MD",
    "/LD",
    "/UTF-8",
    `/Fo${objPath}`,
    `/Fe${outPath}`,
    ...layout.includes.map((p) => `/I${p}`),
    source,
    "/link",
    ...(implibPath ? [`/IMPLIB:${implibPath}`] : []),
    ...layout.libs.map((p) => `/LIBPATH:${p}`),
    "/MACHINE:X64",
    "kernel32.lib",
  ];
}

/** Чего не хватает из раскладки MSVC (cl, include, lib). */
export function missingLayoutPaths(layout: MsvcLayout): string[] {
  return [layout.cl, ...layout.includes, ...layout.libs].filter((p) => !existsSync(p));
}

export interface ProxyBuildOptions {
  repoRoot?: string;
  gameDir?: string;
  source?: string;
  /** Пропустить копирование системной dwmapi.dll (для тестов/повторной сборки). */
  skipRealCopy?: boolean;
  timeoutMs?: number;
}

export interface ProxyBuildResult {
  outPath: string;
  size: number;
  realCopy: string | null;
  repoSync: string;
  /** Копия системной DLL в репозитории (источник для `deploy`, `null` — не делали). */
  repoSyncReal: string | null;
  /** Легаси-файлы в папке игры (не удалены, только перечислены). */
  legacy: string[];
  layout: MsvcLayout;
}

/** Собрать прокси и разложить: `<игра>/dwmapi.dll`, `<игра>/mods/NeonTranslatorDX/dwmapi_real.dll`, репо-копии. */
export function buildProxy(o: ProxyBuildOptions = {}): ProxyBuildResult {
  const repoRoot = o.repoRoot ?? REPO_ROOT;
  const source = o.source ?? PROXY_SOURCE;

  const gameDir = o.gameDir ?? requireGameDir();

  if (!existsSync(source)) throw new Error(`нет исходника прокси: ${source}`);

  console.log("dwmapi.dll — сборка нативного прокси\n");

  // 1. Копия системной DLL: прокси форвардит в неё все остальные экспорты.
  //    Лежит в папке мода, чтобы в корне игры остался один файл — лоадер.
  let realCopy: string | null = null;
  let repoSyncReal: string | null = null;
  if (!o.skipRealCopy) {
    const systemDwmapi = join(process.env.SystemRoot ?? "C:\\Windows", "System32", PROXY_NAME);
    if (!existsSync(systemDwmapi)) throw new Error(`не найдена системная DLL: ${systemDwmapi}`);
    const modDir = join(gameDir, MODS_FOLDER, MOD_FOLDER);
    mkdirSync(modDir, { recursive: true });
    realCopy = join(modDir, REAL_COPY_NAME);
    copyWithHint(systemDwmapi, realCopy, "скопировать системную dwmapi.dll");
    repoSyncReal = join(repoRoot, REAL_COPY_NAME);
    copyFileSync(realCopy, repoSyncReal);
    console.log(`  системная DLL: ${systemDwmapi}`);
    console.log(
      `  -> ${MODS_FOLDER}/${MOD_FOLDER}/${REAL_COPY_NAME} в папке мода (цель форвардов)`,
    );
  }

  // 2. Легаси прошлых версий: не трогаем, но говорим вслух.
  const legacy = LEGACY_FILES.filter((f) => existsSync(join(gameDir, f)));
  if (legacy.length) {
    console.warn(`  ВНИМАНИЕ: в папке игры остались старые файлы: ${legacy.join(", ")}`);
  }

  // 3. Компиляция.
  const layout = discoverMsvc();
  const missing = missingLayoutPaths(layout);
  if (missing.length) {
    throw new Error(`в MSVC/Windows SDK нет путей: ${missing.join(", ")}`);
  }
  const objDir = join(repoRoot, "tmp", "build_proxy");
  mkdirSync(objDir, { recursive: true });
  const outPath = join(gameDir, PROXY_NAME);
  const args = proxyArgs(
    layout,
    source,
    outPath,
    join(objDir, "dwmapi_proxy.obj"),
    join(objDir, "dwmapi.lib"),
  );

  console.log(`  компилятор: ${layout.cl}`);
  console.log("  компиляция...\n");
  // `proxyArgs[0]` — сам cl.exe (как в `build_proxy.py`), поэтому отделяем:
  // иначе cl получит свой же путь как исходник (LNK1107 / D9024).
  const run = spawnSync(args[0], args.slice(1), {
    cwd: objDir,
    encoding: "buffer",
    timeout: o.timeoutMs ?? 180_000,
  });
  if (run.error) throw new Error(`не удалось запустить cl.exe: ${run.error.message}`);
  if (run.status !== 0) {
    const output = `${decodeOem(run.stdout)}${decodeOem(run.stderr)}`.trim();
    throw new Error(
      `сборка прокси не удалась (код ${run.status}):\n${output || "cl не сказал ничего"}`,
    );
  }
  if (!existsSync(outPath)) throw new Error(`cl отчитался успехом, но ${outPath} не появился`);
  const size = statSync(outPath).size;
  if (size === 0) throw new Error(`${outPath} пустой`);
  console.log(`  OK: dwmapi.dll (${(size / 1024).toFixed(1)} KB)`);
  if (realCopy) {
    console.log(`  OK: ${REAL_COPY_NAME} (${(statSync(realCopy).size / 1024).toFixed(1)} KB)`);
    if (repoSyncReal) console.log(`  OK: копия ${REAL_COPY_NAME} в репозитории -> ${repoSyncReal}`);
  }

  // 4. Ресинк копии в репозитории: `deploy` ставит прокси именно отсюда.
  const repoSync = join(repoRoot, PROXY_NAME);
  copyFileSync(outPath, repoSync);
  console.log(`  OK: копия в репозитории -> ${repoSync}`);

  console.log("\n  Перезапустите игру, чтобы загрузился новый прокси.");
  return { outPath, size, realCopy, repoSync, repoSyncReal, legacy, layout };
}

/** Копирование с понятной ошибкой (нет прав / нет папки). */
function copyWithHint(from: string, to: string, what: string): void {
  try {
    copyFileSync(from, to);
  } catch (e) {
    throw new Error(
      `не удалось ${what}: ${from} -> ${to}: ${e instanceof Error ? e.message : String(e)}. ` +
        "Нужны права на запись в папку игры (или TCNN_GAME_DIR на копию установки).",
    );
  }
}

/** Вывод cl.exe идёт в OEM-кодировке консоли (cp866) — иначе текст ошибок нечитаем. */
export function decodeOem(buf: Buffer | string | null | undefined): string {
  if (!buf) return "";
  if (typeof buf === "string") return buf;
  try {
    return new TextDecoder("ibm866").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

const USAGE = `Сборка нативного прокси dwmapi.dll (C → dll, MSVC)

  node .opencode/skills/build-translator/scripts/build_proxy.mts [--help]

  Игра:   TCNN_GAME_DIR=<папка игры> (иначе автопоиск по Steam-библиотекам)
  MSVC:   автопоиск через vswhere; оверрайды TCNN_MSVC_TOOLS, TCNN_WINDOWS_SDK,
          TCNN_SDK_VERSION.
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
    buildProxy();
    return 0;
  } catch (e) {
    console.error(`ОШИБКА: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
