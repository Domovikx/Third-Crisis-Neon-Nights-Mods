/**
 * rawdump.mts — запуск Rust-декодера и чтение его отчёта.
 *
 * Байтовый уровень (UnityFS/SerializedFile/raw-сканеры) живёт в
 * `tools/rust-decoder`; TS-реализация того же контракта удалена 2026-11-24
 * (решение владельца «всё TS-легаси выпиливаем»). Оракул байтового уровня —
 * золотые фикстуры сборки (`scripts/assemble_parity.test.mts`) и тесты самого
 * Rust-крейта.
 *
 * Контракт rd1 (одна JSON-запись на строку) документирован в
 * `tools/rust-decoder` и `tools/rust-l10n/src/rd1read.rs`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

/** Минимальный адрес ассета (имя = display-имя дампа). */
export interface RawTarget {
  name: string;
  path: string;
}

/** Итог байтового прохода (то же, что отдаёт Rust в отчёте). */
export interface RawStats {
  files: number;
  failed: number;
  objects: number;
  typedObjects: number;
  bytesIn: number;
}

/** Путь к собранному бинарю Rust (release важнее debug). */
export function findRustBinary(repoRoot: string): string | null {
  const base = join(repoRoot, "tools", "rust-decoder", "target");
  for (const profile of ["release", "debug"]) {
    for (const name of ["rust-decoder.exe", "rust-decoder"]) {
      const candidate = join(base, profile, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const RUST_BUILD_HINT = "соберите бинарь: cd tools/rust-decoder && cargo build --release";

/** Список «имя<TAB>путь» — так адаптер обходит лимит длины командной строки. */
function writeTargetList(targets: RawTarget[], listPath: string): void {
  const lines = targets.map((t) => `${t.name}\t${t.path}`);
  writeSync(openSync(listPath, "w"), `${lines.join("\n")}\n`);
}

/**
 * Запустить Rust-декодер и получить rd1-файл.
 *
 * `reportPath` (необязательный) — JSON с фазовыми таймингами и пиковой RSS
 * процесса Rust.
 */
export function runRustDecoder(
  repoRoot: string,
  targets: RawTarget[],
  outPath: string,
  reportPath?: string,
): RawStats {
  const binary = findRustBinary(repoRoot);
  if (!binary) {
    throw new Error(`Rust-декодер не собран: ${RUST_BUILD_HINT}`);
  }
  const listPath = join(dirname(outPath), `${outPath.split(/[\\/]/).pop() ?? "raw"}.list`);
  writeTargetList(targets, listPath);
  const args = ["dump", "--out", outPath, "--list", listPath];
  if (reportPath) args.push("--report", reportPath);
  const run = spawnSync(binary, args, { encoding: "utf8" });
  if (run.error) {
    throw new Error(`Rust-декодер не запустился: ${run.error.message}. ${RUST_BUILD_HINT}`);
  }
  if (run.status !== 0) {
    throw new Error(
      `Rust-декодер завершился с кодом ${run.status}: ${(run.stderr ?? "").trim().slice(0, 500)}`,
    );
  }
  if (run.stderr) process.stderr.write(run.stderr);
  if (reportPath && existsSync(reportPath)) {
    const report = readReport(reportPath);
    if (report) return report;
  }
  return { files: targets.length, failed: 0, objects: 0, typedObjects: 0, bytesIn: 0 };
}

/** Прочитать отчёт Rust-декодера (`--report`). */
export function readReport(
  path: string,
): (RawStats & { outBytes?: number; peakRss?: number }) | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      files: Number(raw.files ?? 0),
      failed: Number(raw.failed ?? 0),
      objects: Number(raw.objects ?? 0),
      typedObjects: Number(raw.typed_objects ?? 0),
      bytesIn: Number(raw.bytes_in ?? 0),
      outBytes: Number(raw.out_bytes ?? 0),
      peakRss: typeof raw.peak_rss === "number" ? raw.peak_rss : undefined,
    };
  } catch {
    return null;
  }
}
