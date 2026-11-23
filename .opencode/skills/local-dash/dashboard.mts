/**
 * dashboard.mts — локальная страница «что сейчас происходит» для TCNN.
 *
 * Одна страница без сборки и зависимостей: Node stdlib + файлы репозитория.
 * Открыть http://127.0.0.1:8088 и смотреть: идёт ли прогон, сколько строк
 * переведено и с какой скоростью, что с моделью/GPU, здоров ли POT.
 *
 * Источники — только существующие артефакты (никаких вторых счётчиков):
 *   po/*.po                     — прогресс по языкам (parsePo)
 *   tmp/translate-local/run.out — позиция прогона и хвост лога
 *   tmp/translate-local/PAUSE   — пауза
 *   config/language-priority.json — порядок языков
 *   tmp/pot-skip.jsonl, tmp/pot-excluded.jsonl — отчёт политик
 *   lms ps / nvidia-smi         — модель и VRAM (если есть)
 *
 * Запуск: node .opencode/skills/local-dash/dashboard.mts [--port 8088]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { parsePo } from "../extract-text/scripts/po_file.mts";
import { auditLang } from "../../../scripts/rt_audit.mts";

export const REPO = join(import.meta.dirname, "..", "..", "..");
const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : 8088;
})();

const PO_DIR = join(REPO, "po");
const RUN_LOG = join(REPO, "tmp", "translate-local", "run.out");
const PAUSE = join(REPO, "tmp", "translate-local", "PAUSE");
const REVIEW = join(REPO, "tmp", "translate-local", "ru.review");
const RATE = join(REPO, "tmp", "dash-rate.json");
const PRIORITY = join(REPO, "config", "language-priority.json");

/** Порядок языков из единого источника (en нет в po). */
function langOrder(): string[] {
  try {
    const cfg = JSON.parse(readFileSync(PRIORITY, "utf8")) as { languages: { code: string }[] };
    return cfg.languages.map((l) => l.code).filter((c) => c !== "en");
  } catch {
    return ["zh", "ru", "es", "pt", "de", "ja", "fr", "pl", "ko", "it"];
  }
}

interface LangStat {
  lang: string;
  entries: number;
  translated: number;
  empty: number;
  skip: number;
}

/** Прогресс по одному PO: переведено / пусто / skip. */
export function langStat(lang: string): LangStat {
  const path = join(PO_DIR, `${lang}.po`);
  if (!existsSync(path)) return { lang, entries: 0, translated: 0, empty: 0, skip: 0 };
  const entries = parsePo(readFileSync(path, "utf8")).filter((e) => e.msgid);
  let translated = 0;
  let empty = 0;
  let skip = 0;
  for (const e of entries) {
    if (e.flags.includes("skip")) skip += 1;
    else if (e.msgstr) translated += 1;
    else empty += 1;
  }
  return { lang, entries: entries.length, translated, empty, skip };
}

/** Хвост лога прогона (последние n строк). */
export function tail(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-n);
}

/** Позиция прогона из последней строки `pos=N/M`. */
export function runPosition(lines: string[]): { pos: number; total: number } | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /pos=(\d+)\/(\d+)/.exec(lines[i]);
    if (m) return { pos: Number(m[1]), total: Number(m[2]) };
  }
  const r = /RESULT done=(\d+)/.exec(lines.join("\n"));
  return r ? { pos: Number(r[1]), total: 0 } : null;
}

/**
 * Скорость: дельта позиции между опросами страницы.
 *
 * Считаем по сохранённой точке (файл), поэтому переживает перезапуск дашборда;
 * если позиция уменьшилась (новый прогон) — начинаем заново.
 */
export function trackRate(
  pos: number,
  now = Date.now(),
): { perMin: number; etaMin: number | null } {
  let prev: { t: number; pos: number } | null = null;
  try {
    prev = JSON.parse(readFileSync(RATE, "utf8")) as { t: number; pos: number };
  } catch {
    prev = null;
  }
  let perMin = 0;
  if (prev && now > prev.t && pos >= prev.pos) {
    const dPos = pos - prev.pos;
    const dMin = (now - prev.t) / 60_000;
    if (dMin >= 5 / 60) perMin = dPos / dMin;
  }
  writeFileSync(RATE, JSON.stringify({ t: now, pos }), "utf8");
  return { perMin, etaMin: null };
}

/** Идёт ли прогон переводчика (по командной строке процесса). */
export function translatorPids(): number[] {
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*translate_local*' } | ForEach-Object { $_.ProcessId })",
    ],
    { encoding: "utf8", timeout: 8000 },
  );
  return (r.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Загруженная модель LM Studio (или null). */
function modelInfo(): { loaded: string | null; detail: string } {
  const bin = process.platform === "win32" ? "lms.exe" : "lms";
  const r = spawnSync(bin, ["ps"], { encoding: "utf8", timeout: 8000 });
  const out = r.stdout ?? "";
  if (!out || /No models are currently loaded/i.test(out)) return { loaded: null, detail: "" };
  const rows = out.split(/\r?\n/).filter((l) => /index-translate|qwen|glm|Strata/i.test(l));
  const row = rows[0] ?? out.split(/\r?\n/).find((l) => /GB|GiB/.test(l)) ?? "";
  return { loaded: row ? (row.split(/\s{2,}/)[0] ?? "loaded") : "loaded", detail: row.trim() };
}

/** VRAM/CPU: nvidia-smi, если есть; иначе прочерк. */
function gpuInfo(): { name: string; used: number; total: number; util: number } | null {
  const r = spawnSync(
    "nvidia-smi",
    ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
    { encoding: "utf8", timeout: 4000 },
  );
  const line = (r.stdout ?? "").trim().split(/\r?\n/)[0];
  if (!line) return null;
  const [name, used, total, util] = line.split(", ");
  return {
    name: name ?? "",
    used: Number(used),
    total: Number(total),
    util: Number(util),
  };
}

/** Здоровье POT: записи, skip по правилам, repaired, вырезанные. */
export function potHealth(): {
  entries: number;
  skip: number;
  byRule: Record<string, number>;
  repaired: number;
  excluded: number;
} {
  const text = existsSync(join(REPO, "po", "template.pot"))
    ? readFileSync(join(REPO, "po", "template.pot"), "utf8")
    : "";
  const entries = (text.match(/^msgid "/gm) ?? []).length - 1; // минус заголовок
  const byRule: Record<string, number> = {};
  for (const m of text.matchAll(/^#\. skip: (.+)$/gm)) {
    byRule[m[1]] = (byRule[m[1]] ?? 0) + 1;
  }
  const skip = Object.values(byRule).reduce((a, b) => a + b, 0);
  const repaired = (text.match(/^#\. repaired: /gm) ?? []).length;
  let excluded = 0;
  try {
    excluded = readFileSync(join(REPO, "tmp", "pot-excluded.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean).length;
  } catch {
    excluded = 0;
  }
  return { entries, skip, byRule, repaired, excluded };
}

const fmt = (n: number): string => n.toLocaleString("ru-RU");

function page(): string {
  const langs = langOrder().map(langStat);
  const lines = tail(RUN_LOG, 200);
  const pos = runPosition(lines);
  const running = translatorPids();
  const paused = existsSync(PAUSE);
  const model = modelInfo();
  const gpu = gpuInfo();
  const pot = potHealth();
  const reviewed = existsSync(REVIEW)
    ? readFileSync(REVIEW, "utf8")
        .split(/\r?\n/)
        .filter((l) => /UNPARSABLE|BANNED|LEAK|EMPTY|TAG/.test(l))
    : [];
  const ru = langs.find((l) => l.lang === "ru");
  const rate = pos && ru ? trackRate(pos.pos) : { perMin: 0, etaMin: null };
  const etaH =
    pos && pos.total > pos.pos && rate.perMin > 0
      ? ((pos.total - pos.pos) / rate.perMin / 60).toFixed(1)
      : "—";

  const state = running.length
    ? paused
      ? "⏸ пауза (PAUSE), процесс жив"
      : "▶ идёт перевод"
    : "■ прогон не запущен";

  const bar = (done: number, total: number): string => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="bar"><div style="width:${pct}%"></div><span>${pct}%</span></div>`;
  };

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>TCNN · что происходит</title>
<style>
 body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#14161a;color:#e6e6e6}
 h1{font-size:20px;margin:0 0 12px} h2{font-size:15px;margin:22px 0 8px;color:#9ad}
 .card{background:#1c1f25;border:1px solid #2a2f38;border-radius:8px;padding:12px 14px;margin:10px 0}
 .row{display:flex;gap:18px;flex-wrap:wrap}
 .kv{min-width:180px} .kv b{display:block;color:#8fa;font-size:18px}
 table{border-collapse:collapse;width:100%} td,th{padding:4px 8px;text-align:left;border-bottom:1px solid #262b33}
 th{color:#8aa;font-weight:600;font-size:12px;text-transform:uppercase}
 .bar{position:relative;background:#262b33;border-radius:4px;height:14px;min-width:160px}
 .bar>div{height:14px;background:#3a7;border-radius:4px} .bar>span{position:absolute;left:6px;top:0;font-size:11px}
 pre{background:#0f1115;border:1px solid #262b33;border-radius:6px;padding:10px;overflow:auto;max-height:260px;font-size:12px}
 .muted{color:#889} .warn{color:#fc6} .ok{color:#6c9}
</style></head><body>
<h1>TCNN · что происходит <span class="muted">(обновление каждые 5 с)</span></h1>
<div class="card"><div class="row">
 <div class="kv">Прогон<b>${state}</b></div>
 <div class="kv">Позиция<b>${pos ? `${fmt(pos.pos)} / ${fmt(pos.total)}` : "—"}</b></div>
 <div class="kv">Скорость<b>${rate.perMin ? `${rate.perMin.toFixed(1)} строк/мин` : "—"}</b></div>
 <div class="kv">Осталось<b>${etaH === "—" ? "—" : `${etaH} ч`}</b></div>
 <div class="kv">Модель<b>${model.loaded ?? "не загружена"}</b><span class="muted">${model.detail}</span></div>
 <div class="kv">GPU<b>${gpu ? `${gpu.used} / ${gpu.total} MiB (${gpu.util}%)` : "—"}</b><span class="muted">${gpu?.name ?? ""}</span></div>
 <div class="kv">CPU/RAM<b>${Math.round((1 - freemem() / totalmem()) * 100)}% RAM</b><span class="muted">${cpus().length} потоков</span></div>
</div></div>

<h2>Перевод по языкам</h2>
<div class="card"><table><tr><th>язык</th><th>переведено</th><th>пусто</th><th>skip</th><th>готовность</th><th>всего</th></tr>
${langs
  .map(
    (
      l,
    ) => `<tr><td><b>${l.lang}</b></td><td>${fmt(l.translated)}</td><td>${fmt(l.empty)}</td><td>${fmt(l.skip)}</td>
<td>${bar(l.translated, l.translated + l.empty)}</td><td class="muted">${fmt(l.entries)}</td></tr>`,
  )
  .join("")}
</table></div>

<h2>Оформление (rich_translation)</h2>
<div class="card">${(() => {
    const rt = langs
      .filter((l) => l.translated > 0)
      .map((l) => {
        try {
          const s = auditLang(l.lang, readFileSync(join(PO_DIR, `${l.lang}.po`), "utf8"));
          return `${l.lang}: ${s.inlineWithRt}/${s.inlineTranslated}`;
        } catch {
          return `${l.lang}: —`;
        }
      });
    return `<span class="muted">с rt / переведённых inline:</span> <b>${rt.join(" · ") || "—"}</b>`;
  })()}</div>

<h2>POT</h2>
<div class="card"><div class="row">
 <div class="kv">Записей<b>${fmt(pot.entries)}</b></div>
 <div class="kv">Skip<b>${fmt(pot.skip)}</b><span class="muted">${Object.entries(pot.byRule)
   .map(([k, v]) => `${k}: ${v}`)
   .join(" · ")}</span></div>
 <div class="kv">Починено обрывков<b>${pot.repaired}</b></div>
 <div class="kv">Вырезано политикой<b>${fmt(pot.excluded)}</b></div>
</div></div>

<h2>Спорное в прогоне (${reviewed.length})</h2>
<div class="card"><pre>${reviewed.slice(-12).join("\n") || "нет замечаний"}</pre></div>

<h2>Хвост лога</h2>
<div class="card"><pre>${lines.slice(-18).join("\n")}</pre></div>
<p class="muted">Пауза: <code>echo pause &gt; tmp/translate-local/PAUSE</code> · Снять: удалить файл.
Данные read-only, страница ничего не меняет (кроме счётчика скорости).</p>
</body></html>`;
}

const server = createServer((req, res) => {
  try {
    const html = page();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`ERROR: ${(err as Error).message}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`дашборд: http://127.0.0.1:${PORT}`);
});
