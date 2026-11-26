/**
 * voice-characters.mts — карта персонажей TCNN для озвучки.
 *
 * Источник истины один — этот модуль. Числа строк взяты из снимка 2026-11-25
 * (`po/template.pot` + клипы игры), пол — из `config/speaker-gender.mts`
 * (грамматика 1-го лица; `null` = данных мало, не угадываем), роли и описания —
 * по репликам POT. Порядок ключей в `CHARACTERS` = приоритет озвучки.
 *
 * Рефы лежат в `voice-refs/<Character>/`: `candidates/` — заготовки A/B/C,
 * `chosen/` — выбранный вручную реф. Аудио в git не попадает (см. `.gitignore`),
 * поэтому `refs.chosen` проверяется тестом только когда он не `null`.
 *
 * Правки: числа и рефы менять здесь, а `docs/voice-characters.md` — читаемая
 * проекция этого файла (при расхождении верен модуль).
 */

export const CHARACTERS = {
  Zoey: {
    name: "Zoey",
    gender: "female",
    role: "главная героиня",
    description:
      "Молодая работница бара, от лица которой идёт игра: новые смены, клиенты и знакомства в неоновом городе. Sarah зовёт её «Z»; большая часть корпуса — её реплики и мысли.",
    voicedInOriginal: "yes",
    refs: {
      chosen: "voice-refs/Zoey/chosen/B.wav",
      candidates: [
        { id: "A", path: "voice-refs/Zoey/candidates/A.wav", manualCheck: "pending" },
        { id: "B", path: "voice-refs/Zoey/candidates/B.wav", manualCheck: "pending" },
        { id: "C", path: "voice-refs/Zoey/candidates/C.wav", manualCheck: "pending" },
      ],
    },
    lines: { total: 1231, toVoice: 2204 },
    priority: 1,
  },
  Max: {
    name: "Max",
    gender: null,
    role: "клерк нейл-салона",
    description:
      "Фембой-модник за стойкой салона: красит ногти, подбирает образы и охотно обсуждает клиентов. В оригинале озвучен женским тембром, поэтому пол по грамматике не выводится.",
    voicedInOriginal: "yes",
    refs: {
      chosen: null,
      candidates: [
        { id: "A", path: "voice-refs/Max/candidates/A.wav", manualCheck: "pending" },
        { id: "B", path: "voice-refs/Max/candidates/B.wav", manualCheck: "pending" },
        { id: "C", path: "voice-refs/Max/candidates/C.wav", manualCheck: "pending" },
      ],
    },
    lines: { total: 11, toVoice: 11 },
    priority: 2,
  },
  Lio: {
    name: "Lio",
    gender: "male",
    role: "близкий друг Зои",
    description:
      "Фембой с татуировками-стрелками, друг и сосед по сцене; помогает Зои и попадает в неловкие «осмотры». Весь его голос в игре — несколько коротких реплик, поэтому длинного рефа не собрать.",
    voicedInOriginal: "partial",
    refs: {
      chosen: null,
      candidates: [
        { id: "A", path: "voice-refs/Lio/candidates/A.wav", manualCheck: "pending" },
        { id: "B", path: "voice-refs/Lio/candidates/B.wav", manualCheck: "pending" },
      ],
    },
    lines: { total: 38, toVoice: 38 },
    priority: 3,
  },
  Nova: {
    name: "Nova",
    gender: null,
    role: "боец с робо-ногой",
    description:
      "Наёмница с механической ногой, ножами и двумя пистолетами; в POT о ней говорят мысли Зои. Реплики в диалоговом корпусе не размечены, но в игре есть отдельный даб на 61 секунду.",
    voicedInOriginal: "partial",
    refs: {
      chosen: null,
      candidates: [
        { id: "A", path: "voice-refs/Nova/candidates/A.wav", manualCheck: "pending" },
        { id: "B", path: "voice-refs/Nova/candidates/B.wav", manualCheck: "pending" },
        { id: "C", path: "voice-refs/Nova/candidates/C.wav", manualCheck: "pending" },
      ],
    },
    lines: { total: 0, toVoice: 0 },
    priority: 4,
  },
  Narrator: {
    name: "Narrator",
    gender: "female",
    role: "рассказчик",
    description:
      "Голос описания и мыслей от первого лица: то, что Зои думает и замечает по ходу сцен, плюс пояснения автора. Отдельного актёра в оригинале нет — мысли в четырёх озвученных сценах читает та же актриса, что и Зои, поэтому профиль отдельный только по тону (наблюдение, а не реплика).",
    voicedInOriginal: "partial",
    refs: {
      chosen: null,
      candidates: [
        { id: "A", path: "voice-refs/Narrator/candidates/A.wav", manualCheck: "pending" },
        { id: "B", path: "voice-refs/Narrator/candidates/B.wav", manualCheck: "pending" },
        { id: "C", path: "voice-refs/Narrator/candidates/C.wav", manualCheck: "pending" },
      ],
    },
    lines: { total: 4801, toVoice: 4777 },
    priority: 5,
  },
  Rosie: {
    name: "Rosie",
    gender: null,
    role: "барменша-наставница",
    description:
      "Учит Зои работе с клиентами, подбадривает и шутит; за стойкой держится уверенно. В оригинале есть только тейки дыхания, поэтому речи для рефа нет.",
    voicedInOriginal: "no",
    refs: {
      chosen: null,
      candidates: [
        {
          id: "probe",
          path: "voice-refs/Rosie/candidates/probe.wav",
          manualCheck: "pending",
          note: "контрольный образец: дыхание, а не речь; для клонирования диалога не годится",
        },
      ],
    },
    lines: { total: 15, toVoice: 15 },
    priority: 6,
  },
  Leona: {
    name: "Leona",
    gender: "female",
    role: "подруга Зои",
    description:
      "Ироничная подруга Зои: ищет пропавшего кота и готовит, посмеиваясь над собой. В игре отмечена флагом озвучки, но клипов в дампе нет.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 190, toVoice: 190 },
    priority: 7,
  },
  Klaudia: {
    name: "Klaudia",
    gender: "female",
    role: "хозяйка заведения",
    description:
      "Мадам и распорядительница бара: следит за сменами, отправляет «наверх» и требует записывать каждый заказ. Держит персонал в строгости.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 133, toVoice: 133 },
    priority: 8,
  },
  Customer: {
    name: "Customer",
    gender: "male",
    role: "посетители бара",
    description:
      "Собирательный голос клиентов: пьяные компании, торг и просьбы сфотографировать. Мужской по грамматике, встречается во многих сценах.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 124, toVoice: 124 },
    priority: 9,
  },
  Enforcer: {
    name: "Enforcer",
    gender: "male",
    role: "силовик-коррупционер",
    description:
      "Представитель новой власти, который давит на жителей и берёт взятки «натурой». По грамматике мужской, но в части сцен описан как женщина — сверить при кастинге.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 124, toVoice: 124 },
    priority: 10,
  },
  Varen: {
    name: "Varen",
    gender: "male",
    role: "постоянный клиент",
    description:
      "Вежливый завсегдатай бара, говорит размеренно и с достоинством. Готов платить больше за особые услуги.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 123, toVoice: 122 },
    priority: 11,
  },
  Trov: {
    name: "Trov",
    gender: "male",
    role: "грубый клиент",
    description:
      "Хамоватый клиент, который торопит, обзывает и требует внимания. Речь грубая, с матом и ухмылкой.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 86, toVoice: 86 },
    priority: 12,
  },
  Woman: {
    name: "Woman",
    gender: null,
    role: "посетительница (собирательно)",
    description:
      "Собирательная женская роль: просит помочь с откровенными фото и подначивает подруг. Появляется в сценах на одну-две реплики.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 71, toVoice: 71 },
    priority: 13,
  },
  Rugnar: {
    name: "Rugnar",
    gender: null,
    role: "клиент-торгаш",
    description:
      "Грубоватый клиент, который торгуется и комментирует всё подряд. Реплики короткие, с ухмылкой.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 59, toVoice: 59 },
    priority: 14,
  },
  Sarah: {
    name: "Sarah",
    gender: "female",
    role: "подруга Зои",
    description: "Энергичная подруга Зои, тянет её на маникюр и в новые затеи. Зовёт её «Z».",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 46, toVoice: 46 },
    priority: 15,
  },
  Man: {
    name: "Man",
    gender: null,
    role: "посетитель (собирательно)",
    description:
      "Собирательная мужская роль: покупатели, прохожие и работники сцены. Обычно одна-две реплики на сцену.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 41, toVoice: 41 },
    priority: 16,
  },
  Mira: {
    name: "Mira",
    gender: null,
    role: "робкая посетительница",
    description:
      "Застенчивая девушка, которая заикается и стесняется просить. Становится заметно смелее, когда речь заходит о её желаниях.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 36, toVoice: 36 },
    priority: 17,
  },
  Salesman: {
    name: "Salesman",
    gender: null,
    role: "торговец «мясными» телами",
    description:
      "Циничный продавец тел на переработку (upcycling): расхваливает товар и подначивает покупателя. Говорит гладко, с ехидством.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 33, toVoice: 33 },
    priority: 18,
  },
  Bunnyboy: {
    name: "Bunnyboy",
    gender: null,
    role: "работник клуба",
    description:
      "Клубный работник в костюме зайчика: зазывает гостей и предлагает услуги. В одной сцене его зовут Саймон.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 26, toVoice: 26 },
    priority: 19,
  },
  Femboy: {
    name: "Femboy",
    gender: null,
    role: "работник клуба",
    description:
      "Молодой работник клуба, который подчиняется Klaudia и робеет перед гостями. Старается держаться профессионально, но смущается.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 15, toVoice: 15 },
    priority: 20,
  },
  Intercom: {
    name: "Intercom",
    gender: null,
    role: "голос интеркома",
    description:
      "Голос устройства или интеркома, который просит о помощи и сбивается на стоны. Звучит как запись или искажённая связь.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 14, toVoice: 14 },
    priority: 21,
  },
  Brad: {
    name: "Brad",
    gender: null,
    role: "сосед-заказчик",
    description:
      "Сосед, который нанимает Зои на подработку и платит «fuckbucks». Простоватый, но дружелюбный.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 11, toVoice: 11 },
    priority: 22,
  },
  Jay: {
    name: "Jay",
    gender: null,
    role: "работник клуба (фембой)",
    description:
      "Фембой из клуба; в POT всего несколько реплик, флаг озвучки есть, но клипов в дампе нет.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 3, toVoice: 3 },
    priority: 23,
  },
  Bunnygirl: {
    name: "Bunnygirl",
    gender: null,
    role: "работница клуба за стойкой",
    description:
      "Девушка в костюме зайчика за стойкой: предлагает напитки и поддерживает настроение. Появляется в клубных сценах.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 6, toVoice: 6 },
    priority: 24,
  },
  "Cartel Guy": {
    name: "Cartel Guy",
    gender: null,
    role: "клиент клуба",
    description:
      "Клиент клуба, который приглашает выпить и наблюдает за представлением. Несколько реплик в клубной сцене.",
    voicedInOriginal: "no",
    refs: { chosen: null, candidates: [] },
    lines: { total: 4, toVoice: 4 },
    priority: 25,
  },
} as const satisfies Record<string, Character>;

export type CharacterName = keyof typeof CHARACTERS;

/**
 * Спикеры POT → персонаж каста. `null` — осознанно без персонажа: служебные
 * спикеры UI/ассетов, реакции-эмоции и второстепенные роли, которых в текущей
 * карте каста нет. Тест сверяет этот словарь с `po/template.pot` в обе стороны.
 */
export const SPEAKER_TO_CHARACTER = {
  Zoey: "Zoey",
  Max: "Max",
  Lio: "Lio",
  Rosie: "Rosie",
  Leona: "Leona",
  Klaudia: "Klaudia",
  Customer: "Customer",
  Enforcer: "Enforcer",
  Varen: "Varen",
  Trov: "Trov",
  Woman: "Woman",
  Rugnar: "Rugnar",
  Sarah: "Sarah",
  Man: "Man",
  Mira: "Mira",
  Salesman: "Salesman",
  Bunnyboy: "Bunnyboy",
  Femboy: "Femboy",
  Intercom: "Intercom",
  Brad: "Brad",
  Jay: "Jay",
  Bunnygirl: "Bunnygirl",
  "Cartel Guy": "Cartel Guy",

  // Служебные спикеры ассетов/UI (не реплики персонажей).
  AboultCauldron: null,
  Anne: null,
  Ashley: null,
  AskAboutThem: null,
  Athletic: null,
  Dialogue: null,
  Guy: null,
  MusicToPlay: null,
  OnChoiceSelected: null,
  SaveKey: null,

  // Выборы/реакции интерфейса и эмоции-спикеры.
  Agree: null,
  Angry: null,
  Cancel: null,
  Cocky: null,
  Confused: null,
  Decline: null,
  FINISHED: null,
  Grin: null,
  Horny: null,
  Idle: null,
  Laugh: null,
  Laughing: null,
  Leave: null,
  Lewd: null,
  Look: null,
  Mewing: null,
  Pouting: null,
  Remove: null,
  Sad: null,
  Scheming: null,
  Surprised: null,
  Yes: null,

  // Устройства и второстепенные роли вне текущей карты каста.
  Cook: null,
  Machine: null,
} as const satisfies Record<string, CharacterName | null>;

export type Gender = "female" | "male" | null;
export type VoicedInOriginal = "yes" | "partial" | "no";

/** Статус ручной проверки рефа ухом. `pending` — ещё никто не слушал. */
export type ManualCheck = "pending" | "passed" | "failed";

export type RefCandidate = {
  /** Короткий идентификатор варианта: A/B/C, probe и т. п. */
  readonly id: string;
  /** Путь от корня репозитория. Аудио в git не трекается. */
  readonly path: string;
  readonly manualCheck: ManualCheck;
  readonly note?: string;
};

export type Character = {
  readonly name: string;
  readonly gender: Gender;
  /** Короткая роль: «главная героиня», «барменша-наставница» и т. п. */
  readonly role: string;
  /** Кто это по сюжету, 1–2 предложения (не описание тембра). */
  readonly description: string;
  readonly voicedInOriginal: VoicedInOriginal;
  readonly refs: {
    /** Путь к выбранному рефу или `null`, пока владелец не выбрал. */
    readonly chosen: string | null;
    readonly candidates: readonly RefCandidate[];
  };
  /** `total` — явные строки `speaker:<Имя>`; `toVoice` — без чистых стонов. */
  readonly lines: { readonly total: number; readonly toVoice: number };
  readonly priority: number;
};
