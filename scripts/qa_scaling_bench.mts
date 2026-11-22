/**
 * qa_scaling_bench.mts — замер масштабирования QA перевода: TS-эталон против Rust.
 *
 * Задача не «кто быстрее на 40 тысячах строк», а «что будет на корпусе в 10 и
 * 100 раз больше» (следующая новелла). Поэтому:
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
 * Замер: каждый инструмент — отдельным процессом (иначе старт Node смешается
 * с работой), wall time вокруг `spawnSync`, два прогона на точку. МБ/с —
 * входные байты (POT + PO + DAT) на время процесса: это то, что видит
 * пользователь CLI, включая старт рантайма.
 *
 * Гейт: отчёты TS и Rust на каждой точке обязаны совпасть ПОБАЙТОВО (JSON
 * со сводкой и находками). Расхождение = код 1.
 *
 * CLI:
 *   node scripts/qa_scaling_bench.mts [--scales 1,10,100] [--runs 2]
 *        [--lang ru] [--parity-langs ru,de] [--regen]
 *   node scripts/qa_scaling_bench.mts --worker ts --root <dir> --lang ru --out <json>
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
import { check } from "../.opencode/skills/translate-qa/scripts/qa_translate.mts";

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
  tsMs: number[];
  rustMs: number[];
  findings: number;
  parity: boolean;
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

/** TS-исполнитель в отдельном процессе: тот же отчёт, что пишет Rust. */
function tsWorker(argv: string[]): number {
  const root = resolve(argValue(argv, "--root") ?? REPO_ROOT);
  const lang = argValue(argv, "--lang") ?? "ru";
  const out = resolve(argValue(argv, "--out") ?? join(BENCH_ROOT, "ts.json"));
  const { summary, findings } = check(lang, root);
  const report = {
    lang,
    summary: {
      total: summary.total,
      filled: summary.filled,
      coverage: summary.coverage,
      errors: summary.errors,
      warnings: summary.warnings,
      by_speaker: [...summary.bySpeaker],
      by_dir: [...summary.byDir],
    },
    findings,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report), "utf8");
  return 0;
}

/** Heap для TS-процесса: 100× (4 млн записей) в дефолтные ~4 ГБ не влезает. */
let tsHeapMb = 8192;

function runTool(tool: "ts" | "rust", root: string, lang: string, out: string): number {
  const started = performance.now();
  const child =
    tool === "ts"
      ? spawnSync(
          process.execPath,
          [import.meta.filename, "--worker", "ts", "--root", root, "--lang", lang, "--out", out],
          // 100× (4 млн записей) в дефолтные ~4 ГБ heap не влезает: Node падает.
          // Это часть результата (Rust таких флагов не требует), но чтобы
          // измерить ВРЕМЯ TS, даём ему заведомо достаточный heap.
          { env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${tsHeapMb}` } },
        )
      : spawnSync(RUST_BIN, ["--root", root, "--lang", lang, "--json", out, "--quiet"]);
  const ms = performance.now() - started;
  // У rust-qa код 1 = «есть error-находки» (как у TS-эталона), это не падение.
  if (child.status !== 0 && child.status !== 1) {
    throw new Error(
      `${tool} упал (код ${child.status}): ${String(child.stderr ?? "").slice(0, 500)}`,
    );
  }
  return ms;
}

function compareReports(left: string, right: string): { same: boolean; detail: string } {
  if (!existsSync(left) || !existsSync(right)) return { same: false, detail: "нет отчёта" };
  const a = readFileSync(left);
  const b = readFileSync(right);
  if (a.equals(b)) return { same: true, detail: `${a.length} байт побайтово` };
  const leftLines = a.toString("utf8").split("\n");
  const rightLines = b.toString("utf8").split("\n");
  for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
    if (leftLines[i] !== rightLines[i]) {
      return {
        same: false,
        detail: `строка ${i + 1}: TS=${String(leftLines[i]).slice(0, 160)} RUST=${String(rightLines[i]).slice(0, 160)}`,
      };
    }
  }
  return { same: false, detail: "содержимое различается" };
}

function mbps(bytes: number, ms: number): number {
  return bytes / 2 ** 20 / (ms / 1000);
}

function printTable(rows: Measurement[]): void {
  const header =
    "| Объём | Вход, МБ | TS, мс (1/2) | Rust, мс (1/2) | × (1/2) | TS, МБ/с | Rust, МБ/с | Находок | Паритет |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const lines = rows.map((m) => {
    const ratio1 = m.tsMs[0] / m.rustMs[0];
    const ratio2 = m.tsMs[1] / m.rustMs[1];
    return (
      `| ${m.scale}× ${m.lang} | ${(m.inputBytes / 2 ** 20).toFixed(1)} | ` +
      `${m.tsMs[0].toFixed(0)} / ${m.tsMs[1].toFixed(0)} | ` +
      `${m.rustMs[0].toFixed(0)} / ${m.rustMs[1].toFixed(0)} | ` +
      `${ratio1.toFixed(2)} / ${ratio2.toFixed(2)} | ` +
      `${mbps(m.inputBytes, m.tsMs[1]).toFixed(1)} | ` +
      `${mbps(m.inputBytes, m.rustMs[1]).toFixed(1)} | ` +
      `${m.findings} | ${m.parity ? "OK" : "РАСХОЖДЕНИЕ"} |`
    );
  });
  console.log(`\n${header}\n${sep}\n${lines.join("\n")}`);
}

function main(argv: string[]): number {
  if (argv.includes("--worker")) return tsWorker(argv);

  if (!existsSync(RUST_BIN)) {
    console.error(
      `нет бинаря Rust: ${RUST_BIN}\nсоберите: cd tools/rust-qa && cargo build --release`,
    );
    return 2;
  }

  const regen = argv.includes("--regen");
  const runs = Number(argValue(argv, "--runs") ?? 2);
  tsHeapMb = Number(argValue(argv, "--ts-heap-mb") ?? 8192);
  const lang = argValue(argv, "--lang") ?? "ru";
  const parityLangs = (argValue(argv, "--parity-langs") ?? "ru,de")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const scales = (argValue(argv, "--scales") ?? "1,10,100")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 1);

  mkdirSync(BENCH_ROOT, { recursive: true });
  const results: Measurement[] = [];
  let parityOk = true;

  // Паритет на реальных данных — отдельно по каждому языку (гейт задачи).
  console.log("Паритет на текущих данных:");
  for (const parityLang of parityLangs) {
    const outDir = join(BENCH_ROOT, "parity");
    const tsOut = join(outDir, `ts-${parityLang}.json`);
    const rustOut = join(outDir, `rust-${parityLang}.json`);
    runTool("ts", REPO_ROOT, parityLang, tsOut);
    runTool("rust", REPO_ROOT, parityLang, rustOut);
    const cmp = compareReports(tsOut, rustOut);
    parityOk &&= cmp.same;
    const report = JSON.parse(readFileSync(rustOut, "utf8")) as {
      summary: { filled: number; total: number; errors: number; warnings: number };
      findings: unknown[];
    };
    const s = report.summary;
    console.log(
      `  ${parityLang}: ${s.filled}/${s.total}, errors=${s.errors}, warnings=${s.warnings}, ` +
        `находок=${report.findings.length} — ${cmp.same ? "побайтово OK" : `РАСХОЖДЕНИЕ (${cmp.detail})`}`,
    );
  }

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
    const tsMs: number[] = [];
    const rustMs: number[] = [];
    for (let run = 1; run <= runs; run++) {
      tsMs.push(runTool("ts", prepared.root, lang, join(outDir, `ts-${run}.json`)));
      rustMs.push(runTool("rust", prepared.root, lang, join(outDir, `rust-${run}.json`)));
    }
    const cmp = compareReports(join(outDir, "ts-1.json"), join(outDir, "rust-1.json"));
    parityOk &&= cmp.same;
    // Второй прогон тоже обязан совпасть (детерминизм, а не кэш).
    const cmp2 = compareReports(join(outDir, "ts-2.json"), join(outDir, "rust-2.json"));
    parityOk &&= cmp2.same;
    const report = JSON.parse(readFileSync(join(outDir, "rust-1.json"), "utf8")) as {
      findings: unknown[];
    };
    results.push({
      scale,
      lang,
      inputBytes: prepared.bytes,
      tsMs,
      rustMs,
      findings: report.findings.length,
      parity: cmp.same && cmp2.same,
    });
    console.log(
      `  ${scale}×: паритет ${cmp.same && cmp2.same ? "OK" : "РАСХОЖДЕНИЕ"} — ${cmp.detail}`,
    );
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
        langs: { bench: lang, parity: parityLangs },
        runs,
        results,
        parityOk,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\nрезультат: ${outPath}`);
  return parityOk ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
