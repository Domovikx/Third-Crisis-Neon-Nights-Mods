/**
 * golden_capture.mts — снять хэши полного дампа в золотую фикстуру.
 *
 * Оракул сборки — `test_data/assemble-golden-full.json` ({файл: sha256}).
 * Пересобирают его ТОЛЬКО после осознанного изменения формата дампа:
 * сборка живёт в `tools/rust-l10n/src/assemble.rs`, сравнивать больше не с чем
 * (TS-эталон удалён 2026-11-24), поэтому «эталон» = последний принятый вывод.
 *
 * CLI:
 *   node .opencode/skills/dump-assets/scripts/golden_capture.mts --dir tmp/dump
 *   node .opencode/skills/dump-assets/scripts/golden_capture.mts --dir tmp/dump --check
 *
 * `--check` не пишет, а сверяет каталог с фикстурой (то же, что делает
 * `TCNN_FULL_GOLDEN=1 node --test scripts/assemble_parity.test.mts`).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const REPO = resolve(import.meta.dirname, "../../../..");
const GOLDEN = join(
  REPO,
  ".opencode",
  "skills",
  "dump-assets",
  "test_data",
  "assemble-golden-full.json",
);

function argValue(name: string): string | null {
  const at = process.argv.indexOf(name);
  if (at < 0) return null;
  return process.argv[at + 1] ?? null;
}

const dir = argValue("--dir");
if (!dir) {
  console.error("usage: golden_capture.mts --dir <каталог дампа> [--check]");
  process.exit(2);
}

const hashes: Record<string, string> = {};
for (const name of readdirSync(dir).sort()) {
  if (!name.endsWith(".jsonl") && name !== "index.md") continue;
  hashes[name] = createHash("sha256")
    .update(readFileSync(join(dir, name)))
    .digest("hex");
}

if (process.argv.includes("--check")) {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, string>;
  const broken = Object.keys(golden)
    .sort()
    .filter((name) => golden[name] !== hashes[name]);
  const extra = Object.keys(hashes).filter((name) => !(name in golden));
  if (broken.length > 0 || extra.length > 0) {
    console.error(`расхождения: ${broken.length}, лишних файлов: ${extra.length}`);
    for (const name of [...broken, ...extra].slice(0, 20)) console.error(`  ${name}`);
    process.exit(1);
  }
  console.log(`OK: ${Object.keys(golden).length} файлов совпали`);
} else {
  writeFileSync(GOLDEN, `${JSON.stringify(hashes, null, 2)}\n`);
  console.log(`записано: ${Object.keys(hashes).length} файлов → ${GOLDEN}`);
}
