/**
 * package_release.mts — DEPRECATED-обёртка над новым сборщиком релиза.
 *
 * Старый путь собирал single-lang zip и генерировал `install.ps1` (скриптовая
 * установка). Решение владельца 2026-11-25: ручной путь — только распаковка,
 * без `.exe/.cmd/.ps1`, манифест создаёт рантайм. Поэтому вся сборка живёт в
 * `installer-ui/scripts/build_manual_archive.mts` (все 10 языков, 7z, FOMOD).
 *
 * Файл оставлен, чтобы `npm run release` продолжал работать; он ничего своего
 * не собирает. `--lang` и `--format` принимаются только для совместимости и
 * игнорируются (языки — все сразу, формат — 7z).
 *
 * CLI:
 *   npm run release
 *   node scripts/package_release.mts [--version 2026.11.25] [--out dist] [--reuse]
 */
import { join, resolve } from "node:path";
import process from "node:process";

import {
  type ArchiveReport,
  REPO_ROOT,
  buildArchive,
  parseArgs as parseManualArgs,
} from "../installer-ui/scripts/build_manual_archive.mts";

export { REPO_ROOT };

export interface ReleaseArgs {
  version: string | null;
  out: string;
  reuse: boolean;
  help: boolean;
  /** Опции старого CLI, которые приняты, но не действуют. */
  ignored: string[];
}

const USAGE = `Сборка релиза NeonTranslatorDX (обёртка над ручным 7z-архивом)

  npm run release
  node scripts/package_release.mts [--version <V>] [--out <папка>] [--reuse]

  --version  версия в имени архива (по умолчанию YYYY.MM.DD)
  --out      каталог вывода (по умолчанию dist/)
  --reuse    не пересобирать payload, взять существующий

  Устаревшие опции (принимаются и игнорируются):
  --lang <code>   все 10 языков кладутся сразу
  --format zip    формат всегда 7z (Nexus-clean архив без скриптов)

  Сборка без exe и скриптов; манифест создаёт рантайм при первом запуске.
`;

/** Разбор аргументов: новые passthrough, старые — в `ignored`. */
export function parseArgs(argv: string[]): ReleaseArgs {
  const out: ReleaseArgs = {
    version: null,
    out: join(REPO_ROOT, "dist"),
    reuse: false,
    help: false,
    ignored: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--reuse") out.reuse = true;
    else if (arg === "--version") out.version = argv[++i] ?? null;
    else if (arg.startsWith("--version=")) out.version = arg.slice("--version=".length);
    else if (arg === "--out") out.out = resolve(argv[++i] ?? "");
    else if (arg.startsWith("--out=")) out.out = resolve(arg.slice("--out=".length));
    else if (arg === "--lang" || arg === "--format") {
      // Старый CLI: значение съедаем, но не применяем.
      out.ignored.push(`${arg} ${argv[++i] ?? ""}`.trim());
    } else if (arg.startsWith("--lang=") || arg.startsWith("--format=")) {
      out.ignored.push(arg);
    } else throw new Error(`неизвестная опция: ${arg}`);
  }
  return out;
}

/** Аргументы нового сборщика (без устаревших опций). */
export function toManualArgs(args: ReleaseArgs): string[] {
  const argv = ["--out", args.out];
  if (args.version) argv.push("--version", args.version);
  if (args.reuse) argv.push("--reuse");
  return argv;
}

/** Собрать релиз новым путём. */
export function release(args: ReleaseArgs): ArchiveReport {
  return buildArchive(parseManualArgs(toManualArgs(args)));
}

function main(argv: string[]): number {
  let args: ReleaseArgs;
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
  for (const ignored of args.ignored) {
    console.warn(`ВНИМАНИЕ: ${ignored} игнорируется — все языки сразу, формат 7z.`);
  }

  try {
    const report = release(args);
    console.log(`==> релиз: ${report.archive}`);
    console.log(`    версия ${report.version}, файлов ${report.files}`);
    console.log("    в архиве нет .exe/.cmd/.ps1; манифест создаёт рантайм.");
    return 0;
  } catch (error) {
    console.error(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
