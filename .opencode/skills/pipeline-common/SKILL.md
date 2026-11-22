---
name: pipeline-common
description: Общие фильтры пайплайна dump-assets/extract-text (text_filters.mts) — единственный источник правды для skip-списков, имён ассетов и бинарного мусора
license: MIT
compatibility: opencode
---

# pipeline-common — общий код пайплайна

Единственное разрешённое исключение из правила «импортов между скиллами нет»:
`extract-text` (и python-остров `dump-assets`) берут фильтры **отсюда**.
Правка списков — только в этом файле, копии запрещены.

## Что импортировать

```ts
import {
  SKIP_RAW_PREFIXES,
  KNOWN_NON_SPEAKERS,
  isSkipPrefix,
  isAssetName,
  isGarbageFragment,
  stripRich,
  autoTriage,
  RICH_TAG_RX,
} from "../../pipeline-common/scripts/text_filters.mts";
```

Канонический источник — **`.mts`**. Python-версия (`text_filters.py`) удалена
2026-11-22 вместе с дампером: импортировать нечего и дублировать не нужно.

## Экспорты (`scripts/text_filters.mts`)

- `SKIP_RAW_PREFIXES` — префиксы `raw_strings`, которые не диалоги
  (`line_`, `expressions/`, `Poses/`, `Char_`, `_Preset`, …).
- `KNOWN_NON_SPEAKERS` — имена, которые не спикеры (`Narrator`, `Confirm`,
  `Simon`, `GlowingHole`, Dialogue Presets).
- `isSkipPrefix(s)` — строка начинается с запрещённого префикса.
- `isAssetName(s)` — Unity-компонент/скрипт (`NNHsvRenderer`, `EventSystem`,
  `NodeLink2`). Правило «любая цифра = ассет» работает только без пробелов.
- `isGarbageFragment(s)` — бинарный мусор (`Bff?D`, `%IR`, любые `\`).
- `autoTriage(text)` — `{translation, skipTranslation}` для ассетов/мусора,
  иначе `null`. Применять **только** к raw/settings, никогда к диалогам.
- `stripRich(s)` / `RICH_TAG_RX` — снять TMP-теги и обрезать пробелы.

## Правила применения

- Диалоги (`dialogues`, `fsm_strings`, бандлы PlayMaker) не фильтруются:
  в истории встречается что угодно, включая цифры и проценты.
- Человеческий skip сильнее авто-флага: авто-триаж не перетирает перевод.
- Фильтры — эвристики с известной ценой (см. `MAP.md`: длинные описания,
  строки с точкой). Меняешь правило — проверяй POT на реальном дампе и
  сверяй с `po/template.pot` (паритет).

## Тесты

```bash
node --test .opencode/skills/pipeline-common/tests/text_filters.test.mts
```

Тесты — границы: пустые строки, цифра с пробелом и без, легитимные `?`/`%`,
обратный слэш.
