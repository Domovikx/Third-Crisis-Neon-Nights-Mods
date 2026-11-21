/**
 * install.mts — инсталлятор мода: тонкая обёртка над деплоем.
 *
 * Вся раскладка (что куда копировать, что сгенерировать) живёт в `deploy.mts` —
 * здесь только выбор языка, поиск игры и человекочитаемый вывод. Двух реализаций
 * копирования быть не должно (DRY); раньше этот файл строил собственный план.
 *
 * CLI:
 *   node installer/install.mts                    # план (dry-run)
 *   node installer/install.mts --lang de          # конкретный язык
 *   node installer/install.mts --game <путь>      # явный путь к игре
 *   node installer/install.mts --apply            # выполнить установку
 */
import process from "node:process";

import { REPO_ROOT, SOURCE_LANG, translateLangs } from "../scripts/languages.mts";
import { checkGameDir, findGameDir } from "../scripts/game_dir.mts";
import {
  type DeployPlan,
  executeDeploy,
  planDeploy,
} from "../.opencode/skills/deploy-translator/scripts/deploy.mts";

const USAGE = `Установка мода Third Crisis: Neon Nights

  node installer/install.mts [--lang <code>] [--game <путь>] [--apply]

  --lang <code>  язык из config/language-priority.json (по умолчанию ru);
                 "${SOURCE_LANG}" — native-режим без словаря
  --game <путь>  папка игры (иначе автопоиск по Steam-библиотекам)
  --apply        выполнить установку (по умолчанию только план)
`;

export function parseInstallArgs(argv: string[]): {
  lang: string;
  game?: string;
  apply: boolean;
  help: boolean;
} {
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

/** Человекочитаемый вывод плана (тот же план, что исполнит деплой). */
export function formatPlan(plan: DeployPlan): string {
  const lines: string[] = [];
  lines.push(`Игра:  ${plan.game}`);
  lines.push(`Язык:  ${plan.lang}${plan.native ? " (native, без словаря)" : ""}`);
  lines.push("");
  lines.push("План:");
  for (const op of plan.ops) {
    const mark = op.from === null ? "~" : op.exists ? "+" : op.optional ? "·" : "!";
    lines.push(`  ${mark} ${op.what}`);
    if (op.from) lines.push(`      ${op.from}`);
    lines.push(`   -> ${op.to}`);
  }
  for (const w of plan.warnings) lines.push(`  ! предупреждение: ${w}`);
  return lines.join("\n");
}

function main(argv: string[]): number {
  const args = parseInstallArgs(argv);
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

  const plan = planDeploy(check.dir, args.lang, REPO_ROOT);
  console.log(formatPlan(plan));

  if (plan.missing.length) {
    console.error("\nНе хватает артефактов:");
    for (const m of plan.missing) console.error("  -", m);
    console.error("Собрать: npm run build && npm run po2dat -- <lang>");
    return 1;
  }
  if (!args.apply) {
    console.log("\nDry-run. Для установки: --apply");
    return 0;
  }

  const res = executeDeploy(plan, REPO_ROOT);
  console.log(`\nУстановлено файлов: ${res.copied.length}`);
  for (const w of res.copied) console.log("  +", w);
  if (res.dat) console.log(`  словарь: ${res.dat.rows} строк -> ${res.dat.installed}`);
  for (const w of res.warnings) console.log("  !", w);
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
