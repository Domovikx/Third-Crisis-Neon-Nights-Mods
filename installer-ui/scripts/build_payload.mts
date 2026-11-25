/**
 * build_payload.mts — собрать папку `payload/` для установщика (v1).
 *
 * Payload лежит РЯДОМ С EXE: `<exe_dir>/payload/`. Внутри — ровно то, что
 * копируется в игру (плюс `payload.json` как описание пакета):
 *
 *   payload/
 *     payload.json                 {version, langs, builtAt, source}
 *     dwmapi.dll
 *     mods/NeonTranslatorDX/
 *       NeonTranslatorDX.dll
 *       fonts/*.ttf + typography.json
 *       patch_<lang>.dat           все языки сразу
 *
 * Два источника:
 *   node installer-ui/scripts/build_payload.mts                 # из артефактов репозитория
 *   node installer-ui/scripts/build_payload.mts --from dist/xx.zip
 *
 * Архив (zip/7z) распаковывается 7-Zip'ом во временную папку; берутся только
 * `dwmapi.dll` и `mods/NeonTranslatorDX/` — install.ps1/README из архива не
 * нужны (у установщика свой манифест).
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { translateLangs } from "../../scripts/languages.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const DEFAULT_OUT = join(REPO_ROOT, "installer-ui", "payload");

/** Шрифты, которые кладутся в пакет: латиница/кириллица + CJK + штрихи. */
export const PAYLOAD_FONTS = [
  "RobotoCondensed-Regular.ttf",
  "NotoSansSC.ttf",
  "NotoSansJP.ttf",
  "NotoSansKR.ttf",
  "NotoSansMarks.ttf",
];

export const LOADER = "dwmapi.dll";
export const MOD_REL = "mods/NeonTranslatorDX";
export const RUNTIME_DLL = "NeonTranslatorDX.dll";
export const PAYLOAD_INFO = "payload.json";

export interface PayloadArgs {
  from: string | null;
  out: string;
  version: string;
  help: boolean;
}

export function todayVersion(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

export function parseArgs(argv: string[]): PayloadArgs {
  const out: PayloadArgs = {
    from: null,
    out: DEFAULT_OUT,
    version: todayVersion(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--from") out.from = argv[++i] ?? "";
    else if (arg.startsWith("--from=")) out.from = arg.slice("--from=".length);
    else if (arg === "--out") out.out = resolve(argv[++i] ?? "");
    else if (arg.startsWith("--out=")) out.out = resolve(arg.slice("--out=".length));
    else if (arg === "--version") out.version = argv[++i] ?? "";
    else if (arg.startsWith("--version=")) out.version = arg.slice("--version=".length);
    else throw new Error(`неизвестная опция: ${arg}`);
  }
  if (out.from === "") throw new Error("--from без значения");
  if (!out.version) throw new Error("--version без значения");
  return out;
}

const USAGE = `Сборка payload для установщика NeonTranslatorDX

  node installer-ui/scripts/build_payload.mts [--from <архив|папка>] [--out <папка>] [--version <метка>]

  --from      взять готовые файлы из архива (.zip/.7z) или папки вместо артефактов репозитория
  --out       куда сложить payload (по умолчанию installer-ui/payload)
  --version   версия пакета для payload.json (по умолчанию YYYY.MM.DD)
  --help, -h  эта справка
`;

/** 7-Zip: сначала PATH, потом стандартные каталоги. */
export function find7z(): string | null {
  const probe = spawnSync("7z", ["i"], {
    encoding: "utf-8",
    windowsHide: true,
    stdio: "ignore",
  });
  if (probe.status === 0) return "7z";
  for (const path of [
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  ]) {
    if (existsSync(path)) return path;
  }
  return null;
}

export interface PayloadReport {
  out: string;
  version: string;
  langs: string[];
  files: number;
  bytes: number;
  warnings: string[];
  source: string;
}

function assertFile(path: string, hint: string): void {
  if (!existsSync(path)) throw new Error(`нет файла: ${path} (${hint})`);
  if (statSync(path).size === 0) throw new Error(`пустой файл: ${path} (${hint})`);
}

/** Скопировать из папки-источника только лоадер и папку мода. */
export function copyGameFiles(fromDir: string, out: string): void {
  const loader = join(fromDir, LOADER);
  const modFrom = join(fromDir, MOD_REL);
  assertFile(loader, "payload должен содержать dwmapi.dll");
  assertFile(join(modFrom, RUNTIME_DLL), "payload должен содержать NeonTranslatorDX.dll");

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(loader, join(out, LOADER));
  cpSync(modFrom, join(out, MOD_REL), { recursive: true });
}

/** Из артефактов репозитория: runtime/, fonts/, корневой dwmapi.dll. */
function copyFromRepo(out: string, warnings: string[]): void {
  const layout = join(out, MOD_REL);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(layout, "fonts"), { recursive: true });

  const loader = join(REPO_ROOT, LOADER);
  const runtime = join(REPO_ROOT, "runtime", RUNTIME_DLL);
  assertFile(loader, "соберите прокси: npm run build:proxy");
  assertFile(runtime, "соберите рантайм: npm run build");
  cpSync(loader, join(out, LOADER));
  cpSync(runtime, join(layout, RUNTIME_DLL));

  const real = join(REPO_ROOT, "dwmapi_real.dll");
  if (existsSync(real)) cpSync(real, join(layout, "dwmapi_real.dll"));

  for (const font of PAYLOAD_FONTS) {
    const from = join(REPO_ROOT, "fonts", font);
    if (!existsSync(from) || statSync(from).size === 0) {
      warnings.push(`шрифт отсутствует: fonts/${font}`);
      continue;
    }
    cpSync(from, join(layout, "fonts", font));
  }
  const typography = join(REPO_ROOT, "fonts", "typography.json");
  if (existsSync(typography)) cpSync(typography, join(layout, "fonts", "typography.json"));

  const datFiles = readdirSync(join(REPO_ROOT, "runtime")).filter((name) =>
    /^patch_[a-z]{2}\.dat$/.test(name),
  );
  if (!datFiles.length)
    throw new Error("в runtime/ нет patch_<lang>.dat: npm run po2dat -- <lang>");
  for (const name of datFiles) cpSync(join(REPO_ROOT, "runtime", name), join(layout, name));
}

function extractArchive(archive: string, out: string): void {
  const sevenZip = find7z();
  if (!sevenZip) throw new Error("для --from <архив> нужен 7-Zip (7z.exe)");
  const temp = join(REPO_ROOT, "tmp", "payload-extract");
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  const run = spawnSync(sevenZip, ["x", archive, `-o${temp}`, "-y"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (run.status !== 0) throw new Error(`7z не распаковал ${archive}`);
  try {
    copyGameFiles(temp, out);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Языки по факту: все `patch_<lang>.dat` в пакете. */
export function payloadLangs(out: string): string[] {
  const dir = join(out, MOD_REL);
  const langs = readdirSync(dir)
    .filter((name) => /^patch_[a-z]{2}\.dat$/.test(name))
    .map((name) => name.slice("patch_".length, -".dat".length))
    .sort();
  return ["en", ...langs];
}

export function countFiles(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = countFiles(path);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(path).size;
    }
  }
  return { files, bytes };
}

export function buildPayload(args: PayloadArgs): PayloadReport {
  const warnings: string[] = [];
  if (args.from) {
    const from = resolve(args.from);
    if (!existsSync(from)) throw new Error(`нет источника: ${from}`);
    if (statSync(from).isDirectory()) copyGameFiles(from, args.out);
    else extractArchive(from, args.out);
  } else {
    copyFromRepo(args.out, warnings);
  }

  const langs = payloadLangs(args.out);
  const expected = translateLangs();
  const missing = expected.filter((lang) => !langs.includes(lang));
  if (missing.length) warnings.push(`нет словарей языков: ${missing.join(", ")}`);

  const info = {
    version: args.version,
    langs,
    builtAt: new Date().toISOString(),
    source: args.from ? resolve(args.from) : "repository",
  };
  writeFileSync(join(args.out, PAYLOAD_INFO), `${JSON.stringify(info, null, 2)}\n`, "utf8");

  const { files, bytes } = countFiles(args.out);
  return {
    out: args.out,
    version: args.version,
    langs,
    files,
    bytes,
    warnings,
    source: info.source,
  };
}

function main(argv: string[]): number {
  let args: PayloadArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const report = buildPayload(args);
    console.log(`==> payload: ${report.out}`);
    console.log(
      `    версия ${report.version}, файлов ${report.files}, ${(report.bytes / 1048576).toFixed(2)} MB`,
    );
    console.log(`    языки: ${report.langs.join(", ")}`);
    for (const warning of report.warnings) console.warn(`    ВНИМАНИЕ: ${warning}`);
    console.log("Положите папку payload рядом с NeonTranslatorDX Installer.exe.");
    return 0;
  } catch (error) {
    console.error(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
