---
name: pipeline-common
description: Общие фильтры и авто-триаж пайплайна dump-assets/extract-text (text_filters) — единый источник правды для списков скипов, имён ассетов и мусора
license: MIT
compatibility: opencode
---

# pipeline-common — Общий код пайплайна

Единственное исключение из правила «импортов между скиллами нет»
(AGENTS.md, границы слайсов, правило 2).

## Контракт

**Import shared filters from here, never duplicate lists.**
`dump-assets` и `extract-text` исторически дублировали одни и те же
фильтры; теперь обе стороны импортируют их из
`scripts/text_filters.py`. Любой фикс — только здесь, никогда локальной копией.

Подключение:

```python
sys.path.insert(0, str(PATCH_DIR / ".opencode" / "skills" / "pipeline-common" / "scripts"))
from text_filters import SKIP_RAW_PREFIXES, KNOWN_NON_SPEAKERS, _auto_triage, _is_skip_prefix, _strip_rich
```

## Экспорты (`scripts/text_filters.py`)

| Экспорт                   | Что это                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `SKIP_RAW_PREFIXES`       | Кортеж префиксов `raw_strings`, которые не диалоги (`line_`, `expressions/`, `Poses/`, `Char_`, …)          |
| `KNOWN_NON_SPEAKERS`      | Множество имён, которые не спикеры (`Narrator`, `Confirm`, `Simon`, `GlowingHole`, Dialogue Presets)        |
| `_is_skip_prefix(s)`      | `True`, если строка начинается с любого `SKIP_RAW_PREFIXES`                                                 |
| `_RICH_TAG_RX`            | Скомпилированный регекс rich-тегов `<...>` (используется `_strip_rich`)                                     |
| `_strip_rich(s)`          | Убирает rich-теги и окаймляющие пробелы                                                                     |
| `_ASSET_SUFFIXES`         | Суффиксы Unity-компонентов (`Renderer`, `System`, `Manager`, …, `UI`)                                       |
| `_ASSET_PREFIXES`         | Префиксы скриптов игры (`NN`, `AMS`)                                                                        |
| `_is_asset_name(s)`       | `True` для имён компонентов/скриптов (`NNHsvRenderer`, `EventSystem`, `NodeLink2`)                          |
| `_PCT_LEGIT_RX`           | Легитимный `%`: trailing percent после цифр (`50%`)                                                         |
| `_is_garbage_fragment(s)` | `True` для бинарных фрагментов (`Bff?D`, `%IR`, `\`-фрагменты); диалоги исключает вызывающий                |
| `_auto_triage(text)`      | Возвращает copy-through пресет `{translation: text, skip_translation: True}` для ассетов/мусора, иначе `{}` |

Правила применения (не менялись при переезде):

- Авто-триаж применяется ТОЛЬКО к raw/settings записям, никогда к диалогам.
- Флаг человека сильнее авто-флага; перевод человека авто-skip не перетирает.

## Тесты

```bash
python .opencode/skills/pipeline-common/tests/text_filters.test.py
```
