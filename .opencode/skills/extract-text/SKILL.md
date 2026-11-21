---
name: extract-text
description: PO-пайплайн текста игры (potgen, po2dat, po_file, po_update, prefill_po). potgen/inventory — TS, читают дамп напрямую; YAML-дерево translations/ удалено.
---

# extract-text — PO-пайплайн текста

## Статус

Источник правды — `po/template.pot` + `po/<lang>.po` (POT-хаб, 33 271 запись).
Строки берутся **из дампа** `tmp/dump/*.jsonl` (выход `dump-assets`), не из YAML:
дерево `translations/` удалено и не воссоздаётся. `#: translations/*` refs в
старых PO — историческое происхождение строк, не файлы.

Портировано на TS (`.mts`): `po_file`, `po2dat`, `potgen` + `inventory`.
Удалены после паритета (2026-11-21): `potgen.py`, `extractor.py` и их Python-тесты.
Остаются Python-референсы до следующей задачи (`port-po-tools`): `po_update.py`,
`prefill_po.py`, `find_source.py`, `po_file.py`, `po2dat.py`.
**`find_source.py`/`prefill_po.py` не запускать** — они импортируют удалённый
`potgen.py` и/или удалённое `translations/`; их заменяют `.mts`-порты.

## Скрипты (`scripts/`)

- `inventory.mts` — потоковое чтение дампа → инвентарь строк (диалоги ANToolkit,
  бандлы PlayMaker, UI `raw_strings`, FSM, `settings_keys`, имена персонажей).
  Отдельный модуль, чтобы тестировать инвентарь без рендера POT.
- `potgen.mts` — каталог `(msgid, msgctxt)` + рендер `po/template.pot`.
- `po2dat.mts` — компиляция `po/<lang>.po` → `runtime/patch_<lang>.dat` (в игру).
- `po_file.mts` — парсинг/рендер PO (`parsePo`, `renderPo`, escape).

```bash
# Свежий дамп (python-остров UnityPy)
python .opencode/skills/dump-assets/scripts/dump_assets.py

# Безопасный прогон: отчёт + tmp/potgen/template.pot (po/ не трогается)
npm run potgen

# Обновление EN-шаблона (единственный флаг, меняющий po/)
node .opencode/skills/extract-text/scripts/potgen.mts --update

# Сборка словаря для игры
npm run po2dat -- ru
```

Флаги `potgen.mts`: `--update` (писать `po/template.pot`), `--dump <dir>`
(по умолчанию `tmp/dump`), `--out <path>` (явный путь), `--help`.
Нет дампа/пустой дамп → понятная ошибка и ненулевой код; пустой POT не пишется.
Запись атомарная (`.part` → rename).

## Формат POT

```po
#. rich_text: <color=#B867FF>...</color>
msgctxt "speaker:Zoey"
msgid "Yesss...!~"
msgstr ""
```

- одна запись на уникальную пару `(msgid, msgctxt)`, порядок — сортировка по
  `(msgid, msgctxt)` (Python-порядок code points), дубли схлопываются
- `msgctxt`: `speaker:<Имя>` (реплика), `speaker-name` (имя персонажа), `ui`
- `#:` refs не пишутся вовсе; provenance ищется по дампу (`find_source`)
- `#. rich_text:` — исходная TMP-разметка; `<font>`/`<material>` вырезаны
  (шрифт выбирает рантайм), цвет остаётся
- ui-двойник строки с диалоговым/спикерским контекстом удаляется: рантайм
  ищет по голому тексту, иначе один текст переводится дважды
- `msgstr ""` → не переведено

Дубликаты одного `msgid` в `.dat` — earliest-ref-file-wins (как C# лоадер).
Рантайм-fallback: `rich_translation` > `translation` > `rich_text` > `text`.

## Тесты

```bash
npm test          # unit: text_filters, po_file, po2dat, inventory, potgen
npm run test:e2e  # дамп → POT → .dat на мини-фикстуре (без игры и сети)
```

Фикстур-дамп для E2E и unit — `test_data/tiny-dump/` (несколько строк JSONL).
Паритет с Python (2026-11-21): на реальном дампе 319 МБ
`potgen.py --update` и `potgen.mts --update` дают **идентичный** POT
(33 271 запись, diff пуст после нормализации `POT-Creation-Date` и `CRLF`→`LF`).

## Устаревшее

`parser.py` удалён (шумные эвристики), `po2yaml.py` не существует — обратного
пути PO→YAML нет и не нужен: рантайм читает только `.dat`.
