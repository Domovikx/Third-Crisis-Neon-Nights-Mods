/**
 * build_narrator_refs.mts — рефы Narrator из клипов-мыслей (CPU, ffmpeg).
 *
 * Основание: аудит `narrator_audit.mts` — в 4 озвученных сценах все мысли Зои
 * (строки в скобках) озвучены её же актрисой (префикс `VAZoey` / пресет
 * `Zoey Dialogue Presets`). Отдельного голоса рассказчика в игре НЕТ, поэтому
 * профиль Narrator — тот же актёр, но реф собран ТОЛЬКО из нарративных клипов
 * (тон наблюдения отличается от реплик).
 *
 * Цепочка — та же, что у остальных рефов (TSSR): highpass=f=60, afftdn=nr=15,
 * deesser=i=0.5, highshelf=f=8000:g=-6; фейды 30 мс по краям фрагмента; склейка
 * через паузу 150 мс; двухпроходный loudnorm I=-16 LUFS / TP=-1.5 / LRA=11;
 * внешние фейды 30 мс; выход WAV PCM 16 бит, 24 кГц, mono.
 *
 *   node .opencode/skills/extract-text/scripts/build_narrator_refs.mts
 *
 * Источник клипов — `tmp/voice-refs/<бандл>/` (дамп аудио игры, вне гита).
 * Результат — `voice-refs/Narrator/candidates/{A,B,C}.wav` (аудио не коммитится).
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolveAbs } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = "tmp/voice-refs/lewdanimation_liofuckmachine";
const WORK = "tmp/_narrator_refbuild";
const OUT = "voice-refs/Narrator/candidates";
const SR = 24000;
const CHAIN = "highpass=f=60,afftdn=nr=15,deesser=i=0.5,highshelf=f=8000:g=-6";
const FADE = 0.03;
const GAP = 0.15;

interface Seg {
  /** начало имени клипа (уникальное) */
  file: string;
  /** что это за мысль (для README/отчёта) */
  label: string;
  /** SNR из `tmp/ref_noise.mts`, дБ */
  snr: number;
}

interface Spec {
  letter: string;
  target: string;
  segs: Seg[];
}

// Только мысли-наблюдения (не стоны, не реплики) из сцены осмотра Lio — того
// же тракта, что у Zoey A/B/C, поэтому сравнение честное.
const specs: Spec[] = [
  {
    letter: "A",
    target: "10–12 с: длинная мысль + короткий вопрос",
    segs: [
      {
        file: "135-76-",
        label: "76 — «Come to think of it… His pants are… Incredibly tight…»",
        snr: 49.4,
      },
      { file: "056-1330-", label: "1330 — «Did he lock himself in this thing…?»", snr: 27.6 },
    ],
  },
  {
    letter: "B",
    target: "15–18 с: три мысли, ровный тон наблюдения",
    segs: [
      {
        file: "135-76-",
        label: "76 — «Come to think of it… His pants are… Incredibly tight…»",
        snr: 49.4,
      },
      {
        file: "046-1326-",
        label: "1326 — «Pierced nipples… I guess that suits his aesthetics.»",
        snr: 38.2,
      },
      { file: "106-1335-", label: "1335 — «That's… Quite the elaborate setup…»", snr: 28.0 },
    ],
  },
  {
    letter: "C",
    target: "20–25 с: верх диапазона, проверка «даёт ли длина больше тембра»",
    segs: [
      {
        file: "135-76-",
        label: "76 — «Come to think of it… His pants are… Incredibly tight…»",
        snr: 49.4,
      },
      {
        file: "046-1326-",
        label: "1326 — «Pierced nipples… I guess that suits his aesthetics.»",
        snr: 38.2,
      },
      { file: "106-1335-", label: "1335 — «That's… Quite the elaborate setup…»", snr: 28.0 },
      { file: "056-1330-", label: "1330 — «Did he lock himself in this thing…?»", snr: 27.6 },
      { file: "098-1323-", label: "1323 — «Looks like there's a key missing here…»", snr: 15.1 },
    ],
  },
];

const abs = (p: string): string => resolveAbs(p).replace(/\\/g, "/");

function run(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function dur(p: string): number {
  return Number(
    run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      p,
    ]).stdout.trim(),
  );
}

function lufs(p: string): number {
  const r = run("ffmpeg", ["-v", "info", "-i", p, "-af", "ebur128", "-f", "null", "-"]);
  const all = [...r.stderr.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)];
  return all.length ? Number(all[all.length - 1][1]) : Number.NaN;
}

function measure(p: string): { i: string; tp: string; lra: string; thresh: string } {
  const r = run("ffmpeg", [
    "-v",
    "info",
    "-i",
    p,
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    "-f",
    "null",
    "-",
  ]);
  const m = r.stderr.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("loudnorm: нет JSON");
  const j = JSON.parse(m[0]) as Record<string, string>;
  return { i: j.input_i, tp: j.input_tp, lra: j.input_lra, thresh: j.input_thresh };
}

function resolveClip(file: string): string {
  const found = readdirSync(SRC).find((n) => n.startsWith(file) && n.endsWith(".wav"));
  if (!found) throw new Error(`не найден клип ${SRC}/${file}* — нужен дамп аудио игры`);
  return join(SRC, found).replace(/\\/g, "/");
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, "parts"), { recursive: true });
mkdirSync(OUT, { recursive: true });

const silence = join(WORK, "silence.wav").replace(/\\/g, "/");
run("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  `anullsrc=r=${SR}:cl=mono`,
  "-t",
  String(GAP),
  "-c:a",
  "pcm_s16le",
  silence,
]);

const report: Record<string, unknown>[] = [];
for (const spec of specs) {
  const parts: string[] = [];
  const segInfo: Record<string, unknown>[] = [];

  for (const [i, seg] of spec.segs.entries()) {
    const src = resolveClip(seg.file);
    const len = dur(src);
    const part = join(
      WORK,
      "parts",
      `Narrator${spec.letter}-${String(i).padStart(2, "0")}.wav`,
    ).replace(/\\/g, "/");
    const filters =
      `atrim=start=0:duration=${len.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `${CHAIN},afade=t=in:d=${FADE},afade=t=out:st=${Math.max(0, len - FADE).toFixed(3)}:d=${FADE}`;
    const r = run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      src,
      "-af",
      filters,
      "-ac",
      "1",
      "-ar",
      String(SR),
      "-c:a",
      "pcm_s16le",
      part,
    ]);
    if (r.status !== 0) throw new Error(`ffmpeg part ${part}: ${r.stderr.slice(0, 300)}`);
    parts.push(part);
    segInfo.push({
      clip: src.replace(/^tmp\/voice-refs\//, ""),
      dur: Number(len.toFixed(2)),
      snr: seg.snr,
      label: seg.label,
    });
    if (i < spec.segs.length - 1) parts.push(silence);
  }

  const list = join(WORK, `list-${spec.letter}.txt`);
  writeFileSync(list, parts.map((p) => `file '${abs(p)}'`).join("\n") + "\n");
  const joined = join(WORK, `${spec.letter}-joined.wav`).replace(/\\/g, "/");
  let r = run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c",
    "copy",
    joined,
  ]);
  if (r.status !== 0) throw new Error(`concat: ${r.stderr.slice(0, 300)}`);

  // Двухпроходный loudnorm + добивка (как в build_refs: ebur128 на коротких
  // рефах «гуляет», поэтому добиваем громкостью и держим пик лимитером).
  let cur = joined;
  for (let pass = 0; pass < 3; pass += 1) {
    const m = measure(cur);
    const ln = join(WORK, `${spec.letter}-ln${pass}.wav`).replace(/\\/g, "/");
    const r2 = run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      cur,
      "-af",
      `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thresh}:linear=false`,
      "-ac",
      "1",
      "-ar",
      String(SR),
      "-c:a",
      "pcm_s16le",
      ln,
    ]);
    if (r2.status !== 0) throw new Error(`loudnorm: ${r2.stderr.slice(0, 300)}`);
    cur = ln;
    if (Math.abs(lufs(cur) + 16) <= 0.4) break;
  }

  const delta = -16 - lufs(cur);
  if (Math.abs(delta) > 0.3) {
    const fixed = join(WORK, `${spec.letter}-fix.wav`).replace(/\\/g, "/");
    const r2 = run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      cur,
      "-af",
      `volume=${delta.toFixed(2)}dB,alimiter=limit=0.841:level=false`,
      "-ac",
      "1",
      "-ar",
      String(SR),
      "-c:a",
      "pcm_s16le",
      fixed,
    ]);
    if (r2.status !== 0) throw new Error(`trim: ${r2.stderr.slice(0, 300)}`);
    cur = fixed;
  }

  const dst = join(OUT, `${spec.letter}.wav`).replace(/\\/g, "/");
  const d = dur(cur);
  r = run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    cur,
    "-af",
    `afade=t=in:d=${FADE},afade=t=out:st=${Math.max(0, d - FADE).toFixed(3)}:d=${FADE}`,
    "-ac",
    "1",
    "-ar",
    String(SR),
    "-c:a",
    "pcm_s16le",
    dst,
  ]);
  if (r.status !== 0) throw new Error(`fades: ${r.stderr.slice(0, 300)}`);

  const meta = {
    file: dst,
    letter: spec.letter,
    target: spec.target,
    dur: Number(dur(dst).toFixed(2)),
    lufs: Number(lufs(dst).toFixed(1)),
    segs: segInfo,
  };
  report.push(meta);
  console.log(
    `${dst}  ${meta.dur} с  ${meta.lufs} LUFS  (${segInfo.length} фрагм.) — ${spec.target}`,
  );
}

writeFileSync("tmp/narrator-refs-report.json", `${JSON.stringify(report, null, 1)}\n`);
console.log(`\nготово: ${report.length} рефов -> ${OUT}`);
