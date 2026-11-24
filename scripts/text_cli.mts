/**
 * text_cli.mts — обёртка над `rust-l10n` (рабочий текстовый пайплайн:
 * potgen, po2dat, po_update).
 *
 * Считает Rust (`tools/rust-l10n`) — единственная рабочая реализация. У `potgen`
 * и `po_update` TS-эталоны ещё живут (`potgen:ts`, `po:update:ts`) и стерегут
 * паритет в `scripts/text_parity.test.mts`; `po2dat`/`prefill`/`find_source`
 * уже без TS-дублей (правило — `docs/rust-vs-ts.md`).
 *
 * Замер (2026-11-22): potgen 2.0× на реальном дампе (124 МБ/с против 61),
 * po2dat 4.4×, po_update 4.2×, prefill ~4× на реальных po/
 *
 * CLI: node scripts/text_cli.mts <potgen|po2dat|po_update|prefill|find_source> [аргументы]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { REPO_ROOT } from "./languages.mts";

/** Собранный бинарь `rust-l10n` или null. */
export function l10nBinary(root: string = REPO_ROOT): string | null {
  const candidates = [
    join(root, "tools", "rust-l10n", "target", "release", "rust-l10n.exe"),
    join(root, "tools", "rust-l10n", "target", "release", "rust-l10n"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Подкоманды, у которых корень передаётся флагом `--root`. */
const COMMANDS = new Set([
  "potgen",
  "po2dat",
  "po_update",
  "prefill",
  "find_source",
  "dump_assemble",
]);
/** Подкоманды, которым корень не нужен: пути задаются позиционно. */
const NO_ROOT = new Set(["dump_assemble"]);
/** Флаги, которые сами задают пути (тогда `--root` не подставляется). */
const PATH_FLAGS = new Set([
  "--root",
  "--po-dir",
  "--corpus",
  "--out",
  "--dump",
  "--skip-policy",
  "--skip-journal",
]);

const USAGE = `rust-l10n (обёртка)

  node scripts/text_cli.mts potgen [--update] [--dump <dir>] [--out <path>]
                        [--skip-policy <p> | --no-skip-policy] [--skip-journal <p>]
  node scripts/text_cli.mts po2dat [lang]
  node scripts/text_cli.mts po_update [lang] [--po-dir <dir>] [--dup-rule <r>]
                        [--json <path>] [--no-backup]
  node scripts/text_cli.mts prefill [lang] [--po-dir <dir>] [--corpus <dir>]
                        [--json <path>]
  node scripts/text_cli.mts dump_assemble <rd1.jsonl> <out-dir> [--json]
  node scripts/text_cli.mts find_source "<msgid text>" [--first] [--dump <dir>]

Дамп для find_source сканируется тем же Rust-инвентарём, что у potgen.
Эталоны TS остались только у potgen и po_update: npm run potgen:ts / npm run po:update:ts.
Сборка: npm run l10n:build.`;

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (!COMMANDS.has(cmd)) {
    console.error(`неизвестная подкоманда: ${cmd}`);
    console.log(USAGE);
    return 1;
  }

  const bin = l10nBinary();
  if (!bin) {
    console.error("rust-l10n не собран. Соберите: npm run l10n:build");
    console.error(
      "Без Rust работает только паритетный эталон: npm run potgen:ts / npm run po:update:ts",
    );
    return 2;
  }

  const hasPath = rest.some((a) => {
    const name = a.split("=")[0];
    return PATH_FLAGS.has(name);
  });
  const args = hasPath || NO_ROOT.has(cmd) ? [cmd, ...rest] : [cmd, "--root", REPO_ROOT, ...rest];
  const run = spawnSync(bin, args, { stdio: "inherit" });
  return run.status ?? 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
