/**
 * rawdump.mts — промежуточный JSONL «сырья» (rd1): граница между байтовым
 * уровнем и семантикой.
 *
 * Зачем два файла на одном контракте:
 *   - `writeRawDumpTs` — эталон формата на TS: тем же кодом (`unityfs`,
 *     `serialized`, `rawscan`) собирает rd1 и служит (а) оракулом для Rust,
 *     (б) «ТС байтовым ядром» в бенчмарке;
 *   - `runRustDecoder` — запуск Rust-декодера (`tools/rust-decoder`), который
 *     пишет тот же rd1.
 *
 * Контракт (одна JSON-запись на строку, компактные разделители, порядок ключей
 * фиксирован — сверяется ПОБАЙТОВО):
 *
 *   {"t":"asset","asset","path","kind"[,"entries":[{"path","offset","size"}]][,"error"]}
 *   {"t":"sf","i","name","unityVersion","headerVersion","typeTreeEnabled","objectCount","endian"}
 *   {"t":"type","sf","typeId","classId","nodeCount","stringSize","blob"}
 *   {"t":"obj","sf","typeId","classId","pathId"[,"raw"]["rs"]["dl"]["cpl"]}
 *   {"t":"warn","texts":[...]}
 *   {"t":"runs","texts":[...]}
 *   {"t":"keys","keys":[{"key","display"}]}
 *   {"t":"us","heap":"<base64>"}
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Здесь только факты из байтов: контейнер, таблицы,
 * blob'ы type tree, сырые строки/диалоги/ColorParserList/Settings.*, куча
 * `#US`, сырые байты типизированных объектов. Отбор полей для JSONL, фильтры
 * UI-текста, дедуп, порядок и имена ассетов — в `dump_assets.mts` (TS), в
 * Rust их нет вовсе: иначе правила пришлось бы держать в двух местах.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isSerializedFile, readSerializedFile, type SerializedFile } from "./serialized.mts";
import { isUnityFs, readUnityFs, type UnityFsEntry } from "./unityfs.mts";
import {
  parseColorParserList,
  parseDialogueFromRaw,
  scanRawStrings,
  scanSettingsKeys,
  type SettingKey,
} from "./rawscan.mts";
import { pyStrip } from "./pystr.mts";
import { findDotnetUsHeap } from "./dotnet.mts";

/** Кто перед нами — тот же набор, что у `AssetKind` в `dump_assets.mts`. */
export type RawAssetKind = "serialized" | "unityfs" | "raw" | "dotnet" | "unknown";

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

/** Фазовые тайминги байтового прохода (мс). */
export interface RawTimings {
  readMs: number;
  decodeMs: number;
  scanMs: number;
  runsMs: number;
}

/** Расширения, которые UnityPy НЕ разбирает как SerializedFile. */
const NON_SERIALIZED_EXTENSIONS = [".resS", ".resource", ".config", ".xml", ".dat"];

function isNonSerializedEntryName(path: string): boolean {
  return NON_SERIALIZED_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Быстрый накопитель одной строки rd1 (компактный JSON, порядок ключей свой). */
class Line {
  private readonly parts: string[] = [];

  raw(text: string): this {
    this.parts.push(text);
    return this;
  }

  key(name: string): this {
    this.parts.push(`"${name}":`);
    return this;
  }

  str(value: string): this {
    this.parts.push(JSON.stringify(value));
    return this;
  }

  int(value: number): this {
    this.parts.push(String(value));
    return this;
  }

  b64(bytes: Uint8Array): this {
    this.parts.push(JSON.stringify(Buffer.from(bytes).toString("base64")));
    return this;
  }

  toString(): string {
    return this.parts.join("");
  }
}

/**
 * Байтовое ядро на TS: собрать rd1 по тем же правилам, что Rust.
 *
 * Экспортируется для тестов паритета и бенчмарка; рабочий путь дампера —
 * `--decoder rust` (тот же файл, другой исполнитель).
 */
export function writeRawDumpTs(
  targets: RawTarget[],
  outPath: string,
  timings?: RawTimings,
): RawStats {
  const fd = openSync(outPath, "w");
  const stats: RawStats = { files: 0, failed: 0, objects: 0, typedObjects: 0, bytesIn: 0 };
  let buffer: string[] = [];
  let buffered = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    writeSync(fd, `${buffer.join("\n")}\n`);
    buffer = [];
    buffered = 0;
  };
  const push = (line: string): void => {
    buffer.push(line);
    buffered += line.length + 1;
    if (buffered >= 1 << 20) flush();
  };

  try {
    for (const target of targets) {
      const readStarted = performance.now();
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(target.path));
      } catch (err) {
        console.error(`    ERROR: ${target.name}: ${err instanceof Error ? err.message : err}`);
        stats.failed += 1;
        continue;
      }
      if (timings) timings.readMs += performance.now() - readStarted;
      stats.bytesIn += bytes.length;

      const decodeStarted = performance.now();
      if (target.path.toLowerCase().endsWith(".dll")) {
        push(assetLine(target, "dotnet"));
        const heap = findUsHeapSlice(bytes);
        if (heap) {
          push(new Line().raw(`{"t":"us","heap":`).b64(heap).raw("}").toString());
        }
        if (timings) timings.decodeMs += performance.now() - decodeStarted;
        stats.files += 1;
        continue;
      }

      if (isUnityFs(bytes)) {
        let archive: ReturnType<typeof readUnityFs> | null = null;
        try {
          archive = readUnityFs(bytes);
        } catch (err) {
          push(assetLine(target, "unityfs", undefined, err));
          if (timings) timings.decodeMs += performance.now() - decodeStarted;
          stats.failed += 1;
          stats.files += 1;
          continue;
        }
        const warnings: string[] = [];
        const files: Array<{ name: string; sf: SerializedFile }> = [];
        for (const entry of archive.entries) {
          if (isNonSerializedEntryName(entry.path)) continue;
          const body = archive.readEntry(entry);
          if (!isSerializedFile(body)) continue;
          try {
            files.push({ name: entry.path, sf: readSerializedFile(body) });
          } catch (err) {
            warnings.push(`${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (timings) timings.decodeMs += performance.now() - decodeStarted;
        push(assetLine(target, "unityfs", archive.entries));
        for (let index = 0; index < files.length; index++) {
          emitSerializedFile(files[index].sf, index, files[index].name, stats, push, timings);
        }
        if (warnings.length > 0) {
          push(
            new Line()
              .raw(`{"t":"warn","texts":[`)
              .raw(warnings.map((w) => JSON.stringify(w)).join(","))
              .raw("]}")
              .toString(),
          );
        }
        emitFileTail(bytes, push, timings);
        stats.files += 1;
        continue;
      }

      if (isSerializedFile(bytes)) {
        try {
          const sf = readSerializedFile(bytes);
          const name = target.path.split(/[\\/]/).pop() ?? target.name;
          if (timings) timings.decodeMs += performance.now() - decodeStarted;
          push(assetLine(target, "serialized"));
          emitSerializedFile(sf, 0, name, stats, push, timings);
          emitFileTail(bytes, push, timings);
          stats.files += 1;
          continue;
        } catch (err) {
          if (timings) timings.decodeMs += performance.now() - decodeStarted;
          push(assetLine(target, "serialized", undefined, err));
          stats.failed += 1;
          stats.files += 1;
          continue;
        }
      }

      if (timings) timings.decodeMs += performance.now() - decodeStarted;
      const kind: RawAssetKind = target.path.toLowerCase().endsWith(".resource")
        ? "raw"
        : "unknown";
      push(assetLine(target, kind));
      emitFileTail(bytes, push, timings);
      stats.files += 1;
    }
  } finally {
    flush();
    closeSync(fd);
  }

  return stats;
}

function assetLine(
  target: RawTarget,
  kind: RawAssetKind,
  entries?: UnityFsEntry[],
  error?: unknown,
): string {
  const line = new Line().raw(`{"t":"asset","asset":`).str(target.name);
  line.raw(`,"path":`).str(target.path);
  line.raw(`,"kind":`).str(kind);
  if (entries) {
    line.raw(`,"entries":[`);
    entries.forEach((entry, index) => {
      if (index > 0) line.raw(",");
      line.raw(`{"path":`).str(entry.path);
      line.raw(`,"offset":`).int(entry.offset);
      line.raw(`,"size":`).int(entry.size);
      line.raw("}");
    });
    line.raw("]");
  }
  if (error !== undefined) {
    line.raw(`,"error":`).str(error instanceof Error ? error.message : String(error));
  }
  return line.raw("}").toString();
}

function emitSerializedFile(
  sf: SerializedFile,
  index: number,
  name: string,
  stats: RawStats,
  push: (line: string) => void,
  timings?: RawTimings,
): void {
  const header = sf.header;
  push(
    new Line()
      .raw(`{"t":"sf","i":`)
      .int(index)
      .raw(`,"name":`)
      .str(name)
      .raw(`,"unityVersion":`)
      .str(header.unityVersion)
      .raw(`,"headerVersion":`)
      .int(header.version)
      .raw(`,"typeTreeEnabled":`)
      .raw(header.enableTypeTree ? "true" : "false")
      .raw(`,"objectCount":`)
      .int(sf.objects.length)
      .raw(`,"endian":`)
      .str(header.endian)
      .raw("}")
      .toString(),
  );

  // Type tree'ы: blob как есть — разбирает его TS-семантика (parseTypeTree).
  sf.types.forEach((type, typeId) => {
    if (!type.typeTree) return;
    const blob = sf.raw.subarray(type.typeTree.blobStart, type.typeTree.blobEnd);
    push(
      new Line()
        .raw(`{"t":"type","sf":`)
        .int(index)
        .raw(`,"typeId":`)
        .int(typeId)
        .raw(`,"classId":`)
        .int(type.classId)
        .raw(`,"nodeCount":`)
        .int(type.typeTree.nodeCount)
        .raw(`,"stringSize":`)
        .int(type.typeTree.stringBufferSize)
        .raw(`,"blob":`)
        .b64(blob)
        .raw("}")
        .toString(),
    );
  });

  for (const object of sf.objects) {
    const raw = sf.raw.subarray(object.byteStart, object.byteStart + object.byteSize);
    const typed = sf.types[object.typeId]?.typeTree !== undefined;
    const scanStarted = performance.now();
    const rawStrings = scanRawStrings(raw);
    const dialogues = parseDialogueFromRaw(raw);
    const colors = rawStrings.some((item) => item.text === "ColorParserList")
      ? parseColorParserList(raw)
      : null;
    if (timings) timings.scanMs += performance.now() - scanStarted;

    const line = new Line()
      .raw(`{"t":"obj","sf":`)
      .int(index)
      .raw(`,"typeId":`)
      .int(object.typeId)
      .raw(`,"classId":`)
      .int(object.classId)
      .raw(`,"pathId":`)
      .str(object.pathId.toString());
    if (typed) line.raw(`,"raw":`).b64(raw);
    if (rawStrings.length > 0) {
      line.raw(`,"rs":[`);
      rawStrings.forEach((item, at) => {
        if (at > 0) line.raw(",");
        line.str(item.text);
      });
      line.raw("]");
    }
    if (dialogues.length > 0) {
      line.raw(`,"dl":[`);
      dialogues.forEach((dialogue, at) => {
        if (at > 0) line.raw(",");
        line.raw(`{"offset":`).int(dialogue.offset);
        line.raw(`,"speaker":`).str(dialogue.speaker);
        line.raw(`,"text":`).str(dialogue.text);
        line.raw(`,"rich_text":`).str(dialogue.rich_text);
        line.raw("}");
      });
      line.raw("]");
    }
    if (colors) {
      line.raw(`,"cpl":{`);
      Object.entries(colors).forEach(([colorName, hex], at) => {
        if (at > 0) line.raw(",");
        line.str(colorName);
        line.raw(":");
        line.str(hex);
      });
      line.raw("}");
    }
    push(line.raw("}").toString());

    stats.objects += 1;
    if (typed) stats.typedObjects += 1;
  }
}

/** Хвост файла: сканы целого файла (ключи настроек и печатные строки). */
function emitFileTail(bytes: Uint8Array, push: (line: string) => void, timings?: RawTimings): void {
  const started = performance.now();
  const settings = scanSettingsKeys(bytes);
  const runs = scanRuns(bytes);
  if (timings) timings.runsMs += performance.now() - started;

  if (runs.length > 0) {
    const line = new Line().raw(`{"t":"runs","texts":[`);
    runs.forEach((text, index) => {
      if (index > 0) line.raw(",");
      line.str(text);
    });
    push(line.raw("]}").toString());
  }
  if (settings.length > 0) {
    push(settingsLine(settings));
  }
}

const ASCII_DECODER = new TextDecoder("ascii");

/** Уникальные печатные ASCII-строки файла (порт `scan_global_strings`+дедуп). */
function scanRuns(data: Uint8Array): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const n = data.length;
  let i = 0;
  while (i < n) {
    if (data[i] >= 32 && data[i] <= 126) {
      const start = i;
      while (i < n && data[i] >= 32 && data[i] <= 126) i += 1;
      const text = pyStrip(ASCII_DECODER.decode(data.subarray(start, i)));
      if (!seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    } else {
      i += 1;
    }
  }
  return out;
}

function settingsLine(settings: SettingKey[]): string {
  const line = new Line().raw(`{"t":"keys","keys":[`);
  settings.forEach((item, index) => {
    if (index > 0) line.raw(",");
    line.raw(`{"key":`).str(item.key);
    line.raw(`,"display":`).str(item.display);
    line.raw("}");
  });
  return line.raw("]}").toString();
}

/** Куча `#US` из .NET-сборки (или null, если её нет). */
function findUsHeapSlice(bytes: Uint8Array): Uint8Array | null {
  const heap = findDotnetUsHeap(bytes);
  if (!heap) return null;
  return bytes.subarray(heap[0], Math.min(heap[0] + heap[1], bytes.length));
}

// ---------------------------------------------------------------- Rust-декодер

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
 * процесса Rust: без него бенчмарк не может честно разделить фазы.
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
  // Итоги берём из отчёта (или из самого rd1 — адаптер пересчитает).
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

/** Корень репозитория: scripts → dump-assets → skills → .opencode → корень. */
export const RAWDUMP_REPO_ROOT = resolve(import.meta.dirname, "../../../..");
