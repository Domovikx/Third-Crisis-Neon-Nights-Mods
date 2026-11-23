/**
 * speaker_gender.mts — карта «спикер → пол», выведенная из самого корпуса.
 *
 * Зачем: в игре у 67 % диалоговых строк спикера нет вовсе (нарратив и мысли), а
 * у остальных он есть, но пола нет нигде. Модель выводила род из имени и
 * ошибалась (Trov «я уронила», Zoey «что я такого сделал» — оба пойманы
 * 2026-11-23). Здесь пол считается по данным: в реплике персонажа формы 1-го
 * лица прошедшего времени выдают его пол («я пришёл» / «я пришла»).
 *
 * Правило простое и проверяемое: пол фиксируется, если набралось не меньше
 * `minEvidence` наблюдений и перевес одной стороны не меньше `margin`.
 * Иначе — `null` (не угадываем). Счётчики хранятся рядом с решением: по ним
 * видно, на чём оно основано, и их же можно перепроверить руками.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { parsePo, type PoEntry } from "../.opencode/skills/extract-text/scripts/po_file.mts";

/** Корень репозитория: scripts/ → на уровень выше. */
export const REPO_ROOT = resolve(import.meta.dirname, "..");

/** Формы 1-го лица прошедшего времени: «я … пришёл/пришла». */
export const FEM_RX = /(?<![\p{L}])я\s+(?:[^.!?…]{0,20}?)([а-яё]+ла)(?![\p{L}])/giu;
export const MASC_RX = /(?<![\p{L}])я\s+(?:[^.!?…]{0,20}?)([а-яё]+л)(?![\p{L}])(?![а-яё])/giu;

/**
 * Второй источник свидетельств — краткие формы при «я»: они не склоняются по
 * времени и однозначны по полу («я рад» / «я рада»). Соседние слова допускаются,
 * но только до двух: «я, честно говоря, сама…» — да, «ты сама» — нет (это адресат).
 */
export const FEM_ADJ_RX =
  /(?<![\p{L}])я\s+(?:\S+\s+){0,2}?(?:рада|готова|должна|уверена|согласна|виновата|сама|одна|замужем)(?![\p{L}])/giu;
export const MASC_ADJ_RX =
  /(?<![\p{L}])я\s+(?:\S+\s+){0,2}?(?:рад|готов|должен|уверен|согласен|виноват|сам|один|женат)(?![\p{L}])/giu;

export type Gender = "female" | "male" | null;

/** Одно решение карты: пол и наблюдения, на которых он основан. */
export interface GenderEntry {
  gender: Gender;
  fem: number;
  masc: number;
}

export type GenderMap = Record<string, GenderEntry>;

const DEFAULT_MIN_EVIDENCE = 4;
const DEFAULT_MARGIN = 0.75;

/**
 * Посчитать карту по записям PO.
 *
 * Берутся только строки со спикером: у нарратива спикера нет, и приписывать ему
 * пол нельзя (часть «мыслей» принадлежит мужским персонажам).
 */
export function buildGenderMap(
  entries: PoEntry[],
  minEvidence = DEFAULT_MIN_EVIDENCE,
  margin = DEFAULT_MARGIN,
): GenderMap {
  const counts = new Map<string, { fem: number; masc: number }>();
  for (const e of entries) {
    if (!e.msgctxt.startsWith("speaker:") || !e.msgstr) continue;
    const name = e.msgctxt.slice("speaker:".length).trim();
    if (!name) continue;
    const rec = counts.get(name) ?? { fem: 0, masc: 0 };
    rec.fem += [...e.msgstr.matchAll(FEM_RX)].length + [...e.msgstr.matchAll(FEM_ADJ_RX)].length;
    rec.masc += [...e.msgstr.matchAll(MASC_RX)].length + [...e.msgstr.matchAll(MASC_ADJ_RX)].length;
    counts.set(name, rec);
  }

  const map: GenderMap = {};
  for (const [name, c] of counts) {
    const total = c.fem + c.masc;
    const gender: Gender =
      total < minEvidence
        ? null
        : c.fem >= total * margin
          ? "female"
          : c.masc >= total * margin
            ? "male"
            : null;
    map[name] = { gender, fem: c.fem, masc: c.masc };
  }
  return map;
}

/** Прочитать сохранённую карту; нет файла — пустая карта (промпт без пола). */
export function loadGenderMap(root: string): Map<string, "female" | "male"> {
  const out = new Map<string, "female" | "male">();
  try {
    const json = JSON.parse(readFileSync(join(root, "config", "speaker-gender.json"), "utf8")) as {
      speakers?: GenderMap;
    };
    for (const [name, e] of Object.entries(json.speakers ?? {})) {
      if (e.gender) out.set(name, e.gender);
    }
  } catch {
    // файла нет — это нормально: промпт просто не получит подсказку
  }
  return out;
}

/** Сериализовать карту в формат конфига. */
export function renderGenderConfig(map: GenderMap, minEvidence = DEFAULT_MIN_EVIDENCE): string {
  const speakers: GenderMap = {};
  for (const name of Object.keys(map).sort()) speakers[name] = map[name];
  return `${JSON.stringify(
    {
      _comment:
        "Пол персонажа, выведенный из корпуса: формы 1-го лица прошедшего времени в репликах со спикером (я пришёл / я пришла). gender=null — наблюдений мало или перевес меньше порога, не угадываем. Файл генерится scripts/speaker_gender.mts --write; руками не править. Замер 2026-11-23: 53 спикера, у главных перевес 10:1 и выше.",
      min_evidence: minEvidence,
      speakers,
    },
    null,
    2,
  )}\n`;
}

// --- CLI --------------------------------------------------------------------

/**
 * `node scripts/speaker_gender.mts [--write] [--lang ru]`
 *
 * Без `--write` печатает карту (счётчики видны), с `--write` пишет
 * `config/speaker-gender.json` для промпта.
 */
if (import.meta.filename === process.argv[1]) {
  const lang = process.argv.includes("--lang")
    ? process.argv[process.argv.indexOf("--lang") + 1]
    : "ru";
  const write = process.argv.includes("--write");
  const entries = parsePo(readFileSync(join(REPO_ROOT, "po", `${lang}.po`), "utf8"));
  const map = buildGenderMap(entries);
  const known = Object.entries(map).filter(([, e]) => e.gender);
  if (write) {
    writeFileSync(
      join(REPO_ROOT, "config", "speaker-gender.json"),
      renderGenderConfig(map),
      "utf8",
    );
    console.log(
      `config/speaker-gender.json: ${Object.keys(map).length} спикеров, известен пол у ${known.length}`,
    );
  } else {
    for (const [name, e] of Object.entries(map).sort(
      (a, b) => b[1].fem + b[1].masc - (a[1].fem + a[1].masc),
    )) {
      console.log(
        `${name.padEnd(22)} fem=${String(e.fem).padStart(3)} masc=${String(e.masc).padStart(3)} → ${e.gender ?? "?"}`,
      );
    }
  }
}
