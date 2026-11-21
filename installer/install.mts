/**
 * install.mts — инсталлятор мода (заготовка): находит игру, проверяет артефакты,
 * строит план раскладки. Копирование появится вместе с портом `deploy.ps1`.
 *
 * Контракт уже окончательный: когда `deploy.mts` будет портирован, этот файл
 * станет тонкой обёрткой над ним (одна реализация копирования, не две).
 *
 * CLI:
 *   node installer/install.mts                    # план (dry-run по умолчанию)
 *   node installer/install.mts --lang de          # конкретный язык
 *   node installer/install.mts --game <путь>      # явный путь к игре
 *   node installer/install.mts --apply            # выполнить (пока не реализовано)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { REPO_ROOT, SOURCE_LANG, translateLangs } from "../scripts/languages.mts";
import { GAME_DATA_FOLDER, checkGameDir, findGameDir } from "../scripts/game_dir.mts";

export interface InstallEntry {
  what: string;
  from: string;
  to: string;
  optional: boolean;
  exists: boolean;
}

export interface InstallPlan {
  game: string;
  lang: string;
  entries: InstallEntry[];
  missing: string[];
}

/** План раскладки мода в установку игры. */
export function planInstall(gameDir: string, lang: string, root: string = REPO_ROOT): InstallPlan {
  const managed = join(gameDir, GAME_DATA_FOLDER, "Managed");
  const entries: InstallEntry[] = [
    {
      what: "рантайм (C# DLL)",
      from: join(root, "runtime", "NeonTranslatorRuntime.dll"),
      to: join(managed, "NeonTranslatorRuntime.dll"),
      optional: false,
      exists: false,
    },
    {
      what: "шрифт с кириллицей",
      from: join(root, "fonts", "RobotoCondensed-Regular.ttf"),
      to: join(managed, "RobotoCondensed-Regular.ttf"),
      optional: false,
      exists: false,
    },
    {
      what: "прокси dwmapi.dll",
      from: join(root, "dwmapi.dll"),
      to: join(gameDir, "dwmapi.dll"),
      optional: true,
      exists: false,
    },
  ];

  // Язык-источник (en) — это native-режим: словарь не ставится.
  if (lang !== SOURCE_LANG) {
    entries.push({
      what: `словарь patch_${lang}.dat`,
      from: join(root, "runtime", `patch_${lang}.dat`),
      to: join(managed, `patch_${lang}.dat`),
      optional: false,
      exists: false,
    });
  }

  entries.push({
    what: "файл активного языка",
    from: "(генерируется)",
    to: join(managed, "active_lang.txt"),
    optional: false,
    exists: true,
  });

  for (const e of entries) {
    if (e.from === "(генерируется)") continue;
    e.exists = existsSync(e.from);
  }
  const missing = entries.filter((e) => !e.optional && !e.exists).map((e) => e.what);
  return { game: gameDir, lang, entries, missing };
}

const USAGE = `Установка мода Third Crisis: Neon Nights

  node installer/install.mts [--lang <code>] [--game <путь>] [--apply]

  --lang <code>  язык из config/language-priority.json (по умолчанию ru);
                 "${SOURCE_LANG}" — native-режим без словаря
  --game <путь>  папка игры (иначе автопоиск по Steam-библиотекам)
  --apply        выполнить копирование (появится вместе с портом deploy.ps1)
`;

function parseArgs(argv: string[]): { lang: string; game?: string; apply: boolean; help: boolean } {
  const out = { lang: "ru", game: undefined as string | undefined, apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--lang") out.lang = argv[++i] ?? "ru";
    else if (a === "--game") out.game = argv[++i];
    else throw new Error(`неизвестная опция: ${a}`);
  }
  return out;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const allowed = [SOURCE_LANG, ...translateLangs()];
  if (!allowed.includes(args.lang)) {
    console.error(`язык "${args.lang}" не в приоритете. Доступны: ${allowed.join(", ")}`);
    return 1;
  }

  const game = args.game ?? findGameDir();
  const check = checkGameDir(game);
  if (!check.dir || !check.ok) {
    console.error("Игра не найдена или неполная. Укажите --game <путь> (или TCNN_GAME_DIR).");
    for (const m of check.missing) console.error("  отсутствует:", m);
    return 1;
  }

  const plan = planInstall(check.dir, args.lang);
  console.log(`Игра:  ${plan.game}`);
  console.log(`Язык:  ${plan.lang}${plan.lang === SOURCE_LANG ? " (native, без словаря)" : ""}`);
  console.log("\nПлан:");
  for (const e of plan.entries) {
    const mark = e.from === "(генерируется)" ? "~" : e.exists ? "+" : e.optional ? "·" : "!";
    console.log(`  ${mark} ${e.what}`);
    if (e.from !== "(генерируется)") console.log(`      ${e.from}`);
    console.log(`   -> ${e.to}`);
  }
  if (plan.missing.length) {
    console.error("\nНе хватает артефактов:");
    for (const m of plan.missing) console.error("  -", m);
    console.error("Собрать: npm run po2dat -- <lang> и сборку DLL (см. tasks/).");
    return 1;
  }
  if (!args.apply) {
    console.log("\nDry-run. Для установки: --apply");
    return 0;
  }
  console.error(
    "\nКопирование ещё не портировано: появится вместе с deploy.mts " +
      "(tasks/2026-11-21-port-build-deploy.md). Сейчас используйте deploy.ps1.",
  );
  return 1;
}

if (import.meta.filename === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
