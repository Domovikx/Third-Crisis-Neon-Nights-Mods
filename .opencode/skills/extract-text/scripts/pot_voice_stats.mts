/**
 * pot_voice_stats.mts — счёт POT для озвучки: что озвучиваем, что нет.
 *
 * Только чтение `po/template.pot`; числа плана 2026-11-26
 * (`tasks/2026-11-26-pot-voicing-plan.md`) воспроизводятся этим скриптом.
 * Печатает markdown-таблицы и пишет те же данные в
 * `tmp/pot-voice-plan-stats.{json,md}` (tmp — расходник, в git не идёт).
 *
 *   node .opencode/skills/extract-text/scripts/pot_voice_stats.mts
 *
 * Классы записей (по `#. src:` + `msgctxt`):
 *   dialog         msgctxt `speaker:<Имя>` — речь персонажа;
 *   narration      `src: dialog` без спикера — мысль/описание от первого лица;
 *   speaker-name   `msgctxt speaker-name` — подписи имени/состояния;
 *   ui             предметы, подсказки, меню, настройки;
 *   service        `raw:*`, `us`, `bundle` — не текст для игрока.
 *
 * Стоны M0/M1 — по данным: строка без букв (M0) или все слова из словаря
 * звуков (M1), правило `tmp/voice_research.mts` (отчёт 2026-11-25).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { SPEAKER_TO_CHARACTER } from "../../../../config/voice-characters.mts";
import { parsePo, type PoEntry } from "./po_file.mts";

// ────────────────────────────────────────────────── стоп-словарь стонов ──
const SOUND = new Set(
  `ah aah ahh ahhh aa aaa oh ohh ooh oo oohh uh uhh uhn uhm um mm mmm mmmm mmmmm hm hmm hmmm hmmmm
   mhm mhmm hah hahh haa haaa heh hehh huh hh hhh hhhh hhm ngh nghh nggh nnn nnh nngh mnh mnhh mnn
   ghh gh guh kh khh khhh kgh unh unhh ugh agh fh fhh fgh fghh fff fffh ffh ff gf hng ahn eep eek ow
   oof brr mwah mwahh mmmh mmh nng nnggh pff pfft tsk shh shhh hss hsss purr growl cough gasp sigh
   moan groan grunt wheeze pant panting breath breathing yawn`
    .split(/\s+/)
    .filter(Boolean),
);
const stripPunct = (s: string): string => s.replace(/[^A-Za-z']+/g, " ").replace(/^[>\s]+/, "");

/** M0 — нет букв; M1 — все слова из словаря звуков; null — обычная реплика. */
export function moanClass(s: string): "M0" | "M1" | null {
  const words = stripPunct(s)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/'/g, "").replace(/(.)\1{2,}/g, "$1$1"));
  if (!words.length) return "M0";
  if (words.every((w) => SOUND.has(w))) return "M1";
  return null;
}

const isMoan = (e: PoEntry): boolean => moanClass(e.msgid) !== null;
const hasSoundWord = (s: string): boolean =>
  stripPunct(s)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .some((w) => SOUND.has(w.replace(/'/g, "").replace(/(.)\1{2,}/g, "$1$1")));

/** uid = md5(msgid), как в TSSR (в POT TCNN uid пока не материализован). */
const uid = (text: string): string => createHash("md5").update(text, "utf8").digest("hex");

const srcOf = (e: PoEntry): string => e.comments.find((c) => c.startsWith("src: "))?.slice(5) ?? "";
const skipRule = (e: PoEntry): string =>
  e.comments.find((c) => c.startsWith("skip: "))?.slice(6) ?? "";
const isSkip = (e: PoEntry): boolean => e.flags.includes("skip");
const hasRich = (e: PoEntry): boolean => e.comments.some((c) => c.startsWith("rich_text: "));

type Klass = "dialog" | "narration" | "speaker-name" | "ui" | "service";
const KLASSES: Klass[] = ["dialog", "narration", "speaker-name", "ui", "service"];

function klassOf(e: PoEntry): Klass {
  const src = srcOf(e);
  if (e.msgctxt === "speaker-name") return "speaker-name";
  if (e.msgctxt.startsWith("speaker:")) return "dialog";
  if (src === "dialog") return "narration";
  if (src === "us" || src === "global" || src === "bundle" || src.startsWith("raw:"))
    return "service";
  return "ui";
}

export interface PotVoiceStats {
  pot: string;
  entries: number;
  uniqueMsgid: number;
  byKlass: Record<
    Klass,
    { entries: number; skip: number; live: number; rich: number; uniqueMsgid: number }
  >;
  corpus: Record<string, number>;
  voicing: Record<string, number>;
  skipByRule: { rule: string; entries: number; byClass: Partial<Record<Klass, number>> }[];
  speakers: {
    speaker: string;
    cast: boolean;
    entries: number;
    live: number;
    skip: number;
    moans: number;
    voiceable: number;
  }[];
  speakerNameValues: string[];
  uiSrcRows: { src: string; entries: number; skip: number; live: number; rich: number }[];
  /** src × класс: записей / skip / rich. */
  matrix: Record<string, Partial<Record<Klass, [number, number, number]>>>;
}

/** Посчитать всё по тексту POT (чистая функция — тестируется без диска). */
export function collectStats(potText: string, potPath = "po/template.pot"): PotVoiceStats {
  const all: PoEntry[] = parsePo(potText).filter((e) => e.msgid);

  const byKlass = Object.fromEntries(
    KLASSES.map((k) => {
      const rows = all.filter((e) => klassOf(e) === k);
      return [
        k,
        {
          entries: rows.length,
          skip: rows.filter(isSkip).length,
          live: rows.filter((e) => !isSkip(e)).length,
          rich: rows.filter(hasRich).length,
          uniqueMsgid: new Set(rows.map((e) => e.msgid)).size,
        },
      ];
    }),
  ) as PotVoiceStats["byKlass"];

  // Корпус: уникальные msgid из `src: dialog`, первый по файлу побеждает.
  const dialogAll = all.filter((e) => srcOf(e) === "dialog");
  const dialogUnique = new Map<string, PoEntry>();
  for (const e of dialogAll) if (!dialogUnique.has(e.msgid)) dialogUnique.set(e.msgid, e);
  const corpus = [...dialogUnique.values()].filter((e) => !isSkip(e));
  const corpusMoans = corpus.filter(isMoan);

  const castSpeakers = new Set(
    Object.entries(SPEAKER_TO_CHARACTER)
      .filter(([, v]) => v !== null)
      .map(([k]) => k),
  );
  const serviceSpeakers = new Set(
    Object.entries(SPEAKER_TO_CHARACTER)
      .filter(([, v]) => v === null)
      .map(([k]) => k),
  );

  const castLines = corpus.filter(
    (e) => e.msgctxt.startsWith("speaker:") && castSpeakers.has(e.msgctxt.slice(8)),
  );
  const serviceLines = corpus.filter(
    (e) => e.msgctxt.startsWith("speaker:") && serviceSpeakers.has(e.msgctxt.slice(8)),
  );
  const narration = corpus.filter(
    (e) => !e.msgctxt.startsWith("speaker:") && e.msgctxt !== "speaker-name",
  );
  const speakerName = corpus.filter((e) => e.msgctxt === "speaker-name");

  /** Итоговый набор озвучки: речь 23 персонажей + нарратив, без M0/M1. */
  const voicing = [...castLines.filter((e) => !isMoan(e)), ...narration.filter((e) => !isMoan(e))];

  const corpusStats = {
    dialogEntries: dialogAll.length,
    dialogUnique: dialogUnique.size,
    live: corpus.length,
    moansM0: corpusMoans.filter((e) => moanClass(e.msgid) === "M0").length,
    moansM1: corpusMoans.filter((e) => moanClass(e.msgid) === "M1").length,
    rich: corpus.filter(hasRich).length,
    attributed: corpus.filter((e) => e.msgctxt.startsWith("speaker:")).length,
    narration: corpus.filter((e) => !e.msgctxt.startsWith("speaker:")).length,
    parentheticalNarration: narration.filter((e) => /^\s*\(/.test(e.msgid.replace(/<[^>]+>/g, "")))
      .length,
    /** M2 — звук внутри смысловой фразы (озвучивается). */
    m2: corpus.filter((e) => !isMoan(e) && hasSoundWord(e.msgid)).length,
  };

  const voicingStats = {
    castLines: castLines.length,
    castVoiceable: castLines.filter((e) => !isMoan(e)).length,
    narrationLines: narration.length,
    narrationVoiceable: narration.filter((e) => !isMoan(e)).length,
    serviceSpeakerLines: serviceLines.length,
    speakerNameLines: speakerName.length,
    moans: corpusMoans.length,
    voicingLines: voicing.length,
    voicingUids: new Set(voicing.map((e) => uid(e.msgid))).size,
    voicingRich: voicing.filter(hasRich).length,
    voicingM2: voicing.filter((e) => hasSoundWord(e.msgid)).length,
  };

  const skipByRule = new Map<
    string,
    { entries: number; byClass: Partial<Record<Klass, number>> }
  >();
  for (const e of all.filter(isSkip)) {
    const rule = skipRule(e);
    const rec = skipByRule.get(rule) ?? { entries: 0, byClass: {} };
    rec.entries += 1;
    const k = klassOf(e);
    rec.byClass[k] = (rec.byClass[k] ?? 0) + 1;
    skipByRule.set(rule, rec);
  }

  const speakers = [
    ...new Set(all.filter((e) => e.msgctxt.startsWith("speaker:")).map((e) => e.msgctxt.slice(8))),
  ]
    .map((speaker) => {
      const rows = all.filter((e) => e.msgctxt === `speaker:${speaker}`);
      const live = rows.filter((e) => !isSkip(e));
      const moans = live.filter(isMoan).length;
      return {
        speaker,
        cast: castSpeakers.has(speaker),
        entries: rows.length,
        live: live.length,
        skip: rows.length - live.length,
        moans,
        voiceable: live.length - moans,
      };
    })
    .sort(
      (a, b) =>
        Number(b.cast) - Number(a.cast) ||
        b.voiceable - a.voiceable ||
        a.speaker.localeCompare(b.speaker),
    );

  const uiSrcRows = [...new Set(all.map(srcOf))]
    .map((src) => {
      const rows = all.filter((e) => srcOf(e) === src);
      return {
        src,
        entries: rows.length,
        skip: rows.filter(isSkip).length,
        live: rows.filter((e) => !isSkip(e)).length,
        rich: rows.filter(hasRich).length,
      };
    })
    .sort((a, b) => b.entries - a.entries);

  const matrix: PotVoiceStats["matrix"] = {};
  for (const e of all) {
    const src = srcOf(e);
    const row = (matrix[src] ??= {});
    const cell = (row[klassOf(e)] ??= [0, 0, 0]);
    cell[0] += 1;
    if (isSkip(e)) cell[1] += 1;
    if (hasRich(e)) cell[2] += 1;
  }

  return {
    pot: potPath,
    entries: all.length,
    uniqueMsgid: new Set(all.map((e) => e.msgid)).size,
    byKlass,
    corpus: corpusStats,
    voicing: voicingStats,
    skipByRule: [...skipByRule.entries()]
      .map(([rule, rec]) => ({ rule, entries: rec.entries, byClass: rec.byClass }))
      .sort((a, b) => b.entries - a.entries),
    speakers,
    speakerNameValues: [
      ...new Set(all.filter((e) => e.msgctxt === "speaker-name").map((e) => e.msgid)),
    ],
    uiSrcRows,
    matrix,
  };
}

/** Markdown-проекция для консоли и `tmp/pot-voice-plan-stats.md`. */
export function formatStats(s: PotVoiceStats): string {
  const md: string[] = [];
  const pct = (n: number, d: number): string => `${((100 * n) / d).toFixed(2)} %`;
  md.push(`# POT: ${s.entries} записей, ${s.uniqueMsgid} уникальных msgid`);

  md.push(
    "",
    "## По классам",
    "| Класс | Записей | Доля | #, skip | Живых | С rich_text | Уник. msgid |",
  );
  md.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const k of KLASSES) {
    const b = s.byKlass[k];
    md.push(
      `| ${k} | ${b.entries} | ${pct(b.entries, s.entries)} | ${b.skip} | ${b.live} | ${b.rich} | ${b.uniqueMsgid} |`,
    );
  }

  md.push("", "## Корпус src: dialog (уникальные msgid)", "| Метрика | Строк |", "| --- | ---: |");
  for (const [k, v] of Object.entries(s.corpus)) md.push(`| ${k} | ${v} |`);

  md.push("", "## Набор озвучки", "| Метрика | Строк |", "| --- | ---: |");
  for (const [k, v] of Object.entries(s.voicing)) md.push(`| ${k} | ${v} |`);

  md.push("", "## src × класс (записей / skip / rich)");
  md.push(`| src | ${KLASSES.join(" | ")} |`, `| --- | ${KLASSES.map(() => "---:").join(" | ")} |`);
  for (const r of s.uiSrcRows) {
    const cells = KLASSES.map((k) => {
      const c = s.matrix[r.src]?.[k];
      return c ? `${c[0]} / ${c[1]} / ${c[2]}` : "—";
    });
    md.push(`| ${r.src} | ${cells.join(" | ")} |`);
  }
  md.push(
    "",
    "## skip по правилам",
    "| Правило | Записей | dialog | narration | speaker-name | ui | service |",
  );
  md.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of s.skipByRule) {
    const g = (k: Klass): number => r.byClass[k] ?? 0;
    md.push(
      `| ${r.rule || "(нет)"} | ${r.entries} | ${g("dialog")} | ${g("narration")} | ${g("speaker-name")} | ${g("ui")} | ${g("service")} |`,
    );
  }

  md.push("", "## По спикерам", "| Спикер | Каст | Записей | Живых | skip | M0+M1 | К озвучке |");
  md.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const r of s.speakers) {
    md.push(
      `| ${r.speaker} | ${r.cast ? "да" : "—"} | ${r.entries} | ${r.live} | ${r.skip} | ${r.moans} | ${r.voiceable} |`,
    );
  }

  md.push(
    "",
    `## speaker-name: ${s.speakerNameValues.length} значений`,
    s.speakerNameValues.join(" · "),
  );
  return `${md.join("\n")}\n`;
}

function main(): void {
  const stats = collectStats(readFileSync("po/template.pot", "utf8"));
  writeFileSync("tmp/pot-voice-plan-stats.json", `${JSON.stringify(stats, null, 2)}\n`);
  const md = formatStats(stats);
  writeFileSync("tmp/pot-voice-plan-stats.md", md);
  process.stdout.write(md);
}

if (import.meta.filename === process.argv[1]) main();
