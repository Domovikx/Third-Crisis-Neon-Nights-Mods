/**
 * review_queue.mts — очередь ручного ревью перевода с контекстом.
 *
 * Процессное правило «ревьюить голые строки — это игра в угадайку»:
 *   - секция AUTO: машинные подстановки (`#, auto-normalized`) — подтвердить;
 *   - секция missing: пустые `msgstr`, сгруппированные ПО СПИКЕРУ (`msgctxt`),
 *     у каждой строки соседи сверху/снизу с их переводами.
 *
 * Замена удалённому `output/stable_index.json` (его создавал выпиленный
 * `extractor.py`): строки берём из `po/<lang>.po`, контекст — из `msgctxt`.
 * Честное ограничение: PO отсортирован по тексту (алфавитно), поэтому соседи
 * — «по файлу», а не по сцене; в HTML это написано явно.
 *
 * Запуск: node .opencode/skills/translate-qa/scripts/review_queue.mts [--limit 100] [--lang ru]
 * Выход: tmp/review_queue.html (не трекается).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { parsePo, type PoEntry } from "../../extract-text/scripts/po_file.mts";

export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

const NO_SPEAKER = "без спикера (ui)";

export interface Variant {
  ctxt: string;
  msgstr: string;
  flags: string[];
  refs: string[];
}

export interface Neighbor {
  text: string;
  translation: string;
}

export interface QueueRow {
  /** `A1` / `M17` — номер для ответа человеком. */
  num: string;
  text: string;
  ctxt: string;
  kind: string;
  /** Предложение AUTO-секции (пусто в missing). */
  proposed: string;
  prev?: Neighbor;
  next?: Neighbor;
}

export interface QueueGroup {
  label: string;
  items: QueueRow[];
}

export interface ReviewQueue {
  auto: QueueRow[];
  groups: QueueGroup[];
  missingTotal: number;
  shown: number;
}

/** Спикер из `msgctxt` (группировка и подпись); `null` — спикера нет. */
export function speakerOf(ctxt: string): string | null {
  if (!ctxt.startsWith("speaker:")) return null;
  const sp = ctxt.slice("speaker:".length).trim();
  return sp || null;
}

/** Метка группы: спикер или «без спикера». */
export function groupLabel(ctxt: string): string {
  const sp = speakerOf(ctxt);
  return sp ? `speaker: ${sp}` : NO_SPEAKER;
}

/** Триаж видимости: quest/FSM-метки не переводят массово, а проверяют. */
export function kindOf(text: string, refs: string[], ctxt = ""): string {
  const blob = `${text} ${refs.join(" ")}`;
  for (const k of [
    "TalkToKlaudia",
    "Setup Quest",
    "GlowingHoleRevisit",
    "cleaning",
    "Bartending",
  ]) {
    if (blob.includes(k)) return "quest/fsm";
  }
  if (ctxt.includes("speaker:") || blob.includes("dialogues/") || blob.includes("speaker:")) {
    return "dialogue";
  }
  return "ui";
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `msgid -> варианты` в порядке файла. */
function loadPoMap(lang: string, root: string): Map<string, Variant[]> {
  const path = join(root, "po", `${lang}.po`);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const map = new Map<string, Variant[]>();
  for (const e of parsePo(readFileSync(path, "utf8"))) {
    if (!e.msgid) continue;
    const list = map.get(e.msgid) ?? [];
    list.push({ ctxt: e.msgctxt, msgstr: e.msgstr, flags: e.flags, refs: e.refs });
    map.set(e.msgid, list);
  }
  return map;
}

/**
 * Собрать очередь. `limit` — потолок показанных строк (AUTO + missing
 * суммарно не ограничен для AUTO: он и так маленький, как в Python-версии).
 */
export function buildQueue(lang = "ru", root: string = REPO_ROOT, limit = 100): ReviewQueue {
  const poMap = loadPoMap(lang, root);
  const firstFilled = (text: string): string => {
    for (const v of poMap.get(text) ?? []) if (v.msgstr) return v.msgstr;
    return "";
  };

  // Порядок «как в файле» по группам + позиция каждой записи.
  const entries: PoEntry[] = [];
  const byKey = new Map<string, PoEntry>();
  for (const [text, variants] of poMap) {
    for (const v of variants) {
      const e: PoEntry = {
        msgid: text,
        msgctxt: v.ctxt,
        msgstr: v.msgstr,
        refs: v.refs,
        flags: v.flags,
        comments: [],
        translator: [],
      };
      entries.push(e);
      byKey.set(`${v.ctxt}\u0000${text}`, e);
    }
  }
  const ordered = new Map<string, PoEntry[]>();
  for (const e of entries) {
    const label = groupLabel(e.msgctxt);
    const list = ordered.get(label) ?? [];
    list.push(e);
    ordered.set(label, list);
  }

  const neighborOf = (e: PoEntry, dir: -1 | 1): Neighbor | undefined => {
    const list = ordered.get(groupLabel(e.msgctxt)) ?? [];
    const pos = list.indexOf(e);
    const nb = pos >= 0 ? list[pos + dir] : undefined;
    return nb ? { text: nb.msgid, translation: firstFilled(nb.msgid) } : undefined;
  };

  const auto: QueueRow[] = [];
  const missing: { text: string; entry: PoEntry }[] = [];
  for (const [text, variants] of poMap) {
    const autoV = variants.find((v) => v.flags.includes("auto-normalized"));
    if (autoV) {
      auto.push({
        num: `A${auto.length + 1}`,
        text,
        ctxt: autoV.ctxt,
        kind: kindOf(text, autoV.refs, autoV.ctxt),
        proposed: autoV.msgstr,
      });
      continue;
    }
    if (variants.some((v) => v.msgstr)) continue;
    const v = variants[0];
    const entry = byKey.get(`${v.ctxt}\u0000${text}`);
    if (entry) missing.push({ text, entry });
  }

  // Соседи AUTO-строк — тоже по порядку файла в своей группе.
  for (const row of auto) {
    const e = byKey.get(`${row.ctxt}\u0000${row.text}`);
    if (!e) continue;
    row.prev = neighborOf(e, -1);
    row.next = neighborOf(e, 1);
  }

  const byGroup = new Map<string, QueueRow[]>();
  for (const { text, entry } of missing) {
    const label = groupLabel(entry.msgctxt);
    const list = byGroup.get(label) ?? [];
    list.push({
      num: "", // номер присвоим после отсечения по лимиту
      text,
      ctxt: entry.msgctxt,
      kind: kindOf(text, entry.refs, entry.msgctxt),
      proposed: "",
      prev: neighborOf(entry, -1),
      next: neighborOf(entry, 1),
    });
    byGroup.set(label, list);
  }

  // Сначала диалоги (по спикеру), потом остальное — как в Python-версии.
  const labels = [...byGroup.keys()].sort((a, b) => {
    const da = a === NO_SPEAKER ? 1 : 0;
    const db = b === NO_SPEAKER ? 1 : 0;
    return da - db || a.localeCompare(b);
  });

  const perGroup = labels.length ? Math.max(1, Math.floor(limit / labels.length)) : limit;
  let shown = 0;
  const groups: QueueGroup[] = [];
  for (const label of labels) {
    const all = byGroup.get(label) ?? [];
    const items: QueueRow[] = [];
    for (const row of all) {
      if (shown >= limit) break;
      if (items.length >= perGroup) break;
      row.num = `M${shown + 1}`;
      items.push(row);
      shown += 1;
    }
    if (items.length) groups.push({ label, items });
  }

  return { auto, groups, missingTotal: missing.length, shown };
}

function rowHtml(row: QueueRow): string {
  const fmt = (nb?: Neighbor): string => {
    if (!nb) return "—";
    const ru = nb.translation
      ? `<br><span class='ru'>→ ${esc(nb.translation.slice(0, 90))}</span>`
      : "";
    return `${esc(nb.text.slice(0, 90))}${ru}`;
  };
  const proposed = row.proposed ? esc(row.proposed.slice(0, 160)) : "<i>пусто — перевести</i>";
  return (
    `<tr><td><input type='checkbox' checked></td><td>${esc(row.num)}</td>` +
    `<td><span class='tag'>${esc(row.kind)}</span><br><span class='en'>${esc(row.text.slice(0, 160))}</span><br>` +
    `<span class='ru'>→ ${proposed}</span></td>` +
    `<td><span class='ctx'>${esc(row.ctxt)}<br>${esc(groupLabel(row.ctxt))}</span></td>` +
    `<td><span class='ctx'>▲ ${fmt(row.prev)}<br>▼ ${fmt(row.next)}</span></td></tr>`
  );
}

/** HTML очереди (тот же семейный стиль, что у QA-дашборда). */
export function renderHtml(q: ReviewQueue): string {
  const total = q.auto.length + q.missingTotal;
  const autoRows = q.auto.map(rowHtml).join("");
  const missingRows = q.groups
    .map(
      (g) =>
        `<tr class='grp'><td colspan='5'>${esc(g.label)} (${g.items.length})</td></tr>` +
        g.items.map(rowHtml).join(""),
    )
    .join("");

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<title>review queue — перевод + ревью</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;max-width:1200px;margin:0 auto;padding:20px;background:#14141c;color:#e8e8ef}
h1,h2{color:#EB83FF} .note{color:#888;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px} td,th{border:1px solid #333;padding:6px 8px;vertical-align:top}
th{background:#1f1f2b} .en{color:#ffd166} .ru{color:#7CFC98} .ctx{color:#888;font-size:12px}
.tag{background:#2b6cb0;border-radius:4px;padding:1px 8px;font-size:12px}
tr.grp td{background:#1f1f2b;font-weight:700}
input[type=checkbox]{transform:scale(1.4)}
</style></head><body>
<h1>Очередь ревью: ${q.auto.length} auto + ${q.missingTotal} missing (показано ${q.shown})</h1>
<p class="note">Секция AUTO — машинные подстановки по нормализации: подтвердить/поправить.
Секция missing — сгруппировано по спикерам (msgctxt), у каждой строки соседи сверху/снизу
с их переводами. Соседи — по порядку в po-файле (он отсортирован по тексту), а не по сцене:
сцен в PO нет, stable_index удалён вместе с extractor.py.
Ответь номерами (A1.. / M1..) — применю в po → .dat → QA. Всего строк: ${total}.</p>
<h2>AUTO-normalized (${q.auto.length})</h2>
<table><tr><th>✓</th><th>#</th><th>строка → предложение</th><th>контекст</th><th>соседи</th></tr>${autoRows}</table>
<h2>Missing по спикерам</h2>
<table><tr><th>✓</th><th>#</th><th>строка</th><th>контекст</th><th>соседи</th></tr>${missingRows}</table>
</body></html>`;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv: string[]): number {
  const lang = arg(argv, "--lang") ?? "ru";
  const limit = Number(arg(argv, "--limit") ?? 100);
  const out = resolve(arg(argv, "--out") ?? join(REPO_ROOT, "tmp", "review_queue.html"));
  const q = buildQueue(lang, REPO_ROOT, limit);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderHtml(q), "utf8");
  console.error(
    `review queue[${lang}]: ${q.auto.length} auto + ${q.missingTotal} missing -> ${out}`,
  );
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
