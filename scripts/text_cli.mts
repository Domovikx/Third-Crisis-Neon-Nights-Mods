/**
 * text_cli.mts — обёртка над `rust-l10n` (рабочий текстовый пайплайн: potgen, po2dat).
 *
 * Считает Rust (`tools/rust-l10n`), эталоны остаются на TS (`npm run potgen:ts`,
 * `po2dat:ts`) и стерегут паритет в `scripts/text_parity.test.mts`.
 *
 * Замер (2026-11-22): potgen 2.0× на реальном дампе (124 МБ/с против 61), po2dat 4.4×.
 *
 * CLI: node scripts/text_cli.mts <potgen|po2dat> [аргументы]
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

const USAGE = `rust-l10n (обёртка)

  node scripts/text_cli.mts potgen [--update] [--dump <dir>] [--out <path>]
  node scripts/text_cli.mts po2dat [lang]

Эталонные TS-реализации: npm run potgen:ts / npm run po2dat:ts.
Сборка: npm run l10n:build.`;

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd !== "potgen" && cmd !== "po2dat") {
    console.error(`неизвестная подкоманда: ${cmd}`);
    console.log(USAGE);
    return 1;
  }

  const bin = l10nBinary();
  if (!bin) {
    console.error("rust-l10n не собран. Соберите: npm run l10n:build");
    console.error("Эталон без Rust: npm run potgen:ts / npm run po2dat:ts");
    return 2;
  }

  const args = rest.includes("--root") ? [cmd, ...rest] : [cmd, "--root", REPO_ROOT, ...rest];
  const run = spawnSync(bin, args, { stdio: "inherit" });
  return run.status ?? 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
