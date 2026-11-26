/**
 * narrator_audit.mts — проверка нарратива по данным: кто говорит строки без
 * `speaker:` в POT, озвучен ли рассказчик в оригинале и каким голосом.
 *
 * Читает только `po/template.pot`, `tmp/dump/*.jsonl` (дамп игры, вне гита) и
 * `tmp/voice-match.json` (сопоставление клипов из отчёта 2026-11-25). Ничего не
 * пишет в `po/**`; результат — stdout (markdown) + `tmp/narrator-audit.json`.
 *
 *   node .opencode/skills/extract-text/scripts/narrator_audit.mts
 *
 * Класс «нарратив» здесь — POT-запись с `#. src: dialog` и `msgctxt "ui"`
 * (без `speaker:<Имя>`), живая (без `#, skip`). Это ровно тот набор, который
 * план озвучки называет «нарративом от первого лица».
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

import { parsePo, type PoEntry } from "./po_file.mts";

const POT = "po/template.pot";
const DUMP = "tmp/dump";
const VOICE_MATCH = "tmp/voice-match.json";
const OUT = "tmp/narrator-audit.json";

const srcOf = (e: PoEntry): string => e.comments.find((c) => c.startsWith("src: "))?.slice(5) ?? "";
const isSkip = (e: PoEntry): boolean => e.flags.includes("skip");

/** Нормализация для сверки POT ↔ дамп: снять rich-теги и сравнить текст. */
const stripRich = (s: string): string => s.replace(/<\/?(?:i|b)>/g, "").trim();

/** Имя бандла без префикса/суффикса файла дампа — общий ключ сцена↔клип. */
const sceneKey = (s: string): string => s.replace(/^bundle_/, "").replace(/_assets_all_.*$/, "");

interface DumpDialogue {
  speaker: string | undefined;
  text: string;
  bundle: string;
  object: string;
}

interface DumpScan {
  files: number;
  dialogueObjects: number;
  dialogues: DumpDialogue[];
  /** текст -> все вхождения (для сверки POT ↔ дамп). */
  byText: Map<string, DumpDialogue[]>;
}

function scanDump(): DumpScan {
  const files = readdirSync(DUMP).filter((f) => f.endsWith(".jsonl"));
  const dialogues: DumpDialogue[] = [];
  const byText = new Map<string, DumpDialogue[]>();
  let dialogueObjects = 0;

  for (const file of files) {
    const lines = readFileSync(`${DUMP}/${file}`, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.includes('"dialogues"')) continue;
      let obj: { dialogues?: unknown; strings?: { m_Name?: string } };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(obj.dialogues)) continue;
      dialogueObjects += 1;
      const bundle = sceneKey(file);
      const object = obj.strings?.m_Name ?? "?";
      for (const d of obj.dialogues as { speaker?: string; text?: string }[]) {
        if (typeof d.text !== "string") continue;
        const rec: DumpDialogue = {
          speaker: "speaker" in d ? d.speaker : undefined,
          text: d.text,
          bundle,
          object,
        };
        dialogues.push(rec);
        const key = stripRich(d.text);
        const list = byText.get(key) ?? [];
        list.push(rec);
        byText.set(key, list);
      }
    }
  }
  return { files: files.length, dialogueObjects, dialogues, byText };
}

/** «Мысль» — строка целиком в скобках (возможно, с rich-тегами). */
const isThought = (s: string): boolean => /^\(.*\)[.!?~\s]*$/s.test(stripRich(s));

/** Прямая речь в кавычках. */
const isQuoted = (s: string): boolean => /^["“«]/.test(stripRich(s));

interface VoiceMatch {
  matches: {
    name: string;
    kind: string;
    bundle: string;
    len: number;
    character: string | null;
    match: string;
    potMsgid: string;
    potCtx: string;
    inCorpus: boolean;
    speakerSource: string;
    score: number;
  }[];
  voicedMsgids: string[];
}

function main(): void {
  const pot = parsePo(readFileSync(POT, "utf8"));
  const dump = scanDump();

  const byMsgid = new Map<string, PoEntry[]>();
  for (const e of pot) {
    if (!e.msgid) continue;
    const list = byMsgid.get(e.msgid) ?? [];
    list.push(e);
    byMsgid.set(e.msgid, list);
  }

  // ── 1. Нарративный класс POT ───────────────────────────────────────────
  const narration = pot.filter(
    (e) => e.msgid && srcOf(e) === "dialog" && e.msgctxt === "ui" && !isSkip(e),
  );
  const narrationSkipped = pot.filter(
    (e) => e.msgid && srcOf(e) === "dialog" && e.msgctxt === "ui" && isSkip(e),
  );

  // ── 2. Сверка с дампом: что в поле speaker ─────────────────────────────
  let empty = 0;
  let named = 0;
  let missingField = 0;
  let noMatch = 0;
  const namedBySpeaker: Record<string, number> = {};
  const noMatchExamples: string[] = [];
  const namedExamples: { speaker: string; text: string; scene: string }[] = [];
  const emptyExamples: { text: string; scene: string }[] = [];

  for (const e of narration) {
    const hits = dump.byText.get(stripRich(e.msgid));
    if (!hits?.length) {
      noMatch += 1;
      if (noMatchExamples.length < 10) noMatchExamples.push(e.msgid.slice(0, 90));
      continue;
    }
    const hit = hits[0];
    if (hit.speaker === undefined) {
      missingField += 1;
    } else if (hit.speaker.trim() === "") {
      empty += 1;
      if (emptyExamples.length < 12)
        emptyExamples.push({ text: e.msgid.slice(0, 90), scene: hit.bundle });
    } else {
      named += 1;
      namedBySpeaker[hit.speaker] = (namedBySpeaker[hit.speaker] ?? 0) + 1;
      if (namedExamples.length < 12)
        namedExamples.push({ speaker: hit.speaker, text: e.msgid.slice(0, 90), scene: hit.bundle });
    }
  }

  // ── 3. Что это за текст (мысль / речь / описание) ──────────────────────
  const thoughts = narration.filter((e) => isThought(e.msgid)).length;
  const quoted = narration.filter((e) => !isThought(e.msgid) && isQuoted(e.msgid)).length;
  const plain = narration.length - thoughts - quoted;

  // ── 4. Озвученные клипы: где нарратив и каким голосом ──────────────────
  let vm: VoiceMatch | null = null;
  try {
    vm = JSON.parse(readFileSync(VOICE_MATCH, "utf8")) as VoiceMatch;
  } catch {
    vm = null;
  }

  const voicedNarr: NonNullable<VoiceMatch["matches"]> = vm
    ? vm.matches.filter((m) => m.potMsgid && m.potCtx === "ui")
    : [];
  const uniqueVoicedNarr = new Map<string, (typeof voicedNarr)[number]>();
  for (const m of voicedNarr)
    if (!uniqueVoicedNarr.has(m.potMsgid)) uniqueVoicedNarr.set(m.potMsgid, m);

  const voicedByCharacter: Record<string, number> = {};
  const voicedBySource: Record<string, number> = {};
  for (const m of uniqueVoicedNarr.values()) {
    const who = m.character ?? "(нет)";
    voicedByCharacter[who] = (voicedByCharacter[who] ?? 0) + 1;
    voicedBySource[m.speakerSource] = (voicedBySource[m.speakerSource] ?? 0) + 1;
  }

  const voicedThoughts = [...uniqueVoicedNarr.values()].filter((m) => isThought(m.potMsgid));
  const voicedQuoted = [...uniqueVoicedNarr.values()].filter(
    (m) => !isThought(m.potMsgid) && isQuoted(m.potMsgid),
  );
  const voicedPlain = [...uniqueVoicedNarr.values()].filter(
    (m) => !isThought(m.potMsgid) && !isQuoted(m.potMsgid),
  );

  // ── 5. Покрытие по сценам, где есть клипы ──────────────────────────────
  interface SceneStat {
    bundle: string;
    dialogueLines: number;
    voicedClips: number;
    narrLines: number;
    narrVoiced: number;
    narrCharacters: Record<string, number>;
    narrThoughts: number;
    narrThoughtsVoiced: number;
  }
  const sceneStats = new Map<string, SceneStat>();
  /** Уникальные msgid на сцену — клипы одного текста дублируются (варианты имён). */
  const sceneNarrMsgids = new Map<string, Set<string>>();
  const addTo = (m: Map<string, Set<string>>, k: string, v: string): void => {
    const set = m.get(k) ?? new Set<string>();
    set.add(v);
    m.set(k, set);
  };
  const ensureScene = (bundle: string): SceneStat => {
    let s = sceneStats.get(bundle);
    if (!s) {
      s = {
        bundle,
        dialogueLines: 0,
        voicedClips: 0,
        narrLines: 0,
        narrVoiced: 0,
        narrCharacters: {},
        narrThoughts: 0,
        narrThoughtsVoiced: 0,
      };
      sceneStats.set(bundle, s);
    }
    return s;
  };

  for (const d of dump.dialogues) {
    ensureScene(d.bundle).dialogueLines += 1;
  }
  const sceneNarrLines = new Map<string, Set<string>>();
  for (const s of sceneStats.values()) {
    for (const e of narration) {
      const hits = dump.byText.get(stripRich(e.msgid));
      if (hits?.some((h) => h.bundle === s.bundle)) {
        s.narrLines += 1;
        addTo(sceneNarrLines, s.bundle, e.msgid);
        if (isThought(e.msgid)) s.narrThoughts += 1;
      }
    }
  }
  if (vm) {
    for (const m of vm.matches) {
      const s = sceneStats.get(sceneKey(m.bundle));
      if (!s) continue;
      s.voicedClips += 1;
      if (m.potMsgid && m.potCtx === "ui") {
        addTo(sceneNarrMsgids, s.bundle, m.potMsgid);
      }
    }
  }
  // Покрытие нарратива = клип покрывает строку, которая реально в этой сцене
  // (часть клипов бандла — пресеты вне `dialogues[]`, их в знаменатель не берём).
  for (const s of sceneStats.values()) {
    const lines = sceneNarrLines.get(s.bundle) ?? new Set<string>();
    const voiced = sceneNarrMsgids.get(s.bundle) ?? new Set<string>();
    const voices: Record<string, number> = {};
    let thoughtsVoiced = 0;
    for (const msgid of voiced) {
      if (!lines.has(msgid)) continue;
      if (isThought(msgid)) thoughtsVoiced += 1;
      const m = uniqueVoicedNarr.get(msgid);
      const who = m?.character ?? "(нет)";
      voices[who] = (voices[who] ?? 0) + 1;
    }
    s.narrVoiced = Object.values(voices).reduce((a, b) => a + b, 0);
    s.narrThoughtsVoiced = thoughtsVoiced;
    s.narrCharacters = voices;
  }

  // ── Вывод ───────────────────────────────────────────────────────────────
  const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)} %` : "—");
  const sortDesc = (o: Record<string, number>): [string, number][] =>
    Object.entries(o).sort((a, b) => b[1] - a[1]);

  const lines: string[] = [];
  const potEntries = pot.filter((e) => e.msgid !== "").length;
  lines.push("# Аудит нарратива TCNN (данные, не догадки)", "");
  lines.push(
    `POT: ${potEntries} записей; дамп: ${dump.files} файлов, ${dump.dialogueObjects} диалоговых объектов, ${dump.dialogues.length} строк диалога.`,
    "",
    "## 1. Нарративный класс POT",
    "",
    `- живых записей \`src: dialog\` + \`msgctxt "ui"\`: **${narration.length}**;`,
    `- из них помечено \`#, skip\`: ${narrationSkipped.length};`,
    `- мысль в скобках \`(…)\`: **${thoughts}** (${pct(thoughts, narration.length)});`,
    `- прямая речь в кавычках: ${quoted}; прочее (описание/речь без кавычек): ${plain}.`,
    "",
    "## 2. Поле `speaker` в дампе для этих строк",
    "",
    "| Что в `speaker` | Строк | Доля |",
    "| --- | ---: | ---: |",
    `| пусто | **${empty}** | ${pct(empty, narration.length)} |`,
    `| имя персонажа | ${named} | ${pct(named, narration.length)} |`,
    `| поля нет вовсе | ${missingField} | ${pct(missingField, narration.length)} |`,
    `| нет такой строки в дампе | ${noMatch} | ${pct(noMatch, narration.length)} |`,
  );
  if (named)
    lines.push(
      "",
      `По именам: ${sortDesc(namedBySpeaker)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}.`,
    );
  if (noMatchExamples.length)
    lines.push("", "Не нашлись в дампе (точный текст):", ...noMatchExamples.map((s) => `- ${s}`));

  lines.push("", "## 3. Озвученные строки нарративного класса", "");
  if (!vm) {
    lines.push("`tmp/voice-match.json` не найден — раздел пропущен.");
  } else {
    const total = vm.voicedMsgids.length;
    const narrUnique = uniqueVoicedNarr.size;
    lines.push(
      `- озвучено клипами всего: **${total}** msgid;`,
      `- из них POT-контекст \`ui\` (нарративный класс): **${narrUnique}** (${pct(narrUnique, total)});`,
      `- из этих ${narrUnique}: мысль в скобках **${voicedThoughts.length}**, прямая речь ${voicedQuoted.length}, прочее ${voicedPlain.length};`,
      `- голоса по атрибуции клипа: ${sortDesc(voicedByCharacter)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")};`,
      `- источник атрибуции: ${sortDesc(voicedBySource)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}.`,
    );
    if (voicedPlain.length) {
      lines.push("", "Озвученные строки без скобок и кавычек:");
      for (const m of voicedPlain)
        lines.push(`- ${m.character ?? "?"}: ${m.potMsgid.slice(0, 90)}`);
    }
  }

  lines.push("", "## 4. Сцены с клипами: нарратив внутри покрытия", "");
  lines.push("| Бандл | Строк диалога | Клипов | Нарратив | Озвучен нарратив | Голоса нарратива |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const s of [...sceneStats.values()].sort((a, b) => b.voicedClips - a.voicedClips)) {
    if (!s.voicedClips) continue;
    const voices =
      sortDesc(s.narrCharacters)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "—";
    lines.push(
      `| \`${s.bundle}\` | ${s.dialogueLines} | ${s.voicedClips} | ${s.narrLines} (мыслей ${s.narrThoughts}) | ${s.narrVoiced} (мыслей ${s.narrThoughtsVoiced}) | ${voices} |`,
    );
  }

  lines.push("", "## 5. Примеры (10 строк нарратива)", "");
  const thoughtExamples = narration.filter((e) => isThought(e.msgid)).slice(0, 5);
  const plainExamples = narration
    .filter((e) => !isThought(e.msgid) && !isQuoted(e.msgid) && !stripRich(e.msgid).startsWith("("))
    .slice(0, 5);
  for (const e of thoughtExamples) {
    const hit = dump.byText.get(stripRich(e.msgid))?.[0];
    lines.push(`- мысль, \`speaker: ""\` [${hit?.bundle ?? "?"}] ${e.msgid.slice(0, 90)}`);
  }
  for (const e of plainExamples) {
    const hit = dump.byText.get(stripRich(e.msgid))?.[0];
    lines.push(`- без скобок, \`speaker: ""\` [${hit?.bundle ?? "?"}] ${e.msgid.slice(0, 90)}`);
  }
  lines.push("");

  const report = {
    potEntries: pot.length,
    dump: {
      files: dump.files,
      dialogueObjects: dump.dialogueObjects,
      dialogues: dump.dialogues.length,
    },
    narration: {
      live: narration.length,
      skipped: narrationSkipped.length,
      thoughts,
      quoted,
      plain,
    },
    speaker: { empty, named, missingField, noMatch, namedBySpeaker },
    voiced: vm
      ? {
          total: vm.voicedMsgids.length,
          narrationUnique: uniqueVoicedNarr.size,
          thoughts: voicedThoughts.length,
          quoted: voicedQuoted.length,
          plain: voicedPlain.length,
          byCharacter: voicedByCharacter,
          bySource: voicedBySource,
        }
      : null,
    scenes: [...sceneStats.values()].filter((s) => s.voicedClips),
    examples: { empty: emptyExamples, named: namedExamples, noMatch: noMatchExamples },
  };
  writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  console.log(lines.join("\n"));
  console.log(`\nJSON -> ${OUT}`);
}

main();
