/**
 * qa_scaling_bench.mts — замер масштабирования QA перевода на Rust.
 *
 * Задача не «сколько миллисекунд на 40 тысячах строк», а «что будет на корпусе
 * в 10 и 100 раз больше» (следующая новелла). Поэтому:
 *
 *   1×   — текущие данные из репозитория (как есть);
 *   10×  — синтетика: каждая запись POT повторена 10 раз с уникальным ключом;
 *   100× — то же на 100 повторений.
 *
 * Синтетика генерируется в `tmp/qa-bench/<n>x/` (в git не попадает) самим
 * скриптом: `po/template.pot`, `po/<lang>.po`, `runtime/patch_<lang>.dat` с той
 * же структурой, что у настоящих. Уникальность: к `msgid` дописывается `~k`
 * (не-буквенный хвост — не меняет долю кириллицы), для не-спикерских
 * `msgctxt` — тоже `~k`, чтобы ключ `(msgctxt, msgid)` не мог схлопнуться.
 *
 * Замер: движок — отдельным процессом (стенд не смешивает своё время с работой),
 * wall time вокруг `spawnSync`, два прогона на точку. МБ/с — входные байты
 * (POT + PO + DAT) на время процесса: это то, что видит пользователь CLI.
 *
 * Гейт детерминизма: два прогона на точке обязаны дать побайтово одинаковый
 * отчёт (иначе порядок находок не воспроизводим). Расхождение = код 1.
 *
 * Эталон-оракул — не этот стенд, а золотой отчёт
 * (`.opencode/skills/translate-qa/test_data/qa-golden-<lang>.json`).
 *
 * CLI:
 *   node scripts/qa_scaling_bench.mts [--scales 1,10,100] [--runs 2]
 *        [--lang ru] [--regen]
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { parsePo, poEscape } from "../.opencode/skills/extract-text/scripts/po_file.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "..");
const BENCH_ROOT = join(REPO_ROOT, "tmp", "qa-bench");
const RUST_BIN = join(
  REPO_ROOT,
  "tools",
  "rust-qa",
  "target",
  "release",
  process.platform === "win32" ? "rust-qa.exe" : "rust-qa",
);

interface RawDatRow {
  t?: string;
  x?: string;
  r?: string;
  rt?: string;
  sk?: boolean;
}

interface Measurement {
  scale: number;
  lang: string;
  inputBytes: number;
  rustMs: number[];
  findings: number;
  deterministic: boolean;
}

function argValue(argv: string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
    if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
  }
  return null;
}

/** Буферизованная запись больших файлов: 100× — это сотни МБ, копить их в строке нельзя. */
class ChunkWriter {
  private chunks: string[] = [];
  private pending = 0;
  private bytes = 0;
  private fd: number;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "w");
  }

  write(text: string): void {
    this.chunks.push(text);
    this.pending += text.length;
    if (this.pending > 4 << 20) this.flush();
  }

  private flush(): void {
    if (this.chunks.length === 0) return;
    const buf = Buffer.from(this.chunks.join(""), "utf8");
    writeSync(this.fd, buf);
    this.bytes += buf.length;
    this.chunks = [];
    this.pending = 0;
  }

  close(): number {
    this.flush();
    closeSync(this.fd);
    return this.bytes;
  }
}

/** Хвост `~k` не содержит букв: доля кириллицы и «латиница» от него не меняются. */
function variantSuffix(k: number): string {
  return `~${k}`;
}

function baseSizes(lang: string): Record<string, number> {
  const files = {
    pot: join(REPO_ROOT, "po", "template.pot"),
    po: join(REPO_ROOT, "po", `${lang}.po`),
    dat: join(REPO_ROOT, "runtime", `patch_${lang}.dat`),
  };
  const sizes: Record<string, number> = {};
  for (const [key, path] of Object.entries(files)) {
    sizes[key] = existsSync(path) ? statSync(path).size : 0;
  }
  return sizes;
}

/**
 * Сгенерировать раскладку для `scale` (>=2) или вернуть кэш.
 * `1×` не генерируется: это настоящие файлы репозитория.
 */
function prepareScale(
  scale: number,
  lang: string,
  regen: boolean,
): { root: string; bytes: number } {
  const root = join(BENCH_ROOT, `${scale}x`);
  const paths = {
    pot: join(root, "po", "template.pot"),
    po: join(root, "po", `${lang}.po`),
    dat: join(root, "runtime", `patch_${lang}.dat`),
  };
  const metaPath = join(root, "meta.json");
  const base = baseSizes(lang);
  if (!regen && existsSync(metaPath) && Object.values(paths).every((p) => existsSync(p))) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
        scale: number;
        lang: string;
        base: Record<string, number>;
        files: Record<string, number>;
      };
      const sameBase = Object.keys(base).every((k) => meta.base[k] === base[k]);
      const sameFiles = Object.entries(paths).every(([k, p]) => meta.files[k] === statSync(p).size);
      if (meta.scale === scale && meta.lang === lang && sameBase && sameFiles) {
        return {
          root,
          bytes: statSync(paths.pot).size + statSync(paths.po).size + statSync(paths.dat).size,
        };
      }
    } catch {
      // битый meta — перегенерируем
    }
  }

  const basePot = parsePo(readFileSync(join(REPO_ROOT, "po", "template.pot"), "utf8")).filter(
    (e) => e.msgid,
  );
  const rows = new Map<string, RawDatRow>();
  const datPath = join(REPO_ROOT, "runtime", `patch_${lang}.dat`);
  if (existsSync(datPath)) {
    for (const line of readFileSync(datPath, "utf8").split(/\r\n|\r|\n/)) {
      if (!line.trim()) continue;
      let row: RawDatRow;
      try {
        row = JSON.parse(line) as RawDatRow;
      } catch {
        continue;
      }
      if (row.t && !rows.has(row.t)) rows.set(row.t, row);
    }
  }

  const potWriter = new ChunkWriter(paths.pot);
  const poWriter = new ChunkWriter(paths.po);
  const datWriter = new ChunkWriter(paths.dat);
  const header = `msgid ""\nmsgstr ""\n"Project-Id-Version: qa-bench synthetic\\n"\n\n`;
  potWriter.write(header);
  poWriter.write(
    `msgid ""\nmsgstr "Project-Id-Version: qa-bench synthetic\\nContent-Type: text/plain; charset=UTF-8\\n"\n\n`,
  );

  for (const e of basePot) {
    const row = rows.get(e.msgid);
    const keepSpeaker = e.msgctxt.startsWith("speaker:");
    for (let k = 0; k < scale; k++) {
      const suffix = variantSuffix(k);
      const id = `${e.msgid}${suffix}`;
      const ctxt = keepSpeaker || !e.msgctxt ? e.msgctxt : `${e.msgctxt}${suffix}`;
      const flags = e.flags.length ? `#, ${e.flags.join(", ")}\n` : "";
      const ctxtLine = ctxt ? `msgctxt "${poEscape(ctxt)}"\n` : "";
      potWriter.write(`${flags}${ctxtLine}msgid "${poEscape(id)}"\nmsgstr ""\n\n`);

      const tr = row?.x ? `${row.x}${suffix}` : "";
      poWriter.write(`${flags}${ctxtLine}msgid "${poEscape(id)}"\nmsgstr "${poEscape(tr)}"\n\n`);

      if (row) {
        const out: RawDatRow = { t: id, x: tr };
        if (row.r) out.r = row.r;
        if (row.rt) out.rt = row.rt;
        if (row.sk) out.sk = true;
        datWriter.write(`${JSON.stringify(out)}\n`);
      }
    }
  }
  const files = {
    pot: potWriter.close(),
    po: poWriter.close(),
    dat: datWriter.close(),
  };
  writeFileSync(metaPath, `${JSON.stringify({ scale, lang, base, files }, null, 2)}\n`, "utf8");
  console.log(
    `  сгенерировано ${scale}×: POT ${(files.pot / 2 ** 20).toFixed(1)} МБ, ` +
      `PO ${(files.po / 2 ** 20).toFixed(1)} МБ, DAT ${(files.dat / 2 ** 20).toFixed(1)} МБ`,
  );
  return { root, bytes: files.pot + files.po + files.dat };
}

/** Прогон движка отдельным процессом; код 1 = «есть error-находки», не падение. */
function runTool(root: string, lang: string, out: string): number {
  const started = performance.now();
  const child = spawnSync(RUST_BIN, ["--root", root, "--lang", lang, "--json", out, "--quiet"]);
  const ms = performance.now() - started;
  if (child.status !== 0 && child.status !== 1) {
    throw new Error(
      `rust-qa упал (код ${child.status}): ${String(child.stderr ?? "").slice(0, 500)}`,
    );
  }
  return ms;
}

function mbps(bytes: number, ms: number): number {
  return bytes / 2 ** 20 / (ms / 1000);
}

function printTable(rows: Measurement[]): void {
  const header = "| Объём | Вход, МБ | Прогоны, мс | МБ/с | Находок | Детерминизм |";
  const sep = "| --- | --- | --- | --- | --- | --- |";
  const lines = rows.map((m) => {
    return (
      `| ${m.scale}× ${m.lang} | ${(m.inputBytes / 2 ** 20).toFixed(1)} | ` +
      `${m.rustMs.map((ms) => ms.toFixed(0)).join(" / ")} | ` +
      `${mbps(m.inputBytes, m.rustMs[m.rustMs.length - 1]).toFixed(1)} | ` +
      `${m.findings} | ${m.deterministic ? "OK" : "РАСХОЖДЕНИЕ"} |`
    );
  });
  console.log(`\n${header}\n${sep}\n${lines.join("\n")}`);
}

function main(argv: string[]): number {
  if (!existsSync(RUST_BIN)) {
    console.error(
      `нет бинаря Rust: ${RUST_BIN}\nсоберите: cd tools/rust-qa && cargo build --release`,
    );
    return 2;
  }

  const regen = argv.includes("--regen");
  const runs = Number(argValue(argv, "--runs") ?? 2);
  const lang = argValue(argv, "--lang") ?? "ru";
  const scales = (argValue(argv, "--scales") ?? "1,10,100")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 1);

  mkdirSync(BENCH_ROOT, { recursive: true });
  const results: Measurement[] = [];
  let deterministic = true;

  for (const scale of scales) {
    const prepared =
      scale === 1
        ? {
            root: REPO_ROOT,
            bytes:
              statSync(join(REPO_ROOT, "po", "template.pot")).size +
              statSync(join(REPO_ROOT, "po", `${lang}.po`)).size +
              (existsSync(join(REPO_ROOT, "runtime", `patch_${lang}.dat`))
                ? statSync(join(REPO_ROOT, "runtime", `patch_${lang}.dat`)).size
                : 0),
          }
        : prepareScale(scale, lang, regen);

    const outDir = join(BENCH_ROOT, "out", `${scale}x-${lang}`);
    mkdirSync(outDir, { recursive: true }); // rust-qa каталоги не создаёт
    const rustMs: number[] = [];
    const outs: string[] = [];
    for (let run = 1; run <= runs; run++) {
      const out = join(outDir, `rust-${run}.json`);
      rustMs.push(runTool(prepared.root, lang, out));
      outs.push(out);
    }
    // Детерминизм: повторный прогон обязан дать тот же отчёт.
    const same = runs < 2 || readFileSync(outs[0]).equals(readFileSync(outs[outs.length - 1]));
    deterministic &&= same;
    const report = JSON.parse(readFileSync(outs[0], "utf8")) as { findings: unknown[] };
    results.push({
      scale,
      lang,
      inputBytes: prepared.bytes,
      rustMs,
      findings: report.findings.length,
      deterministic: same,
    });
    console.log(`  ${scale}×: детерминизм ${same ? "OK" : "РАСХОЖДЕНИЕ"}`);
  }

  printTable(results);
  const outPath = join(BENCH_ROOT, "results.json");
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        generated: new Date().toISOString(),
        node: process.version,
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? "?",
        ramGb: Math.round(totalmem() / 2 ** 30),
        lang,
        runs,
        results,
        deterministic,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\nрезультат: ${outPath}`);
  return deterministic ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
