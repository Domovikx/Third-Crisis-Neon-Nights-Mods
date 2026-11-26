/**
 * name-canon.mts — ИСТОЧНИК ИСТИНЫ: канон имён персонажей, одна форма на язык.
 *
 * Зачем: имя в переводе — «ключ» к персонажу. Разнобой (`利奥` / `莉奥` / `Lio`)
 * делает из одного человека трёх, а поиск по имени ломается.
 *
 * - `canon` — имена, у которых есть строка `msgctxt "speaker-name"`; тест
 *   требует, чтобы каждый PO был с ней согласен;
 * - `extra` — имена без `speaker-name` (Jaime, Rungar): сверяются только
 *   варианты в тексте;
 * - `wrong` — формы, которых в переводе быть не должно (ловятся с границами
 *   слова; правила и порчи — `scripts/name_canon.mts`).
 *
 * JSON-артефакта нет: модуль читают только TS-проверки
 * (`scripts/name_canon.mts`). Проверка данных — `scripts/name_canon.test.mts`.
 */

/** Языки перевода — порядок приоритета (en — источник, его в каноне нет). */
export const NAME_LANGS = ["zh", "ru", "es", "pt", "de", "ja", "fr", "pl", "ko", "it"] as const;

export type NameLang = (typeof NAME_LANGS)[number];

/** Одна форма имени на каждый язык перевода. */
export type NameForms = Readonly<Record<NameLang, string>>;

export interface NameCanon {
  readonly order: readonly NameLang[];
  /** Имена со строкой `speaker-name`. */
  readonly canon: Readonly<Record<string, NameForms>>;
  /** Имена без `speaker-name`: только проверка вариантов в тексте. */
  readonly extra: Readonly<Record<string, NameForms>>;
  /** Запрещённые формы по языкам: имя → варианты. */
  readonly wrong: Readonly<Partial<Record<NameLang, Readonly<Record<string, readonly string[]>>>>>;
}

export const NAME_CANON = {
  order: NAME_LANGS,
  canon: {
    Anne: {
      zh: "安妮",
      ru: "Энн",
      es: "Anne",
      pt: "Anne",
      de: "Anne",
      ja: "アン",
      fr: "Anne",
      pl: "Anne",
      ko: "앤",
      it: "Anne",
    },
    Ashley: {
      zh: "艾什莉",
      ru: "Эшли",
      es: "Ashley",
      pt: "Ashley",
      de: "Ashley",
      ja: "アシュリー",
      fr: "Ashley",
      pl: "Ashley",
      ko: "애슐리",
      it: "Ashley",
    },
    Brad: {
      zh: "布拉德",
      ru: "Брэд",
      es: "Brad",
      pt: "Brad",
      de: "Brad",
      ja: "ブラッド",
      fr: "Brad",
      pl: "Brad",
      ko: "브래드",
      it: "Brad",
    },
    Jay: {
      zh: "杰伊",
      ru: "Джей",
      es: "Jay",
      pt: "Jay",
      de: "Jay",
      ja: "ジェイ",
      fr: "Jay",
      pl: "Jay",
      ko: "제이",
      it: "Jay",
    },
    Klaudia: {
      zh: "克劳迪娅",
      ru: "Клавдия",
      es: "Klaudia",
      pt: "Klaudia",
      de: "Klaudia",
      ja: "クラウディア",
      fr: "Klaudia",
      pl: "Klaudia",
      ko: "클라우디아",
      it: "Klaudia",
    },
    Leona: {
      zh: "莉昂娜",
      ru: "Леона",
      es: "Leona",
      pt: "Leona",
      de: "Leona",
      ja: "レオナ",
      fr: "Leona",
      pl: "Leona",
      ko: "레오나",
      it: "Leona",
    },
    Lio: {
      zh: "利奥",
      ru: "Лио",
      es: "Lio",
      pt: "Lio",
      de: "Lio",
      ja: "リオ",
      fr: "Lio",
      pl: "Lio",
      ko: "리오",
      it: "Lio",
    },
    Max: {
      zh: "马克斯",
      ru: "Макс",
      es: "Max",
      pt: "Max",
      de: "Max",
      ja: "マックス",
      fr: "Max",
      pl: "Max",
      ko: "맥스",
      it: "Max",
    },
    Mira: {
      zh: "米拉",
      ru: "Мира",
      es: "Mira",
      pt: "Mira",
      de: "Mira",
      ja: "ミラ",
      fr: "Mira",
      pl: "Mira",
      ko: "미라",
      it: "Mira",
    },
    Rosie: {
      zh: "罗茜",
      ru: "Рози",
      es: "Rosie",
      pt: "Rosie",
      de: "Rosie",
      ja: "ロージー",
      fr: "Rosie",
      pl: "Rosie",
      ko: "로지",
      it: "Rosie",
    },
    Rugnar: {
      zh: "鲁格纳",
      ru: "Ругнар",
      es: "Rugnar",
      pt: "Rugnar",
      de: "Rugnar",
      ja: "ルングナー",
      fr: "Rugnar",
      pl: "Rugnar",
      ko: "루그나르",
      it: "Rugnar",
    },
    Sarah: {
      zh: "莎拉",
      ru: "Сара",
      es: "Sarah",
      pt: "Sarah",
      de: "Sarah",
      ja: "サラ",
      fr: "Sarah",
      pl: "Sarah",
      ko: "사라",
      it: "Sarah",
    },
    Trov: {
      zh: "特罗夫",
      ru: "Тров",
      es: "Trov",
      pt: "Trov",
      de: "Trov",
      ja: "トロフ",
      fr: "Trov",
      pl: "Trov",
      ko: "트로프",
      it: "Trov",
    },
    Varen: {
      zh: "瓦伦",
      ru: "Варен",
      es: "Varen",
      pt: "Varen",
      de: "Varen",
      ja: "ヴァレン",
      fr: "Varen",
      pl: "Varen",
      ko: "바렌",
      it: "Varen",
    },
    Zoey: {
      zh: "佐伊",
      ru: "Зои",
      es: "Zoey",
      pt: "Zoey",
      de: "Zoey",
      ja: "ゾーイ",
      fr: "Zoey",
      pl: "Zoey",
      ko: "조이",
      it: "Zoey",
    },
  },
  extra: {
    Jaime: {
      zh: "杰米",
      ru: "Джейми",
      es: "Jaime",
      pt: "Jaime",
      de: "Jaime",
      ja: "ジェイミー",
      fr: "Jaime",
      pl: "Jaime",
      ko: "제이미",
      it: "Jaime",
    },
    Rungar: {
      zh: "伦加尔",
      ru: "Рунгар",
      es: "Rungar",
      pt: "Rungar",
      de: "Rungar",
      ja: "ルンガー",
      fr: "Rungar",
      pl: "Rungar",
      ko: "룽가르",
      it: "Rungar",
    },
  },
  wrong: {
    zh: {
      Lio: ["莉奥", "Lio"],
      Rungar: ["鲁格纳", "龙纳尔", "龙加尔", "朗加尔", "润加尔", "伦加"],
      Rugnar: ["伦加尔", "龙纳尔", "龙加尔", "朗加尔", "润加尔", "伦加"],
    },
    ru: {
      Rungar: ["Ругнар"],
      Rugnar: ["Рунгар"],
    },
    ja: {
      Jaime: ["ハイメ", "ハイム"],
      Rungar: ["ルングナー", "ルングァー", "ランガー", "ルングアル", "ルングアール", "ルングアー"],
      Rugnar: [
        "ルグナー",
        "ルンガー",
        "ルングァー",
        "ランガー",
        "ルングアル",
        "ルングアール",
        "ルングアー",
      ],
    },
    ko: {
      Rungar: ["루그나르"],
      Rugnar: ["룽가르"],
    },
    it: {
      Mira: ["Guarda"],
      Rungar: ["Rugnar"],
      Rugnar: ["Rungar"],
    },
    de: {
      Rungar: ["Rugnar"],
      Rugnar: ["Rungar"],
    },
    es: {
      Rungar: ["Rugnar"],
      Rugnar: ["Rungar"],
    },
    pt: {
      Rungar: ["Rugnar"],
      Rugnar: ["Rungar"],
    },
    fr: {
      Rungar: ["Rugnar"],
      Rugnar: ["Rungar"],
    },
    pl: {
      Rungar: ["Rugnar"],
      Rugnar: ["Rungar"],
    },
  },
} as const satisfies NameCanon;
