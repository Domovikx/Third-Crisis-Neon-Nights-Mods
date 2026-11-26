/**
 * language-priority.mts — ИСТОЧНИК ИСТИНЫ: состав и порядок языков.
 *
 * Порядок утверждён по статистике Steam Hardware Survey (октябрь 2026);
 * любой список языков в UI, доках и скриптах выводится В ЭТОМ ПОРЯДКЕ.
 * Новый язык = строка в `languages` (по доле), затем синхронизация списков.
 *
 * JSON-артефакт `config/language-priority.json` генерируется из этого модуля
 * и руками НЕ правится: его читают Rust (`tools/rust-lint`) и скрипты.
 * После правки:
 *   node config/language-priority.mts > config/language-priority.json
 * Равенство JSON модулю стережёт `config/language-priority.test.mts`.
 */
import process from "node:process";

import { renderJson } from "./emit.mts";

export interface LanguageEntry {
  readonly rank: number;
  readonly code: string;
  readonly language: string;
  readonly share: number;
}

export interface LanguagePriorityConfig {
  readonly _comment: string;
  readonly source: string;
  readonly updated: string;
  readonly languages: readonly LanguageEntry[];
}

export const LANGUAGE_PRIORITY = {
  _comment:
    "ПРИОРИТЕТ ЯЗЫКОВ — единый источник истины для ПОРЯДКА отображения языков (переключатель в игре NeonLanguageSwitcher, списки на сайте, будущие списки). Данные: языковая статистика Steam Hardware Survey, октябрь 2026 (store.steampowered.com/hwsurvey; владелец утвердил 2026-11-13). Правило: любой список языков в UI выводится В ЭТОМ ПОРЯДКЕ; новый язык = строка сюда (по доле) + синхронизация списков. it — 11-й (0.64%, вне топ-10 владельца).",
  source: "Steam Hardware Survey, October 2026",
  updated: "2026-11-13",
  languages: [
    {
      rank: 1,
      code: "en",
      language: "English",
      share: 39.04,
    },
    {
      rank: 2,
      code: "zh",
      language: "Chinese",
      share: 23.28,
    },
    {
      rank: 3,
      code: "ru",
      language: "Russian",
      share: 10.14,
    },
    {
      rank: 4,
      code: "es",
      language: "Spanish",
      share: 5.72,
    },
    {
      rank: 5,
      code: "pt",
      language: "Portuguese",
      share: 4.65,
    },
    {
      rank: 6,
      code: "de",
      language: "German",
      share: 2.89,
    },
    {
      rank: 7,
      code: "ja",
      language: "Japanese",
      share: 2.47,
    },
    {
      rank: 8,
      code: "fr",
      language: "French",
      share: 2.41,
    },
    {
      rank: 9,
      code: "pl",
      language: "Polish",
      share: 1.73,
    },
    {
      rank: 10,
      code: "ko",
      language: "Korean",
      share: 1.36,
    },
    {
      rank: 11,
      code: "it",
      language: "Italian",
      share: 0.64,
    },
  ],
} as const satisfies LanguagePriorityConfig;

/** Код языка из конфига (`en` | `zh` | …) — юнион литералов. */
export type LanguageCode = (typeof LANGUAGE_PRIORITY.languages)[number]["code"];

if (import.meta.filename === process.argv[1]) {
  process.stdout.write(await renderJson(LANGUAGE_PRIORITY));
}
