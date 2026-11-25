/**
 * build_manual_archive.mts — ручной путь установки: `.7z` с той же раскладкой,
 * что у менеджера, но БЕЗ исполняемых файлов и скриптов.
 *
 * Почему без `install.ps1`: сканер Nexus отправляет архивы с `.exe/.cmd/.ps1`
 * в карантин (проверено на странице мода TSSR 2026-11-13), а ручной путь
 * должен ставиться простой распаковкой. Манифест создаёт сам рантайм при
 * первом запуске игры (`ModManifest.cs`), поэтому менеджер и `--uninstall`
 * работают и для такой установки.
 *
 * Состав архива:
 *
 *   dwmapi.dll
 *   mods/NeonTranslatorDX/…          (payload без payload.json)
 *   README-INSTALL.md
 *   fomod/info.xml                   для Vortex (не обязателен вручную)
 *   fomod/ModuleConfig.xml
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
import { extname, join, resolve } from "node:path";
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

/**
 * Типы, которые Nexus считает исполняемыми и отправляет в карантин.
 * В ручном архиве их быть не должно ни одного (проверяется до упаковки).
 */
export const FORBIDDEN_EXTENSIONS = [
  ".exe",
  ".cmd",
  ".bat",
  ".com",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".msi",
  ".scr",
];

export interface ManualArgs {
  version: string;
  out: string;
  payload: string;
  reuse: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ManualArgs {
  const args: ManualArgs = {
    version: todayVersion(),
    out: join(REPO_ROOT, "dist"),
    payload: DEFAULT_PAYLOAD,
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
    else throw new Error(`неизвестная опция: ${arg}`);
  }
  return args;
}

const USAGE = `Сборка ручного 7z-архива NeonTranslatorDX (без exe и скриптов)

  node installer-ui/scripts/build_manual_archive.mts [--version V] [--out dist]
                                                    [--payload <папка>] [--reuse]

  --version  версия в имени архива и fomod/info.xml (по умолчанию YYYY.MM.DD)
  --out      каталог вывода (по умолчанию dist/)
  --payload  готовая папка payload (по умолчанию installer-ui/payload)
  --reuse    не пересобирать payload, взять существующий
`;

/** info.xml FOMOD: только метаданные, без кода. */
export function fomodInfo(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<fomod>
  <Name>NeonTranslatorDX - Third Crisis: Neon Nights translation</Name>
  <Author>DomovikXus</Author>
  <Version MachineVersion="${version}">${version}</Version>
  <Description>Text translation for 10 languages, fonts and the loader. No executable files.</Description>
</fomod>
`;
}

/** ModuleConfig.xml FOMOD: та же раскладка, что при ручной распаковке. */
export function fomodModule(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">
  <moduleName>NeonTranslatorDX</moduleName>
  <requiredInstallFiles>
    <file source="dwmapi.dll"/>
    <folder source="mods/NeonTranslatorDX" destination="mods/NeonTranslatorDX"/>
  </requiredInstallFiles>
</config>
`;
}

/** README для игрока: установка/обновление/удаление без скриптов. */
export function manualReadme(version: string): string {
  return `# NeonTranslatorDX ${version} — установка без exe

> **СТРОГО 18+.** Игра содержит откровенный контент; перевод передаёт его без цензуры.

В архиве **нет** \`.exe\`, \`.cmd\` и \`.ps1\` — только данные, шрифты, DLL перевода и
лоадер. Ничего запускать не нужно: установка — это распаковка.

## Что в архиве

| Путь                                          | Куда попадает                    |
| --------------------------------------------- | -------------------------------- |
| \`dwmapi.dll\`                                  | корень игры (лоадер)             |
| \`mods/NeonTranslatorDX/NeonTranslatorDX.dll\`  | переводчик                       |
| \`mods/NeonTranslatorDX/patch_<lang>.dat\`      | словари всех языков (10 файлов)  |
| \`mods/NeonTranslatorDX/fonts/\`                | шрифты (латиница, кириллица, CJK) |
| \`mods/NeonTranslatorDX/active_lang.txt\`       | стартовый язык (\`ru\`)           |
| \`README-INSTALL.md\`                           | этот файл                        |
| \`fomod/\`                                      | для Vortex; при ручной распаковке не нужен |

## Установка (3 шага)

1. Распакуйте **весь** архив в папку игры — туда, где лежит
   \`Third Crisis Neon Nights.exe\`. Например:
   \`C:\\Program Files (x86)\\Steam\\steamapps\\common\\Third Crisis Neon Nights\`.
2. Запустите игру **один раз**: рантайм сам создаст
   \`mods\\NeonTranslatorDX\\install-manifest.json\` (список файлов с sha256).
   Он нужен менеджеру и удалению; без него установка всё равно работает.
3. Язык переключается в меню мода в игре.

Установка атомарна по папке: всё, кроме \`dwmapi.dll\`, лежит в
\`mods\\NeonTranslatorDX\\\`.

## Обновление

Распакуйте новый архив **поверх** (в ту же папку игры). Файлы заменятся, а
манифест рантайм пересоберёт при следующем запуске игры — по sha256 самой DLL
он увидит, что сборка новая. Ничего удалять руками не нужно.

## Удаление

Удалите два места (игра вернётся на английский):

- \`<игра>\\dwmapi.dll\`
- папку \`<игра>\\mods\\NeonTranslatorDX\\\` целиком (пустая \`mods\\\` тоже удаляется)

Файлы \`README-INSTALL.md\` и \`fomod\\\` в корне игры — из архива, их можно удалить.
Сохранения и файлы игры не затрагиваются.

Если установлен **NeonTranslatorDX Manager**, удаление проще: «Удалить» в окне
менеджера (он читает \`install-manifest.json\` и удаляет только своё). Если
менеджер пишет «не установлен» — запустите игру один раз, чтобы появился манифест.

## Vortex

«Install from file» с этим же архивом: \`fomod/ModuleConfig.xml\` раскладывает
\`dwmapi.dll\` и \`mods/NeonTranslatorDX/\` в корень игры. Отдельный FOMOD-архив не
нужен; ручная распаковка даёт тот же результат.

## Про \`dwmapi.dll\`

\`dwmapi.dll\` — **лоадер** (подмена системной DLL, DLL-hijack): игра грузит его
раньше своих сборок, а он загружает \`mods/NeonTranslatorDX/NeonTranslatorDX.dll\`.
Другого способа внедрить перевод без правки файлов игры нет. Антивирус может
ругаться на «подмену системной DLL» — это известный паттерн, а не вирус;
исходники лоадера открыты (\`dwmapi_proxy.c\` в репозитории мода). Файлы игры при
этом не изменяются: Steam → «Проверить целостность» не перекачивает ничего,
кроме самого \`dwmapi.dll\` (его можно вернуть повторной распаковкой).

## English (short)

Extract the whole archive into the game folder (next to the game exe). Start the
game once: the runtime writes \`mods/NeonTranslatorDX/install-manifest.json\`
(file list with sha256) used by the manager and the uninstaller. Switch the
language in the in-game mod menu. Update: extract a newer archive over the same
folder (the manifest is rebuilt on the next launch). Uninstall: delete
\`dwmapi.dll\` and \`mods/NeonTranslatorDX/\`. No executable files are included;
\`dwmapi.dll\` is a loader (DLL-hijack) and may trigger antivirus heuristics —
the proxy sources are public in the mod repository.
`;
}

/** Файлы архива, которые обязаны быть на месте до упаковки. */
export function expectedEntries(langs: string[]): string[] {
  return [
    "dwmapi.dll",
    "README-INSTALL.md",
    "fomod/info.xml",
    "fomod/ModuleConfig.xml",
    "mods/NeonTranslatorDX/NeonTranslatorDX.dll",
    "mods/NeonTranslatorDX/active_lang.txt",
    ...langs.map((lang) => `mods/NeonTranslatorDX/patch_${lang}.dat`),
  ];
}

/** Записи архива, которые Nexus отправит в карантин (пусто — чисто). */
export function forbiddenEntries(files: string[]): string[] {
  return files.filter((file) => FORBIDDEN_EXTENSIONS.includes(extname(file).toLowerCase()));
}

export interface ArchiveReport {
  archive: string;
  version: string;
  files: number;
  bytes: number;
  entries: string[];
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
  mkdirSync(join(stage, "fomod"), { recursive: true });

  cpSync(join(payload, LOADER), join(stage, LOADER));
  cpSync(join(payload, MOD_REL), join(stage, MOD_REL), { recursive: true });
  // Стартовый язык — файл данных, не скрипт: без него ручная установка
  // стартовала бы на английском (рантайм по умолчанию берёт "en").
  writeFileSync(join(stage, MOD_REL, "active_lang.txt"), "ru", "utf8");
  writeFileSync(join(stage, "README-INSTALL.md"), manualReadme(args.version), "utf8");
  writeFileSync(join(stage, "fomod", "info.xml"), fomodInfo(args.version), "utf8");
  writeFileSync(join(stage, "fomod", "ModuleConfig.xml"), fomodModule(), "utf8");

  // Контракт раскладки и «Nexus-clean» — до упаковки, а не после.
  const langs = readdirSync(join(stage, MOD_REL))
    .filter((name) => /^patch_[a-z]{2}\.dat$/.test(name))
    .map((name) => name.slice("patch_".length, -".dat".length));
  for (const rel of expectedEntries(langs)) {
    if (!existsSync(join(stage, rel))) throw new Error(`в архиве нет ${rel}`);
  }
  const entries = countFiles(stage).entries;
  const forbidden = forbiddenEntries(entries);
  if (forbidden.length) {
    throw new Error(`в архиве исполняемые файлы: ${forbidden.join(", ")}`);
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
  return { archive, version: args.version, files, bytes, entries };
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
    console.log("    в архиве нет .exe/.cmd/.ps1; манифест создаёт рантайм при первом запуске.");
    console.log("Установка: распаковать в папку игры (см. README-INSTALL.md).");
    return 0;
  } catch (error) {
    console.error(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
