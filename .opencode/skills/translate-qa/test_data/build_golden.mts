/**
 * build_golden.mts — пересборка входов и золотого отчёта QA.
 *
 * Золото (`.opencode/skills/translate-qa/test_data/qa-golden-<lang>.json`) —
 * ОРАКУЛ: с ним сверяется Rust-движок (`tests/qa_golden.test.mts`). Снято
 * 2026-11-24 с TS-эталона (`qa_translate.mts`, коммит `ed8657e`) и тогда же
 * подтверждено побайтовое совпадение отчётов TS и Rust; после удаления эталона
 * TS-стороны больше нет — пересборка золота означает «принять новый базис».
 *
 * Что делает: берёт срез ТЕКУЩЕГО корпуса в `fixture-<lang>/` (все строки,
 * дающие находки, плюс сэмпл «чистых» для статистики покрытия) и пишет отчёт
 * от Rust. Фикстура нужна, потому что живой `po/` меняется каждый день:
 * тест на нём был бы красным по чужой работе, а не по регрессу QA.
 *
 * Пересобирать ТОЛЬКО осознанно (изменились правила QA или состав корпуса
 * и старый базис устарел): дифф золота в git — это и есть ревью изменения.
 *
 * Запуск: node .opencode/skills/translate-qa/test_data/build_golden.mts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { parsePo, renderPo, type PoEntry } from "../../extract-text/scripts/po_file.mts";
import { rustQaBinary } from "../../../../scripts/qa.mts";
import { REPO_ROOT } from "../../../../scripts/languages.mts";

const DATA = import.meta.dirname;
const LANGS = ["ru", "de"];

interface DatRow {
  t?: string;
  x?: string;
  r?: string;
  rt?: string;
  sk?: boolean;
}

/** Строки `.dat` (JSONL); битые пропускаем — как движок. */
function loadDat(lang: string): DatRow[] {
  const rows: DatRow[] = [];
  for (const line of readFileSync(join(REPO_ROOT, "runtime", `patch_${lang}.dat`), "utf8").split(
    /\r\n|\r|\n/,
  )) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as DatRow);
    } catch {
      /* битая строка */
    }
  }
  return rows;
}

/** Отчёт Rust по живому корпусу — источник «какие строки дают находки». */
function liveFindings(lang: string, bin: string): Set<string> {
  const tmp = join(REPO_ROOT, "tmp");
  mkdirSync(tmp, { recursive: true });
  const out = join(tmp, `qa-golden-source-${lang}.json`);
  const run = spawnSync(bin, ["--root", REPO_ROOT, "--lang", lang, "--json", out, "--quiet"]);
  if (run.status !== 0 && run.status !== 1) throw new Error(`rust-qa упал на ${lang}`);
  const report = JSON.parse(readFileSync(out, "utf8")) as { findings: Array<{ text: string }> };
  rmSync(out, { force: true });
  return new Set(report.findings.map((f) => f.text));
}

function build(lang: string, bin: string): void {
  const pot = parsePo(readFileSync(join(REPO_ROOT, "po", "template.pot"), "utf8")).filter(
    (e) => e.msgid,
  );
  const dat = loadDat(lang);
  const po = parsePo(readFileSync(join(REPO_ROOT, "po", `${lang}.po`), "utf8")).filter(
    (e) => e.msgid,
  );
  const hit = liveFindings(lang, bin);

  // Отбор: все строки с находками + сэмпл чистых (шаг 41) + по 4 строки каждого
  // исключающего флага (legacy / no-translate / skip) — их поведение тоже контракт.
  const picked = new Set<number>();
  const flagged = new Map<string, number>();
  pot.forEach((e, i) => {
    if (hit.has(e.msgid)) picked.add(i);
    if (i % 41 === 0) picked.add(i);
    for (const f of e.flags) {
      if (!["no-translate", "skip", "legacy"].includes(f)) continue;
      const n = flagged.get(f) ?? 0;
      if (n < 4) {
        picked.add(i);
        flagged.set(f, n + 1);
      }
    }
  });

  const rows = [...picked].sort((a, b) => a - b).map((i) => pot[i]);
  const texts = new Set(rows.map((e) => e.msgid));

  const root = join(DATA, `fixture-${lang}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "po"), { recursive: true });
  mkdirSync(join(root, "runtime"), { recursive: true });

  writeFileSync(join(root, "po", "template.pot"), renderPo(rows, []), "utf8");
  writeFileSync(
    join(root, "runtime", `patch_${lang}.dat`),
    dat
      .filter((r) => r.t && texts.has(r.t))
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
    "utf8",
  );
  const poRows: PoEntry[] = po.filter((e) => texts.has(e.msgid));
  writeFileSync(join(root, "po", `${lang}.po`), renderPo(poRows, []), "utf8");

  const tmpOut = join(REPO_ROOT, "tmp", `qa-golden-build-${lang}.json`);
  const run = spawnSync(bin, ["--root", root, "--lang", lang, "--json", tmpOut, "--quiet"]);
  if (run.status !== 0 && run.status !== 1) throw new Error(`rust-qa упал на фикстуре ${lang}`);
  const report = JSON.parse(readFileSync(tmpOut, "utf8"));
  rmSync(tmpOut, { force: true });

  const golden = join(DATA, `qa-golden-${lang}.json`);
  writeFileSync(golden, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const size = (p: string): string => `${(readFileSync(p).length / 1024).toFixed(0)} КБ`;
  console.log(
    `${lang}: фикстура ${rows.length} записей, находок ${report.findings.length}, ` +
      `золото ${size(golden)} (POT ${size(join(root, "po", "template.pot"))}, ` +
      `PO ${size(join(root, "po", `${lang}.po`))}, DAT ${size(join(root, "runtime", `patch_${lang}.dat`))})`,
  );
}

const bin = rustQaBinary(REPO_ROOT);
if (!bin) {
  console.error("rust-qa не собран. Соберите: npm run qa:build");
  process.exitCode = 2;
} else {
  for (const lang of LANGS) build(lang, bin);
}
