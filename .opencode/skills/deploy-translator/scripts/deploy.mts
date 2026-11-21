/**
 * deploy.mts — деплой рантайм-переводчика в установку игры.
 *
 * Порт `deploy.ps1` на TS (одна точка входа вместо PowerShell + python).
 * Делает то же и в том же порядке:
 *   1. (опция `--rebuild`) `buildRuntime()` → `runtime/NeonTranslatorRuntime.dll`;
 *   2. (опция `--proxy`) `buildProxy()` → `dwmapi.dll` в корне игры + копия в репо;
 *   3. `po/<lang>.po` → `runtime/patch_<lang>.dat` (через `po2dat.mts`, одна
 *      реализация на весь репозиторий) → `Managed/patch_<lang>.dat`;
 *   4. DLL + шрифт(ы) + словарь + `active_lang.txt` → `Managed/`;
 *   5. `dwmapi.dll` из репозитория → корень игры (рядом с exe).
 *
 * `--lang en` — native-режим: словарь не собирается и не кладётся, в
 * `active_lang.txt` пишется `en`.
 *
 * Чего нет в порте сознательно: удаления файлов из папки игры (`patch_en.dat`
 * прошлого деплоя, legacy `translations/`) — про них печатается предупреждение,
 * но чужие/старые файлы не стираются.
 *
 * CLI:
 *   node .opencode/skills/deploy-translator/scripts/deploy.mts --lang ru
 *   node .opencode/skills/deploy-translator/scripts/deploy.mts --lang ru --dry-run
 *   node .opencode/skills/deploy-translator/scripts/deploy.mts --lang en
 *   node .opencode/skills/deploy-translator/scripts/deploy.mts --lang de --rebuild --proxy
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { GAME_DATA_FOLDER } from "../../../../scripts/game_dir.mts";
import { REPO_ROOT, SOURCE_LANG, allLangs } from "../../../../scripts/languages.mts";
import { buildDat, writeDat } from "../../extract-text/scripts/po2dat.mts";
import { buildRuntime, resolveGame } from "../../build-translator/scripts/build.mts";
import { buildProxy } from "../../build-translator/scripts/build_proxy.mts";

/** Шрифты, которые кладутся в `Managed/` рядом с основным. */
export const CJK_FONTS = ["NotoSansSC.ttf", "NotoSansJP.ttf"];

/** Основной шрифт с кириллицей (обязателен). */
export const MAIN_FONT = "RobotoCondensed-Regular.ttf";

export type DeployKind = "copy" | "build-dat" | "write-active-lang";

export interface DeployOp {
  /** Что делаем (человекочитаемо). */
  what: string;
  /** Источник; `null` — содержимое генерируется деплоем. */
  from: string | null;
  to: string;
  kind: DeployKind;
  optional: boolean;
  /** Источник существует прямо сейчас. */
  exists: boolean;
}

export interface DeployPlan {
  game: string;
  managed: string;
  lang: string;
  /** `en`: нативный язык игры, словарь не нужен. */
  native: boolean;
  ops: DeployOp[];
  /** Нет обязательного источника — деплой невозможен. */
  missing: string[];
  /** Не блокирует, но о проблеме надо сказать. */
  warnings: string[];
}

/**
 * План деплоя: только чтение ФС, ничего не пишет. `--dry-run` печатает его
 * целиком, обычный запуск исполняет.
 */
export function planDeploy(
  gameDir: string,
  lang: string,
  repoRoot: string = REPO_ROOT,
): DeployPlan {
  const managed = join(gameDir, GAME_DATA_FOLDER, "Managed");
  const native = lang === SOURCE_LANG;
  const ops: DeployOp[] = [];

  const add = (op: Omit<DeployOp, "exists">) => {
    ops.push({ ...op, exists: op.from ? existsSync(op.from) : true });
  };

  add({
    what: "рантайм (C# DLL)",
    from: join(repoRoot, "runtime", "NeonTranslatorRuntime.dll"),
    to: join(managed, "NeonTranslatorRuntime.dll"),
    kind: "copy",
    optional: false,
  });
  add({
    what: `шрифт ${MAIN_FONT}`,
    from: join(repoRoot, "fonts", MAIN_FONT),
    to: join(managed, MAIN_FONT),
    kind: "copy",
    optional: false,
  });
  for (const font of CJK_FONTS) {
    add({
      what: `шрифт ${font} (CJK)`,
      from: join(repoRoot, "fonts", font),
      to: join(managed, font),
      kind: "copy",
      optional: true,
    });
  }
  if (!native) {
    add({
      what: `словарь patch_${lang}.dat`,
      from: join(repoRoot, "po", `${lang}.po`),
      to: join(managed, `patch_${lang}.dat`),
      kind: "build-dat",
      optional: false,
    });
  }
  add({
    what: "active_lang.txt",
    from: null,
    to: join(managed, "active_lang.txt"),
    kind: "write-active-lang",
    optional: false,
  });
  // Прокси нужен, чтобы рантайм вообще загружался. Копия в репо — артефакт
  // `build_proxy`; если её нет, но в игре прокси уже стоит — не перезаписываем.
  const repoProxy = join(repoRoot, "dwmapi.dll");
  const gameProxy = join(gameDir, "dwmapi.dll");
  const repoProxyExists = existsSync(repoProxy);
  const gameProxyExists = existsSync(gameProxy);
  add({
    what: "прокси-лоадер dwmapi.dll",
    from: repoProxy,
    to: gameProxy,
    kind: "copy",
    optional: !repoProxyExists && gameProxyExists,
  });

  const missing = ops
    .filter((op) => !op.optional && !op.exists)
    .map((op) => `нет источника: ${op.what} (${op.from}) — ${hintFor(op, lang)}`);

  const warnings: string[] = [];
  for (const op of ops.filter((o) => o.optional && !o.exists)) {
    warnings.push(`необязательный файл отсутствует: ${op.what} (${op.from})`);
  }
  if (!repoProxyExists && gameProxyExists) {
    warnings.push(
      "копии dwmapi.dll в репозитории нет — в игре уже лежит прокси, не перезаписываю " +
        "(пересобрать: npm run build:proxy)",
    );
  }
  const staleEn = join(managed, "patch_en.dat");
  if (native && existsSync(staleEn)) {
    warnings.push(
      `в Managed/ лежит patch_en.dat прошлого деплоя (не удаляю; рантайм в native-режиме его не читает)`,
    );
  }
  const legacyTranslations = join(gameDir, "translations");
  if (existsSync(legacyTranslations)) {
    warnings.push(
      `в папке игры осталось legacy-зеркало translations/ (YAML-раскладка; не удаляю — удалите вручную, если не нужно)`,
    );
  }

  return { game: gameDir, managed, lang, native, ops, missing, warnings };
}

/** Подсказка «чем починить» для отсутствующего источника. */
function hintFor(op: DeployOp, lang: string): string {
  if (op.what.includes("рантайм")) return "соберите: npm run build";
  if (op.what.includes("dwmapi.dll")) return "соберите: npm run build:proxy (нужен MSVC)";
  if (op.kind === "build-dat") return `нет po/${lang}.po — язык ещё не переведён`;
  return "проверьте репозиторий";
}

export interface DeployResult {
  copied: string[];
  /** Собранный и установленный словарь (`null` в native-режиме). */
  dat: { staged: string; installed: string; rows: number } | null;
  warnings: string[];
}

/**
 * Исполнить план. Бросает, если план неполон (обязательного источника нет).
 * Копирование и запись — атомарные (`.part` → rename): игра, читающая файл в
 * этот момент, не увидит половину словаря.
 */
export function executeDeploy(plan: DeployPlan, repoRoot: string = REPO_ROOT): DeployResult {
  if (plan.missing.length) {
    throw new Error(`деплой невозможен:\n  ${plan.missing.join("\n  ")}`);
  }

  const copied: string[] = [];
  let dat: DeployResult["dat"] = null;

  for (const op of plan.ops) {
    if (!op.exists) {
      // Необязательное: уже перечислено в warnings плана.
      continue;
    }
    if (op.kind === "copy" && op.from) {
      copyAtomic(op.from, op.to);
      copied.push(op.to);
      console.log(`  + ${op.what} -> ${op.to}`);
    } else if (op.kind === "build-dat") {
      const { rows, report } = buildDat(plan.lang, repoRoot);
      const staged = join(repoRoot, "runtime", `patch_${plan.lang}.dat`);
      writeDat(rows, staged);
      copyAtomic(staged, op.to);
      copied.push(op.to);
      dat = { staged, installed: op.to, rows: rows.length };
      console.log(
        `  + patch_${plan.lang}.dat: ${rows.length} строк ` +
          `(переведено ${report.filled}, без rich ${report.noRich}, гейт ${report.gatedAutoNormalized})`,
      );
      console.log(`    ${staged} -> ${op.to}`);
    } else if (op.kind === "write-active-lang") {
      writeAtomic(op.to, plan.lang);
      copied.push(op.to);
      console.log(`  + active_lang.txt = ${plan.lang}`);
    }
  }

  return { copied, dat, warnings: plan.warnings };
}

/** Атомарная запись текста: `.part` → rename. */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  try {
    writeFileSync(part, content, "utf8");
    renameSync(part, path);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}

/** Атомарное копирование: `.part` → rename (источник обязан существовать). */
export function copyAtomic(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`нет источника для копирования: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  const part = `${to}.part`;
  try {
    copyFileSync(from, part);
    renameSync(part, to);
  } catch (e) {
    rmSync(part, { force: true });
    throw new Error(
      `не удалось скопировать ${from} -> ${to}: ${e instanceof Error ? e.message : String(e)}. ` +
        "Нужны права на запись в папку игры (или TCNN_GAME_DIR на копию установки).",
    );
  }
}

export interface DeployArgs {
  lang: string;
  dryRun: boolean;
  rebuild: boolean;
  proxy: boolean;
  help: boolean;
}

/** Разбор аргументов CLI (`--lang <code>`, `--dry-run`, `--rebuild`, `--proxy`). */
export function parseArgs(argv: string[]): DeployArgs {
  const out: DeployArgs = { lang: "ru", dryRun: false, rebuild: false, proxy: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--rebuild") out.rebuild = true;
    else if (arg === "--proxy") out.proxy = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--lang") {
      const value = argv[++i];
      if (!value) throw new Error("--lang без значения (нужен код языка, например ru)");
      out.lang = value;
    } else if (arg.startsWith("--lang=")) out.lang = arg.slice("--lang=".length);
    else throw new Error(`неизвестная опция: ${arg}`);
  }
  return out;
}

const USAGE = `Деплой рантайм-переводчика в игру

  node .opencode/skills/deploy-translator/scripts/deploy.mts [опции]

  --lang <code>  язык из config/language-priority.json (по умолчанию ru);
                 "${SOURCE_LANG}" — native-режим (без словаря)
  --dry-run      показать план, ничего не писать
  --rebuild      перед деплоем собрать runtime/NeonTranslatorRuntime.dll
  --proxy        перед деплоем собрать dwmapi.dll (нужен MSVC)
  --help, -h     эта справка

  Игра: TCNN_GAME_DIR=<папка игры> (иначе автопоиск по Steam-библиотекам).
`;

function printPlan(plan: DeployPlan): void {
  console.log(`Игра:  ${plan.game}`);
  console.log(`Язык:  ${plan.lang}${plan.native ? " (native, без словаря)" : ""}`);
  console.log("\nПлан:");
  for (const op of plan.ops) {
    const mark = op.from === null ? "~" : op.exists ? "+" : op.optional ? "·" : "!";
    console.log(`  ${mark} ${op.what}`);
    if (op.from) console.log(`      ${op.from}`);
    console.log(`   -> ${op.to}`);
  }
  for (const w of plan.warnings) console.warn(`  ВНИМАНИЕ: ${w}`);
}

function main(argv: string[]): number {
  let args: DeployArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const allowed = allLangs();
  if (!allowed.includes(args.lang)) {
    console.error(`язык "${args.lang}" не в приоритете. Доступны: ${allowed.join(", ")}`);
    return 1;
  }

  const game = resolveGame();
  if (game.error || !game.dir) {
    console.error(`ОШИБКА: ${game.error ?? "игра не найдена"}`);
    return 1;
  }
  const gameDir = game.dir;

  try {
    if (args.rebuild) {
      console.log("==> Сборка рантайма");
      buildRuntime({ gameDir });
    }
    if (args.proxy) {
      console.log("==> Сборка прокси");
      buildProxy({ gameDir });
    }

    const plan = planDeploy(gameDir, args.lang);
    printPlan(plan);
    if (plan.missing.length) {
      console.error("\nДеплой невозможен:");
      for (const m of plan.missing) console.error(`  - ${m}`);
      return 1;
    }
    if (args.dryRun) {
      console.log("\nDry-run: ничего не записано. Для деплоя уберите --dry-run.");
      return 0;
    }

    console.log("\n==> Раскладка");
    const result = executeDeploy(plan);
    const managedDll = join(plan.managed, "NeonTranslatorRuntime.dll");
    console.log(`\nГотово: файлов записано ${result.copied.length}`);
    console.log(`  DLL: ${managedDll} (${statSize(managedDll)} байт)`);
    if (result.dat) console.log(`  словарь: ${result.dat.installed} (${result.dat.rows} строк)`);
    console.log(`  язык: ${plan.lang}${plan.native ? " (native)" : ""}`);
    console.log(`  лоадер: ${join(gameDir, "dwmapi.dll")}`);
    console.log("\nПерезапустите игру; лог рантайма — Managed/NeonTranslator.log");
    return 0;
  } catch (e) {
    console.error(`ОШИБКА: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
