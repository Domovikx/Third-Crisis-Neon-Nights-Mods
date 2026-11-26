/**
 * pot-skip-policy.mts — ИСТОЧНИК ИСТИНЫ: политика «этой строке перевод не нужен».
 *
 * Правило = id + метка `src` (та же грамматика, что у политики отбора:
 * точная метка или префикс `*`) + необязательный `srcExclude` + условие
 * `when` из `pot_skip.mts`. Совпавшие записи ОСТАЮТСЯ в POT с `#, skip` и
 * `#. skip: <id>`: ничего не удаляется. Выключить правило — `enabled: false`,
 * выключить всё — `rules: []`.
 *
 * JSON-артефакт `config/pot-skip-policy.json` читает potgen (Rust) и TS-проверки;
 * руками он не правится. После правки:
 *   node config/pot-skip-policy.mts > config/pot-skip-policy.json
 * Равенство стережёт `config/pot-skip-policy.test.mts`. Описание правил и
 * замеры — docs/pot-skip.md.
 */
import process from "node:process";

import { renderJson } from "./emit.mts";

export interface SkipRuleConfig {
  readonly id: string;
  readonly src: string;
  readonly srcExclude?: readonly string[];
  readonly when: string;
  readonly enabled?: boolean;
}

export interface SkipPolicyConfig {
  readonly _comment: string;
  /** Пояснение к каждому id (данные, не исполняется). */
  readonly _rules: Readonly<Record<string, string>>;
  readonly rules: readonly SkipRuleConfig[];
}

export const POT_SKIP_POLICY = {
  _comment:
    'Политика «этой строке перевод не нужен» (docs/pot-skip.md). Правило = id + метка #. src: (та же грамматика, что у политики отбора: точная метка или префикс *) + необязательный srcExclude (метки, которые правило НЕ трогает) + условие when из pot_skip.mts. Помеченные записи ОСТАЮТСЯ в POT: получают `#, skip` и `#. skip: <id>`, в po/*.po не попадают, в модель не уходят. Ничего не удаляется. Выключить правило — удалить его отсюда или поставить enabled:false; выключить всё — `"rules": []`. Замеры и примеры по каждому правилу — tmp/pot-skip-review.md.',
  _rules: {
    "no-letters":
      "в ключе нет ни одной буквы (только цифры/пунктуация/пробелы). На POT 2026-11-23 совпадений 0 — правило оставлено как дешёвая страховка.",
    "short-token":
      "нет пробелов и ≤12 символов. Основной фильтр бинарного мусора raw-скана (94% попаданий — символы, а не слова). Исключён raw:MonoBehaviour (srcExclude): там лежат настоящие подписи ACCESS, ACHIEVEMENTS, SAVEFILENAME — они остаются переводимыми.",
    "no-word":
      "в ключе нет ни одного токена из ≥3 букв. Закрывает шум с пробелом (`wK Ax`, `w? |b`, `j A`), который не ловит short-token; настоящие подписи (ACCESS) не трогает — у них есть слово.",
    fragment:
      "ключ — хвост rich_text (дефект дампа: text обрезан). Чистка только известных TMP-тегов, порог ≥10 символов и ≥2 слов.",
    identifier:
      "программный идентификатор: CamelCase из ≥2 горбов, snake_case или CONST_CASE (AbilityName, Camera_Flash, DEFAULT_KEY). Структурный признак, не «по виду»: слова с заглавной (Accept), аббревиатуры (ACCESS) и дефисы (Neon-Trust) остаются переводимыми.",
    tokens:
      "шаблон с подстановкой: есть токен #Имя#, {Имя} или printf-стиль %s. Игра собирает из такого пресета строку (Received #ItemName#. → Received Iron Dagger.), поэтому переводить сам шаблон бессмысленно: рантайм ищет точное совпадение и его никогда не увидит. 2026-11-23: 5 записей.",
    "hex-color":
      "Явный цвет #RRGGBB (3–8 hex-цифр) из кучи #US: константа, а не текст. 2026-11-23: 3 записи (#FFD24A, #8A8F98, #A64141). Без # не срабатывает намеренно: ADDDDD/EDDDDD — имена Timeline-треков.",
    "save-key":
      "save-ключ игры: до первого / стоит ...Keys или ...Key (GlowingHoleKeys/103 Peeking Counter, CartelHideoutBadendKeys/Did get naked). Идентификатор состояния, игрок его не видит. 2026-11-23: 85 записей.",
    "snake-case":
      "snake_case-токен внутри ключа (CC_Option_Outfit_*, Apl_Female_*, PMA_IsNude): имя ассета/состояния/отладочное сообщение Unity, а не текст для игрока. 2026-11-23: 415 живых записей, в диалогах — одна (путь к ассету).",
    "fsm-label":
      "метка FSM (ключ начинается со слова FSM: `FSM Lio Printer`, `FSM Nova Moving In`): имя машины состояний Unity, игрок его не видит. 2026-11-23: 12 живых записей.",
    "state-name":
      "метка состояния/действия (`Bark 12`, `Choice1`, `Agree2`, `Disable2`): ветка диалога, а не текст для игрока. 2026-11-23: 130 живых записей — крупнейший остаток «перевод = оригинал».",
    "code-ref":
      "ссылка на код: путь без пробелов и расширения (`Dialogue/Auto`) или имя типа .NET (`X, Assembly-CSharp`). 2026-11-23: 27 записей.",
  },
  rules: [
    {
      id: "no-letters",
      src: "raw:*",
      when: "noLetters",
    },
    {
      id: "short-token",
      src: "raw:*",
      srcExclude: ["raw:MonoBehaviour"],
      when: "shortToken",
    },
    {
      id: "no-word",
      src: "raw:*",
      when: "noWord",
    },
    {
      id: "identifier",
      src: "raw:*",
      when: "identifier",
    },
    {
      id: "tokens",
      src: "*",
      when: "tokens",
    },
    {
      id: "hex-color",
      src: "*",
      when: "hexColor",
    },
    {
      id: "save-key",
      src: "*",
      when: "saveKey",
    },
    {
      id: "snake-case",
      src: "*",
      when: "snakeCase",
    },
    {
      id: "fsm-label",
      src: "*",
      when: "fsmLabel",
    },
    {
      id: "state-name",
      src: "*",
      when: "stateName",
    },
    {
      id: "code-ref",
      src: "*",
      when: "codeRef",
    },
    {
      id: "fragment",
      src: "*",
      when: "fragment",
    },
  ],
} as const satisfies SkipPolicyConfig;

if (import.meta.filename === process.argv[1]) {
  process.stdout.write(await renderJson(POT_SKIP_POLICY));
}
