---
name: extract-text
description: PO-пайплайн текста игры (inventory, potgen, po2dat, po_file). Строки берутся из дампа JSONL; YAML-дерево translations/ удалено. Python-референсы po_update/prefill_po/find_source ещё не портированы.
---

# extract-text — PO-пайплайн текста

## Что где

- Источник правды — `po/template.pot` + `po/<lang>.po` (POT-хаб, **33 271 запись**).
- Строки берутся **из дампа** `tmp/dump/*.jsonl` (выход `dump-assets`),
  не из YAML: дерево `translations/` удалено. `#: translations/*` в старых PO —
  историческое происхождение, не существующие файлы.
- TS-модули: `po_file`, `po2dat`, `potgen` + `inventory`.
  Python-референсы до следующей задачи (`tasks/2026-11-21-port-po-tools.md`):
  `po_update.py`, `prefill_po.py`, `find_source.py` (последние два **не
  запускать** — импортируют удалённый `potgen.py`).
- Грабли, проверенные на реальном дампе — `MAP.md` этого скилла.

## Скрипты (`scripts/`)

- `inventory.mts` — потоковое чтение дампа → плоский список строк
  (`text, speaker, richText, kind, source, idx`). 319 МБ в память не грузятся.
- `potgen.mts` — каталог `(msgid, msgctxt)` → `po/template.pot`.
- `po2dat.mts` — `po/<lang>.po` → `runtime/patch_<lang>.dat` (словарь рантайма).
- `po_file.mts` — парсер/рендер PO (детерминированный round-trip).

## Команды

```bash
# Свежий дамп (python-остров UnityPy); путь к игре — TCNN_GAME_DIR
TCNN_GAME_DIR="<Steam>/steamapps/common/Third Crisis Neon Nights" \
  python .opencode/skills/dump-assets/scripts/dump_assets.py

# Безопасный прогон: отчёт + tmp/potgen/template.pot (po/ не трогается)
npm run potgen

# Явный дамп (например, старый кэш в папке игры)
node .opencode/skills/extract-text/scripts/potgen.mts \
  --dump "<Steam>/…/NeonTranslator/tmp/dump" --out tmp/check.pot

# Обновление EN-шаблона (единственный флаг, меняющий po/)
node .opencode/skills/extract-text/scripts/potgen.mts --update

# Сборка словаря для игры
npm run po2dat -- ru
```

Флаги `potgen.mts`: `--update`, `--dump <dir>` (по умолчанию `tmp/dump`),
`--out <path>`, `--help`. Нет дампа/пустой дамп → ошибка и ненулевой код;
пустой POT не пишется. Запись атомарная (`.part` → rename).
`po2dat.mts` пишет `.dat` тоже атомарно.

## Что попадает в POT (замер 2026-11-21, реальный дамп)

- инвентарь: 38 973 строки → POT: **33 271** запись;
- по источникам: `dlg` (ANToolkit) 8 071, `bundle` (PlayMaker) 1 934,
  `spk` (имена) 85, `set` (settings_keys) 743, `raw` (UI) 27 652, `fsm` 488;
- по контексту: `ui` 30 352, `speaker:<Имя>` 2 834, `speaker-name` 85;
- `#. rich_text` есть у 2 490 записей; ui-двойников диалогов удалено 1 318.

## Формат POT

```po
#. rich_text: <color=#B867FF>...</color>
msgctxt "speaker:Zoey"
msgid "Yesss...!~"
msgstr ""
```

- одна запись на уникальную пару `(msgid, msgctxt)`; порядок — сортировка по
  `(msgid, msgctxt)` (порядок code points, как Python);
- `msgctxt`: `speaker:<Имя>` (реплика), `speaker-name` (имя персонажа), `ui`;
- `#:` refs **не пишутся**; провенанс ищется по дампу (`find_source`, пока Python);
- `#. rich_text:` — исходная TMP-разметка; `<font>`/`<material>` вырезаны
  (шрифт выбирает рантайм), цвет остаётся;
- ui-двойник строки с диалоговым контекстом удаляется: рантайм ищет по голому
  тексту, иначе один текст переводится дважды;
- `msgstr ""` → не переведено.

Дубликаты одного `msgid` в `.dat` — earliest-ref-file-wins (как C# лоадер).
Рантайм-fallback: `rich_translation` > `translation` > `rich_text` > `text`.

## Чего в POT НЕТ (известные пробелы)

Замер 2026-11-21: ~900 уникальных человекочитаемых строк дампа не попадают в
POT. Причины и цифры — `tasks/2026-11-21-pot-coverage-gaps.md`:

- 92 652 объекта (19,4 %) помечены `read_failed`: текста в них только
  `raw_strings` (до 100 на объект), диалоги/FSM оттуда не разбираются;
- фильтр UI режет строки длиннее 50 символов (описания предметов, квесты);
- эвристика «C#-поле с точкой» режет обычные предложения в `raw_strings`;
- `summaries.global_strings` не читается вовсе.

Мусор в POT (обратная сторона): 4 297 записей — имена ассетов (3 045) и
бинарные фрагменты (1 545), пересечение 293, их переводить не нужно:
`tasks/2026-11-21-pot-noise-cleanup.md`.

## Тесты

```bash
npm test          # 71 unit: text_filters, po_file, po2dat, inventory, potgen, languages
npm run test:e2e  # дамп → POT → .dat на мини-фикстуре (без игры и сети)
```

Фикстура — `test_data/tiny-dump/`. Паритет с Python (2026-11-21): на дампе
319 МБ `potgen.py --update` и `potgen.mts --update` дают **идентичный** POT
(33 271 запись, diff пуст после нормализации `POT-Creation-Date` и `CRLF`).
Повторная проверка: `potgen.mts --out tmp/parity-check.pot` + нормализация.

## Устаревшее

`parser.py`, `extractor.py`, `potgen.py` удалены из нового дерева (логика
перенесена в `inventory`/`potgen`). Обратного пути PO→YAML нет: рантайм
читает только `.dat`.
