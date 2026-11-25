/**
 * build_manual_archive.mts — ручной путь установки: `.7z` с той же раскладкой.
 *
 * Архив собирается из того же `payload/`, что и exe-установщик, поэтому
 * результат файлов совпадает. Внутри:
 *
 *   dwmapi.dll
 *   mods/NeonTranslatorDX/…          (payload без payload.json)
 *   install.ps1                      пишет active_lang.txt + install-manifest.json
 *   README-INSTALL.md                инструкция для игрока
 *
 * Манифест — тот же контракт v1 (`version/lang/installedAt/files[path,size,sha256]`),
 * поэтому Rust-uninstall понимает установку из архива и наоборот.
 *
 *   node installer-ui/scripts/build_manual_archive.mts [--version V] [--out dist] [--reuse]
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

import {
  DEFAULT_OUT as DEFAULT_PAYLOAD,
  LOADER,
  MOD_REL,
  buildPayload,
  countFiles,
  find7z,
  parseArgs as parsePayloadArgs,
  todayVersion,
} from "./build_payload.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");

export interface ManualArgs {
  version: string;
  out: string;
  payload: string;
  lang: string;
  reuse: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ManualArgs {
  const args: ManualArgs = {
    version: todayVersion(),
    out: join(REPO_ROOT, "dist"),
    payload: DEFAULT_PAYLOAD,
    lang: "ru",
    reuse: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--reuse") args.reuse = true;
    else if (arg === "--version") args.version = argv[++i] ?? args.version;
    else if (arg.startsWith("--version=")) args.version = arg.slice("--version=".length);
    else if (arg === "--out") args.out = resolve(argv[++i] ?? "");
    else if (arg.startsWith("--out=")) args.out = resolve(arg.slice("--out=".length));
    else if (arg === "--payload") args.payload = resolve(argv[++i] ?? "");
    else if (arg.startsWith("--payload=")) args.payload = resolve(arg.slice("--payload=".length));
    else if (arg === "--lang") args.lang = argv[++i] ?? args.lang;
    else if (arg.startsWith("--lang=")) args.lang = arg.slice("--lang=".length);
    else throw new Error(`неизвестная опция: ${arg}`);
  }
  return args;
}

const USAGE = `Сборка ручного 7z-архива NeonTranslatorDX

  node installer-ui/scripts/build_manual_archive.mts [--version V] [--out dist]
                                                    [--payload <папка>] [--lang ru] [--reuse]

  --version  версия в имени архива и payload.json (по умолчанию YYYY.MM.DD)
  --out      каталог вывода (по умолчанию dist/)
  --payload  готовая папка payload (по умолчанию installer-ui/payload)
  --lang     стартовый язык, который пишет install.ps1 (по умолчанию ru)
  --reuse    не пересобирать payload, взять существующий
`;

/** `install.ps1` ручного пути: файлы уже на месте, скрипт пишет манифест. */
export function manualInstallScript(version: string, lang: string): string {
  return `#Requires -Version 5.1
<#
.SYNOPSIS
  Install NeonTranslatorDX ${version} into the game folder (idempotent).
.DESCRIPTION
  Run AFTER extracting the archive into the game folder (the folder that contains
  the game exe). Files are already in place; this script writes active_lang.txt
  and install-manifest.json (path, size, sha256) that the uninstaller uses.
  The only file outside "<game>/mods/NeonTranslatorDX/" is dwmapi.dll.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\\install.ps1
  powershell -ExecutionPolicy Bypass -File .\\install.ps1 -Lang de
#>
param(
  [string]$GameDir = "",
  [string]$Lang = "${lang}"
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($GameDir)) { $GameDir = $PSScriptRoot }
$GameDir = (Resolve-Path -LiteralPath $GameDir).Path
$DATA = Join-Path $GameDir 'Third Crisis Neon Nights_Data'
$MOD = Join-Path $GameDir 'mods\\NeonTranslatorDX'
$LOADER = Join-Path $GameDir 'dwmapi.dll'

function Fail($message) { throw $message }

if (-not (Test-Path -LiteralPath (Join-Path $DATA 'Managed'))) {
  Fail ("Game data not found: " + $DATA + ". Extract the archive into the game folder and rerun.")
}
if (-not (Test-Path -LiteralPath $LOADER)) {
  Fail ("dwmapi.dll not found next to install.ps1: " + $LOADER)
}
if (-not (Test-Path -LiteralPath (Join-Path $MOD 'NeonTranslatorDX.dll'))) {
  Fail ("Mod runtime missing: " + $MOD + "\\NeonTranslatorDX.dll")
}
if ($Lang -ne 'en' -and -not (Test-Path -LiteralPath (Join-Path $MOD ('patch_' + $Lang + '.dat')))) {
  Fail ("No dictionary for language '" + $Lang + "' in " + $MOD)
}

Set-Content -Path (Join-Path $MOD 'active_lang.txt') -Value $Lang -NoNewline

# Manifest contract v1: file, size, sha256; paths relative to the game folder.
$files = @()
$files += Get-Item -LiteralPath $LOADER
# Свои файлы архива тоже в манифест: после удаления не остаётся ничего лишнего.
foreach ($name in @('install.ps1', 'README-INSTALL.md')) {
  $own = Join-Path $GameDir $name
  if (Test-Path -LiteralPath $own) { $files += Get-Item -LiteralPath $own }
}
$files += Get-ChildItem -LiteralPath $MOD -Recurse -File |
  Where-Object { $_.Name -ne 'install-manifest.json' }

$list = @()
foreach ($file in $files) {
  $rel = $file.FullName.Substring($GameDir.Length).TrimStart('\\', '/').Replace('\\', '/')
  $list += [ordered]@{
    path   = $rel
    size   = $file.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLower()
  }
}

$manifest = [ordered]@{
  version     = 1
  lang        = $Lang
  installedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  files       = @($list)
}
$json = $manifest | ConvertTo-Json -Depth 5
$encoding = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $MOD 'install-manifest.json'), $json, $encoding)

Write-Host ("Installed files: " + $list.Count + " (lang " + $Lang + ")")
Write-Host "Restart the game; the language is switched in the mod menu."
Write-Host 'NOTE: Steam "Verify integrity of game files" deletes dwmapi.dll; run install.ps1 again.'
`;
}

/** README для игрока (ручной архив; ru + короткий en-блок). */
export function manualReadme(version: string): string {
  return `# NeonTranslatorDX ${version} — ручная установка

> **СТРОГО 18+.** Игра содержит откровенный контент; перевод передаёт его без цензуры.

## Что в архиве

| Путь                                   | Куда попадает                     |
| -------------------------------------- | --------------------------------- |
| \`dwmapi.dll\`                           | корень игры (загрузчик)           |
| \`mods/NeonTranslatorDX/NeonTranslatorDX.dll\` | переводчик                  |
| \`mods/NeonTranslatorDX/patch_<lang>.dat\` | словари всех языков (10 файлов) |
| \`mods/NeonTranslatorDX/fonts/\`         | шрифты (латиница, кириллица, CJK) |
| \`install.ps1\`                          | записывает манифест установки     |

## Установка

1. Распакуйте **всё** в папку игры — туда, где лежит \`Third Crisis Neon Nights.exe\`.
   Пример: \`C:\\Program Files (x86)\\Steam\\steamapps\\common\\Third Crisis Neon Nights\`.
2. В папке игры выполните (PowerShell):

   \`\`\`powershell
   powershell -ExecutionPolicy Bypass -File .\\install.ps1
   \`\`\`

   Скрипт запишет \`active_lang.txt\` (по умолчанию \`ru\`; другой язык — \`-Lang de\`)
   и \`install-manifest.json\` — список поставленного с контрольными суммами.
3. Запустите игру и переключите язык в меню мода.

## Удаление

Любой из способов (результат одинаковый, манифест общий):

- установщиком NeonTranslatorDX: «Проверить установку» → «Удалить»;
- вручную: удалите \`dwmapi.dll\` и папку \`mods\\NeonTranslatorDX\` (пустую \`mods\\\` тоже).

Сохранения и файлы игры не затрагиваются. Steam → «Проверить целостность файлов»
не перекачивает файлы игры ни после установки, ни после удаления; он удаляет только
\`dwmapi.dll\` — тогда запустите \`install.ps1\` заново.

## English (short)

Extract the archive into the game folder (next to the game exe), then run
\`powershell -ExecutionPolicy Bypass -File .\\install.ps1\`. Switch the language in the
in-game mod menu. Uninstall with the installer (it reads \`install-manifest.json\`) or
delete \`dwmapi.dll\` and \`mods/NeonTranslatorDX/\`.
`;
}

export interface ArchiveReport {
  archive: string;
  version: string;
  files: number;
  bytes: number;
  stage: string;
}

export function buildArchive(args: ManualArgs): ArchiveReport {
  const payload = args.payload;
  if (!args.reuse) {
    buildPayload(parsePayloadArgs(["--out", payload, "--version", args.version]));
  }
  if (!existsSync(join(payload, LOADER))) throw new Error(`payload не собран: ${payload}`);
  if (!existsSync(join(payload, MOD_REL))) throw new Error(`в payload нет ${MOD_REL}`);

  const sevenZip = find7z();
  if (!sevenZip) throw new Error("нужен 7-Zip (7z.exe) для сборки архива");

  const stage = join(REPO_ROOT, "installer-ui", "tmp", "manual-stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, MOD_REL), { recursive: true });

  cpSync(join(payload, LOADER), join(stage, LOADER));
  cpSync(join(payload, MOD_REL), join(stage, MOD_REL), { recursive: true });
  writeFileSync(join(stage, "install.ps1"), manualInstallScript(args.version, args.lang), "utf8");
  writeFileSync(join(stage, "README-INSTALL.md"), manualReadme(args.version), "utf8");

  // Контракт раскладки: без этих файлов архив бессмысленный (и это дешевле,
  // чем ловить «пустую установку» у игрока).
  const langs = readdirSync(join(stage, MOD_REL))
    .filter((name) => /^patch_[a-z]{2}\.dat$/.test(name))
    .map((name) => name.slice("patch_".length, -".dat".length));
  for (const rel of expectedEntries(langs)) {
    if (!existsSync(join(stage, rel))) throw new Error(`в архиве нет ${rel}`);
  }

  mkdirSync(args.out, { recursive: true });
  const archive = join(args.out, `NeonTranslatorDX-v${args.version}-manual.7z`);
  rmSync(archive, { force: true });
  const pack = spawnSync(sevenZip, ["a", "-t7z", "-mx=9", archive, "*"], {
    cwd: stage,
    stdio: "ignore",
    windowsHide: true,
  });
  if (pack.status !== 0 || !existsSync(archive) || statSync(archive).size === 0) {
    throw new Error("7z не создал архив");
  }
  const test = spawnSync(sevenZip, ["t", archive], { stdio: "ignore", windowsHide: true });
  if (test.status !== 0) throw new Error("7z t: архив битый");

  const { files, bytes } = countFiles(stage);
  rmSync(stage, { recursive: true, force: true });
  return { archive, version: args.version, files, bytes, stage };
}

/** Проверка раскладки stage: без неё архив может быть «пустым» и незаметным. */
export function expectedEntries(langs: string[]): string[] {
  return [
    "dwmapi.dll",
    "install.ps1",
    "README-INSTALL.md",
    "mods/NeonTranslatorDX/NeonTranslatorDX.dll",
    ...langs.map((lang) => `mods/NeonTranslatorDX/patch_${lang}.dat`),
  ];
}

function main(argv: string[]): number {
  let args: ManualArgs;
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
    const report = buildArchive(args);
    console.log(`==> архив: ${report.archive}`);
    console.log(
      `    версия ${report.version}, файлов ${report.files}, ${(statSync(report.archive).size / 1048576).toFixed(2)} MB`,
    );
    console.log(
      "Установка: распаковать в папку игры и запустить install.ps1 (см. README-INSTALL.md).",
    );
    return 0;
  } catch (error) {
    console.error(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
