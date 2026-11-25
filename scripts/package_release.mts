/**
 * package_release.mts — упаковка релиза для игрока (порт `package_release.ps1`).
 *
 * Что делает: проверяет артефакты (только чтение из репозитория), собирает `dist/stage`,
 * кладёт туда DLL рантайма, словарь, шрифт, прокси и инструкцию, генерирует `install.ps1`
 * (артефакт для игрока, не файл репозитория), упаковывает в архив и проверяет содержимое.
 *
 * Папка игры НЕ трогается: только чтение репо + запись в `dist/`.
 *
 * CLI:
 *   node scripts/package_release.mts [--lang ru] [--version 1.0] [--format zip|7z] [--out dist]
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export const REPO_ROOT = resolve(import.meta.dirname, "..");

/** Артефакты, обязательные в релизе (относительно stage). */
export function expectedEntries(lang: string): string[] {
  return [
    "dwmapi.dll",
    "install.ps1",
    "README-INSTALL.md",
    "NeonTranslatorDX/NeonTranslatorDX.dll",
    `NeonTranslatorDX/patch_${lang}.dat`,
    "NeonTranslatorDX/fonts/RobotoCondensed-Regular.ttf",
  ];
}

export interface SourcePlan {
  from: string;
  to: string;
}

/** Что откуда копируется в stage (пути относительно корня репозитория). */
export function planSources(lang: string): SourcePlan[] {
  return [
    { from: "dwmapi.dll", to: "dwmapi.dll" },
    {
      from: "runtime/NeonTranslatorDX.dll",
      to: "NeonTranslatorDX/NeonTranslatorDX.dll",
    },
    { from: `runtime/patch_${lang}.dat`, to: `NeonTranslatorDX/patch_${lang}.dat` },
    {
      from: "fonts/RobotoCondensed-Regular.ttf",
      to: "NeonTranslatorDX/fonts/RobotoCondensed-Regular.ttf",
    },
    { from: "README-INSTALL.md", to: "README-INSTALL.md" },
  ];
}

/** Проверить источники: существуют и непустые. Возвращает список проблем. */
export function validateSources(root: string, lang: string): string[] {
  const problems: string[] = [];
  for (const { from } of planSources(lang)) {
    const p = join(root, from);
    if (!existsSync(p)) problems.push(`нет файла: ${from}`);
    else if (statSync(p).size === 0) problems.push(`пустой файл: ${from}`);
  }
  return problems;
}

/** Список файлов в каталоге (относительные пути с `/`), рекурсивно. */
export function listFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out.sort();
}

/** Шаблон install.ps1 для игрока (генерируется, в репозитории не живёт). */
export function installScript(lang: string): string {
  return `#Requires -Version 5.1
<#
.SYNOPSIS
  Install the ${lang} translation patch into the game folder (idempotent).
.DESCRIPTION
  Run AFTER extracting the release archive into the game folder (the folder that
  contains the game exe). Copies everything into "<game>/NeonTranslatorDX/"
  (fonts in its "fonts/" subfolder), writes active_lang.txt and
  install-manifest.json. The only file outside that folder is dwmapi.dll.
  Safe to re-run: all operations overwrite.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\\install.ps1
#>
param([string]$GameDir = "")

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($GameDir)) { $GameDir = $PSScriptRoot }
$DATA = Join-Path $GameDir 'Third Crisis Neon Nights_Data'
$MOD = Join-Path $GameDir 'NeonTranslatorDX'
$FONTS = Join-Path $MOD 'fonts'
$LANG = '${lang}'

function Step($msg) { Write-Host ("==> " + $msg) }
function Need-File($path, $hint) {
  if (-not (Test-Path -LiteralPath $path)) { throw ("MISSING: " + $path + ". " + $hint) }
  if ((Get-Item -LiteralPath $path).Length -le 0) { throw ("EMPTY: " + $path + ". " + $hint) }
}

Step ("Game dir: " + $GameDir)
if (-not (Test-Path -LiteralPath (Join-Path $DATA 'Managed'))) {
  throw ("Game data not found: " + $DATA + ". Extract the FULL archive into the game folder and rerun.")
}

Need-File (Join-Path $GameDir 'dwmapi.dll') 'dwmapi.dll must sit next to install.ps1'
$SRC_DLL = Join-Path $PSScriptRoot 'NeonTranslatorDX/NeonTranslatorDX.dll'
$SRC_DAT = Join-Path $PSScriptRoot ('NeonTranslatorDX/patch_' + $LANG + '.dat')
$SRC_TTF = Join-Path $PSScriptRoot 'NeonTranslatorDX/fonts/RobotoCondensed-Regular.ttf'
Need-File $SRC_DLL 'archive payload is missing'
Need-File $SRC_DAT 'archive payload is missing'
Need-File $SRC_TTF 'archive payload is missing'

New-Item -ItemType Directory -Force -Path $FONTS | Out-Null
$DST_DLL = Join-Path $MOD 'NeonTranslatorDX.dll'
$DST_DAT = Join-Path $MOD ('patch_' + $LANG + '.dat')
$DST_TTF = Join-Path $FONTS 'RobotoCondensed-Regular.ttf'
function Copy-IfDifferent($src, $dst) {
  if ([IO.Path]::GetFullPath($src) -ne [IO.Path]::GetFullPath($dst)) {
    Copy-Item $src $dst -Force
  }
}
Copy-IfDifferent $SRC_DLL $DST_DLL
Copy-IfDifferent $SRC_DAT $DST_DAT
Copy-IfDifferent $SRC_TTF $DST_TTF
Set-Content -Path (Join-Path $MOD 'active_lang.txt') -Value $LANG -NoNewline

# Manifest for the uninstaller: file, size, sha256 (paths relative to game dir).
$payload = @(
  @{ rel='dwmapi.dll'; abs=(Join-Path $GameDir 'dwmapi.dll') },
  @{ rel='NeonTranslatorDX/NeonTranslatorDX.dll'; abs=$DST_DLL },
  @{ rel='NeonTranslatorDX/fonts/RobotoCondensed-Regular.ttf'; abs=$DST_TTF },
  @{ rel=('NeonTranslatorDX/patch_' + $LANG + '.dat'); abs=$DST_DAT },
  @{ rel='NeonTranslatorDX/active_lang.txt'; abs=(Join-Path $MOD 'active_lang.txt') }
)
$list = @()
foreach ($p in $payload) {
  if (Test-Path -LiteralPath $p.abs) {
    $item = Get-Item -LiteralPath $p.abs
    $list += @{
      path = $p.rel
      size = $item.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $p.abs).Hash.ToLower()
    }
  }
}
$manifest = @{
  version = 1
  lang = $LANG
  installedAt = (Get-Date).ToString('o')
  files = $list
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $MOD 'install-manifest.json') -Encoding UTF8

Step 'Done'
Write-Host ('Lang: ' + $LANG + ' installed. Restart the game and check NeonTranslatorDX\\NeonTranslatorDX.log')
Write-Host 'NOTE: Steam "Verify integrity of game files" deletes dwmapi.dll; re-run install.ps1.'
`;
}

export interface ReleaseArgs {
  lang: string;
  version: string;
  format: "zip" | "7z";
  out: string;
}

export function parseArgs(argv: string[]): ReleaseArgs {
  const out: ReleaseArgs = { lang: "ru", version: "1.0", format: "zip", out: "dist" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => argv[++i] ?? "";
    if (a === "--lang") out.lang = next();
    else if (a === "--version") out.version = next();
    else if (a === "--out") out.out = next();
    else if (a === "--format") {
      const f = next();
      if (f !== "zip" && f !== "7z") throw new Error(`формат: zip|7z, получен "${f}"`);
      out.format = f;
    } else if (a === "--help" || a === "-h") throw new Error("HELP");
    else throw new Error(`неизвестная опция: ${a}`);
  }
  return out;
}

const USAGE = `Упаковка релиза

  node scripts/package_release.mts [--lang ru] [--version 1.0] [--format zip|7z] [--out dist]

  --lang     язык (по умолчанию ru; en не пакуется: native-режим без словаря)
  --version  версия для имени архива
  --format   zip (по умолчанию) или 7z (нужен 7-Zip)
  --out      каталог вывода (по умолчанию dist/)
`;

/** Найти 7-Zip: сначала PATH, потом стандартный каталог. */
export function find7z(): string | null {
  const inPath = spawnSync("7z", ["i"], { encoding: "utf-8", windowsHide: true, stdio: "ignore" });
  if (inPath.status === 0) return "7z";
  for (const p of ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function main(argv: string[]): number {
  let args: ReleaseArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof Error && e.message === "HELP") {
      console.log(USAGE);
      return 0;
    }
    throw e;
  }
  if (args.lang === "en") {
    console.error("en — native-режим (словаря нет), пакуется отдельным решением.");
    return 1;
  }

  const problems = validateSources(REPO_ROOT, args.lang);
  if (problems.length) {
    console.error("Не хватает артефактов:");
    for (const p of problems) console.error("  -", p);
    console.error(`Собрать: npm run build && npm run po2dat -- ${args.lang}`);
    return 1;
  }
  console.log("==> Источники на месте");

  const dist = join(REPO_ROOT, args.out);
  const stage = join(dist, "stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const { from, to } of planSources(args.lang)) {
    const dst = join(stage, to);
    mkdirSync(join(dst, ".."), { recursive: true });
    copyFileSync(join(REPO_ROOT, from), dst);
  }
  writeFileSync(
    join(stage, "install.ps1"),
    installScript(args.lang).replace(/\r\n/g, "\n"),
    "utf8",
  );
  console.log("==> Stage собран:", listFiles(stage).length, "файлов");

  const sevenZip = find7z();
  const archiveName = `NeonTranslatorDX-v${args.version}-${args.lang}.${args.format}`;
  const archive = join(dist, archiveName);
  rmSync(archive, { force: true });

  if (args.format === "7z") {
    if (!sevenZip) {
      console.error("7z не найден. Поставьте 7-Zip или используйте --format zip.");
      return 1;
    }
    const r = spawnSync(sevenZip, ["a", "-t7z", "-mx=9", archive, "*"], {
      cwd: stage,
      stdio: "ignore",
    });
    if (r.status !== 0) {
      console.error("7z завершился с ошибкой");
      return 1;
    }
  } else {
    // zip через 7-Zip (есть в системе); без него — ошибка с подсказкой.
    if (!sevenZip) {
      console.error("Для zip нужен 7-Zip (или добавьте --format 7z при наличии архиватора).");
      return 1;
    }
    const r = spawnSync(sevenZip, ["a", "-tzip", "-mx=9", archive, "*"], {
      cwd: stage,
      stdio: "ignore",
    });
    if (r.status !== 0) {
      console.error("7z завершился с ошибкой");
      return 1;
    }
  }

  if (!existsSync(archive) || statSync(archive).size === 0) {
    console.error("Архив не создан или пуст:", archive);
    return 1;
  }

  // Верификация: сверяем содержимое stage с ожидаемым контрактом.
  const staged = listFiles(stage);
  const expected = expectedEntries(args.lang).sort();
  const missing = expected.filter((e) => !staged.includes(e));
  const extra = staged.filter((e) => !expected.includes(e));
  if (missing.length || extra.length) {
    console.error("Верификация не прошла:");
    for (const m of missing) console.error("  нет:", m);
    for (const e of extra) console.error("  лишнее:", e);
    return 1;
  }

  rmSync(stage, { recursive: true, force: true });
  const kb = Math.round(statSync(archive).size / 1024);
  console.log(`==> OK: ${archive} (${kb} KB, ${staged.length} файлов)`);
  console.log("Папка игры не тронута (только чтение репо и запись в dist/).");
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
