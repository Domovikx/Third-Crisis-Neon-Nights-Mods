/**
 * speaker-gender.mts — карта «спикер → пол», выведенная из корпуса.
 *
 * АРТЕФАКТ ГЕНЕРАЦИИ: руками не править, пересобрать
 *   node scripts/speaker_gender.mts --write
 * Источник — формы 1-го лица прошедшего времени в `po/ru.po`
 * («я пришёл» / «я пришла»); алгоритм и пороги — `scripts/speaker_gender.mts`.
 *
 * Зачем: у 67 % строк спикера нет вовсе, а пола нет нигде; модель выводила род из
 * имени и ошибалась (Trov «я уронила», Zoey «что я такого сделал» — поймано
 * 2026-11-23). Пол фиксируется, если наблюдений ≥ `min_evidence` и перевес одной
 * стороны ≥ 0.75; иначе `null` (не угадываем). Счётчики лежат рядом с решением,
 * поэтому видно, на чём оно основано.
 *
 * JSON-артефакта нет: файл читает только TS (`scripts/qa_judge.mts`).
 */

export type Gender = "female" | "male" | null;

/** Одно решение карты: пол и наблюдения, на которых он основан. */
export interface GenderEntry {
  readonly gender: Gender;
  readonly fem: number;
  readonly masc: number;
}

export type SpeakerGenderMap = Readonly<Record<string, GenderEntry>>;

export interface SpeakerGenderConfig {
  readonly min_evidence: number;
  readonly speakers: SpeakerGenderMap;
}

export const SPEAKER_GENDER = {
  min_evidence: 4,
  speakers: {
    "AboultCauldron": { gender: null, fem: 0, masc: 0 },
    "Agree": { gender: null, fem: 0, masc: 0 },
    "AskAboutThem": { gender: null, fem: 0, masc: 0 },
    "Athletic": { gender: null, fem: 0, masc: 0 },
    "Brad": { gender: null, fem: 0, masc: 1 },
    "Bunnyboy": { gender: null, fem: 0, masc: 3 },
    "Bunnygirl": { gender: null, fem: 0, masc: 0 },
    "Cancel": { gender: null, fem: 0, masc: 0 },
    "Cartel Guy": { gender: null, fem: 0, masc: 0 },
    "Cocky": { gender: null, fem: 0, masc: 0 },
    "Cook": { gender: null, fem: 0, masc: 0 },
    "Customer": { gender: "male", fem: 0, masc: 4 },
    "Decline": { gender: null, fem: 0, masc: 0 },
    "Dialogue": { gender: null, fem: 0, masc: 0 },
    "Enforcer": { gender: "male", fem: 0, masc: 5 },
    "FINISHED": { gender: null, fem: 0, masc: 0 },
    "Femboy": { gender: null, fem: 0, masc: 1 },
    "Guy": { gender: null, fem: 0, masc: 0 },
    "Idle": { gender: null, fem: 0, masc: 0 },
    "Intercom": { gender: null, fem: 0, masc: 0 },
    "Jay": { gender: null, fem: 0, masc: 0 },
    "Klaudia": { gender: "female", fem: 11, masc: 0 },
    "Leave": { gender: null, fem: 0, masc: 0 },
    "Leona": { gender: "female", fem: 25, masc: 0 },
    "Lewd": { gender: null, fem: 0, masc: 0 },
    "Lio": { gender: "male", fem: 0, masc: 6 },
    "Look": { gender: null, fem: 0, masc: 0 },
    "Machine": { gender: null, fem: 0, masc: 0 },
    "Man": { gender: null, fem: 0, masc: 3 },
    "Max": { gender: null, fem: 0, masc: 0 },
    "Mewing": { gender: null, fem: 0, masc: 0 },
    "Mira": { gender: null, fem: 2, masc: 0 },
    "OnChoiceSelected": { gender: null, fem: 0, masc: 0 },
    "Rosie": { gender: null, fem: 1, masc: 0 },
    "Rugnar": { gender: null, fem: 0, masc: 0 },
    "Salesman": { gender: null, fem: 0, masc: 2 },
    "Sarah": { gender: "female", fem: 9, masc: 0 },
    "Scheming": { gender: null, fem: 0, masc: 0 },
    "Surprised": { gender: null, fem: 0, masc: 0 },
    "Trov": { gender: "male", fem: 0, masc: 6 },
    "Varen": { gender: "male", fem: 2, masc: 8 },
    "Woman": { gender: null, fem: 3, masc: 0 },
    "Yes": { gender: null, fem: 0, masc: 0 },
    "Zoey": { gender: "female", fem: 71, masc: 4 },
  },
} as const satisfies SpeakerGenderConfig;
