---
name: extract-text
description: PO-пайплайн текста игры (inventory, potgen, po_update, prefill_po, po2dat, po_file, find_source). Строки берутся из дампа JSONL; YAML-дерево translations/ удалено (осталось легаси-входом prefill). Всё на .mts, Python-файлы — легаси до удаления владельцем.
---

# extract-text — PO-пайплайн текста

## Что где

- Источник правды — `po/template.pot` + `po/<lang>.po` (POT-хаб, **33 271 запись**).
- Строки берутся **из дампа** `tmp/dump/*.jsonl` (выход `dump-assets`),
  не из YAML: дерево `translations/` удалено. `#: translations/*` в старых PO —
  историческое происхождение, не существующие файлы.
- TS-модули: `po_file`, `inventory`, `potgen`, `po_update`, `prefill_po`,
  `po2dat`, `find_source`.
- Python-файлы в `scripts/` (`po_update.py`, `prefill_po.py`, `find_source.py`)
  — **легаси-референсы**: код перенесён, поведение сверено. Удаляет владелец;
  не запускать (два последних импортируют удалённые `potgen.py`/`extractor.py`).
- Грабли, проверенные на реальном дампе — `MAP.md` этого скилла.

## Скрипты (`scripts/`)

- `inventory.mts` — потоковое чтение дампа → плоский список строк
  (`text, speaker, richText, kind, source, idx`). 319 МБ в память не грузятся.
- `potgen.mts` — каталог `(msgid, msgctxt)` → `po/template.pot`.
- `po_update.mts` — аналог `msgmerge -U`: перенос `msgstr` в новый POT
  (точный ключ / ретаргет при смене `msgctxt` / новые пустые / `legacy`-хвост).
- `prefill_po.mts` — заполнение пустых `msgstr` из YAML-корпуса + отчёт
  (exact/fuzzy/auto-normalized/conflicts/missing/orphans).
- `po2dat.mts` — `po/<lang>.po` → `runtime/patch_<lang>.dat` (словарь рантайма).
- `po_file.mts` — парсер/рендер PO (детерминированный round-trip).
- `find_source.mts` — провенанс: какие объекты дампа дали строку.

## Команды

```bash
# Свежий дамп: рабочий декодер — Rust (~3× быстрее), TS — эталон
npm run dump            # = --decoder rust
npm run dump:ts         # эталон-образец, без Rust-тулчейна

# Безопасный прогон: отчёт + tmp/potgen/template.pot (po/ не трогается)
npm run potgen

# Явный дамп (например, старый кэш в папке игры)
node .opencode/skills/extract-text/scripts/potgen.mts \
  --dump "<Steam>/…/NeonTranslator/tmp/dump" --out tmp/check.pot

# Обновление EN-шаблона (единственный флаг, меняющий po/)
node .opencode/skills/extract-text/scripts/potgen.mts --update

# Перенос переводов в обновлённый POT (бэкап po/<lang>.po.bak)
node .opencode/skills/extract-text/scripts/po_update.mts ru
#   флаги: [lang] (по умолчанию ru), --po-dir <dir>

# Предзаполнение PO из YAML-корпуса (легаси-вход translations/, см. ниже)
node .opencode/skills/extract-text/scripts/prefill_po.mts
#   флаги: [lang], --po-dir <dir>, --corpus <dir>

# Где эта строка в дампе (все вхождения, либо первое)
node .opencode/skills/extract-text/scripts/find_source.mts "Yesss...!~"
node .opencode/skills/extract-text/scripts/find_source.mts "Wait" --first
#   флаги: --first, --dump <dir> (по умолчанию tmp/dump)
#   exit: 0 — найдено, 1 — нет/дампа нет, 2 — аргументы

# Сборка словаря для игры
npm run po2dat -- ru
```

Запись `template.pot`, `po/<lang>.po` и `.dat` атомарная (`.part` → rename):
обрыв процесса не обнуляет файл. `po_update` пишет `po/<lang>.po.bak`.

`prefill_po.mts` — **про YAML-корпус**: в новой репе дерева `translations/`
нет, поэтому без `--corpus` инструмент только сохраняет текущие переводы
и печатает отчёт (все непереведённые POT-строки — в `missing`). Это не
ошибка порта: Python-версия после ретайра YAML вела себя так же.
`--corpus` нужен для паритета/исторического прогона (реальный корпус
поднимается из git-истории старой репы, commit `27eb46b^`,
`translations/`, 1176 файлов).

## Что попадает в POT (замер 2026-11-21, реальный дамп)

- инвентарь: 38 973 строки → POT: **33 271** запись;
- по источникам: `dlg` (ANToolkit) 8 071, `bundle` (PlayMaker) 1 934,
  `spk` (имена) 85, `set` (settings_keys) 743, `raw` (UI) 27 652, `fsm` 488;
- по контексту: `ui` 30 352, `speaker:<Имя>` 2 834, `speaker-name` 85;
- `#. rich_text` есть у 2 490 записей; ui-двойников диалогов удалено 1 318.

## Формат POT

```po
#. src: dialog
#. rich_text: <color=#B867FF>...</color>
msgctxt "speaker:Zoey"
msgid "Yesss...!~"
msgstr ""
```

- одна запись на уникальную пару `(msgid, msgctxt)`; порядок — сортировка по
  `(msgid, msgctxt)` (порядок code points, как Python);
- `msgctxt`: `speaker:<Имя>` (реплика), `speaker-name` (имя персонажа), `ui`;
- `#:` refs **не пишутся**; провенанс ищется по дампу (`find_source.mts`);
- `#. src:` — провенанс записи: `dialog`, `bundle`, `field:<ИмяПоля>`,
  `settings`, `us`, `raw:<TypeName>`, `global` (метка = путь доставки в POT,
  первое вхождение побеждает; список фиксирован — инвариант 14 контракта,
  смысл и распределение — `docs/pot-provenance.md`);
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
# Базовые модули (71): text_filters, po_file, po2dat, inventory, potgen, languages
npm test

# Порт PO-инструментов (50): po_update 19, prefill_po 21, find_source 10
node --test .opencode/skills/extract-text/tests/po_update.test.mts \
  .opencode/skills/extract-text/tests/prefill_po.test.mts \
  .opencode/skills/extract-text/tests/find_source.test.mts

# Сквозной: дамп → POT → .dat на мини-фикстуре (без игры и сети)
npm run test:e2e
```

Фикстура — `test_data/tiny-dump/`.

Паритет с Python (2026-11-21):

- `potgen`: на дампе 319 МБ `potgen.py --update` и `potgen.mts --update`
  дают идентичный POT (33 271 запись, diff пуст после нормализации
  `POT-Creation-Date` и `CRLF`);
- `po_update`: 10 языков (`po/*.po` + `template.pot` на копиях) — идентично
  байт-в-байт после `CRLF`→`LF`; ru: carried 18 596 / new 14 675 / legacy 0;
- `prefill_po`: реальный YAML-корпус из истории старой репы + реальные `po/` —
  `ru.po` идентичен после нормализации EOL и `PO-Revision-Date`, отчёт
  (18596/33271 exact, fuzzy 14, auto-normalized 136, missing 14 525,
  orphans 8) совпал текстом после нормализации EOL;
- `find_source`: 5 строк на реальном дампе (включая многовхождения и срез
  120 code points) — вывод идентичен после `CRLF`→`LF`.

## Устаревшее

`parser.py`, `extractor.py`, `potgen.py` удалены из нового дерева (логика
перенесена в `inventory`/`potgen`/`prefill_po`). Обратного пути PO→YAML нет:
рантайм читает только `.dat`, YAML-корпус остался только входом `prefill`.
