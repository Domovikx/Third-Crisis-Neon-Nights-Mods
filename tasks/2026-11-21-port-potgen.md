# [2026-11-21] Портировать POT-хаб: `potgen` + инвентарь из дампа

Статус: DONE

## Задача от пользователя

Часть общей задачи: «максимально запускаем миграцию на ts mts вместо питона… что можно переносим
без запуска игры».

## Цель

`po/template.pot` (источник правды по строкам игры, ~33k записей) генерируется TS-скриптом из
дампа Unity-ассетов, с тем же порядком, тем же набором полей и той же rich-разметкой, что даёт
`potgen.py`. Без этого POT-хаб остаётся на Python.

## Контекст

- `potgen.py` — 419 строк, `extract-text/scripts/potgen.py`. Импортирует `extractor.py` (1144 строки)
  и `po_file.py` (уже портирован) и `text_filters.py` (уже портирован).
- `extractor.py` **не запускать**: он писал YAML-дерево `translations/`, которое удалено;
  повторный запуск пересоздаст мусор. Нужна только часть «прочитать дамп → инвентарь строк».
- Дамп: `dump_assets.py` (python-остров) кладёт JSONL в `tmp/dump/`.
- POT несёт `#. rich_text:` из дампа; `<font>`/`<material>` вырезаются (шрифт выбирает рантайм).
- Порядок записей POT = порядок игры; менять нельзя (иначе шум в диффах переводов).

## Что сделать

1. Прочитать `potgen.py` и используемые им части `extractor.py`; выписать, какие поля инвентаря
   реально нужны (msgid, msgctxt/спикер, rich_text, категория, порядок).
2. Вопросы для ресёрча:
   - где проходит граница «инвентарь из дампа» vs «писатель YAML» — что из `extractor.py`
     переносить, а что выбросить;
   - как воспроизвести порядок POT без YAML-дерева;
   - какие эвристики `extractor.py` (all-caps, display-имена, гибериш) обязаны сохраниться,
     чтобы POT не поехал.
3. Варианты (≥2) и выбор: один модуль «inventory + potgen» против двух (`inventory.mts` +
   `potgen.mts`). Критерий — простота и тестируемость на реальном дампе.
4. Реализовать на `.mts`, покрыть тестами `node --test`.
5. **Паритет:** прогнать старый `potgen.py` и новый `.mts` на одном дампе, сравнить
   `template.pot` байт-в-байт (с нормализацией `CRLF`→`LF`) и по числу записей.
6. Удалить `potgen.py` из нового дерева, обновить `SKILL.md` скилла `extract-text`.

## Приёмка

- [x] `node .../potgen.mts` собирает `po/template.pot` (с `--update`; без флага — `tmp/potgen/`)
- [x] Число записей и содержимое совпадают с Python-сборкой на том же дампе (diff пуст после
      нормализации EOL и даты заголовка)
- [x] Порядок записей не изменился (сортировка `(msgid, msgctxt)` по code points, как Python)
- [x] `rich_text` присутствует у тех же msgid, что и раньше (2 490 комментариев в обеих сборках)
- [x] Тесты `node --test` на инвентарь и на рендер POT; `npm run typecheck`, `npm run lint` зелёные
- [x] Edge-case: дампа нет / дамп пуст → понятная ошибка и ненулевой код, пустой POT не пишется
- [x] `potgen.py`/`extractor.py` удалены из нового дерева, `docs/migration.md` обновлён

## Журнал

**Решение по структуре — два модуля.** `inventory.mts` (чтение дампа → плоский список строк с
kind/source/idx) и `potgen.mts` (каталог `(msgid, msgctxt)` → POT). Один модуль смешал бы 350 строк
эвристик извлечения с рендером: тесты инвентаря пришлось бы гонять через файлы POT, а рендер — через
дамп. Два модуля дают чистую границу «данные vs представление» и позволяют тестировать каждую
половину напрямую (сканер кормится объектами JSONL, рендер — массивом items). KISS соблюдён:
никаких абстракций, только две функции-конвейера.

**Что выброшено из `extractor.py`.** Весь YAML-писатель (`write_yaml`, merge, orphans,
consolidate, stable_index), `_auto_triage` (в POT не влиял — только в YAML и статистику) и
`load_yaml_skip` (ручной триаж в YAML; `translations/` удалено, а на состав POT он не влиял).
Оставлено ровно то, что читает `scan_dump()`: `find_chunks`, `find_summaries`,
`iter_jsonl_objects`, диалоги ANToolkit, бандлы PlayMaker, UI `raw_strings`, FSM, `settings_keys`,
деривация спикеров, `color_parser_list` и `_bundle_short_name`.

**Гочи, пойманные при порте.**

1. `path_id` — 64-битный хэш; в дампе 22 pid с диалогами выходят за 2^53 (бандлы). `JSON.parse`
   их округляет и склеил бы разные группы, поэтому pid берётся регуляркой из сырой строки и
   сравнивается как `BigInt`.
2. `sorted()` в Python сравнивает code points, а JS `.sort()` — UTF-16 units: для астральных
   символов порядок разный. Написан `compareCodePoints`.
3. `str.strip()`/`isupper()`/`isalpha()` в CPython — Unicode-свойства (`\x1c-\x1f`, NEL,
   `Alphabetic`, `Uppercase`); JS `trim()` тянет BOM, а `\w` — только ASCII. Написаны
   Python-совместимые примитивы (`pyStrip`, `pyIsUpper`, `\p{Alphabetic}`, `\p{Uppercase}`).
4. Именованные цвета (`<color=perversion>`) резолвятся картой `color_parser_list`, которая
   собирается из всего дампа. Резолв отложен до `finish()` — иначе при потоковом чтении цвет,
   объявленный в файле позже, не нашёлся бы.

**Паритет (реальный дамп 319 МБ, 131 чанк + summaries, 477 872 строки).**
Python-прогон — в копии старого дерева `tmp/parity/old/` (junction на дамп, `po/template.pot`
скопирован как «старый»), TS — `node .../potgen.mts --dump <дамп> --out tmp/ts-template.pot`.

| Метрика       | Python             | TS                 |
| ------------- | ------------------ | ------------------ |
| записей       | 33 271 + заголовок | 33 271 + заголовок |
| байт (LF)     | 1 897 304          | 1 897 304          |
| scanned fresh | 38 973             | 38 973             |
| new           | 1 318              | 1 318              |
| vanished      | 0                  | 0                  |
| triaged       | 4 293              | 4 293              |
| rich          | 2 490              | 2 490              |
| merged twins  | (не печатается)    | 1 318              |
| время         | 30.8 с             | 3.0 с              |

`diff` пуст после нормализации `POT-Creation-Date` (метаданные времени) и `CRLF`→`LF`
(Python пишет `\r\n` на Windows; рантайм читает построчно, LF безопасен). Совпадение также
проверено против закоммиченного `po/template.pot` — тот же результат.

**Тесты.** `inventory.test.mts` — 14 (диалоги, 64-битные pid, бандлы/спикеры, UI-фильтр, FSM,
settings, деривация спикеров, фикстур-дамп, пустой/отсутствующий дамп). `potgen.test.mts` — 14
(ctxt, триаж, rich/шрифты, дубли, cross-source dedup, сортировка, заголовок, CLI, атомарная
запись). `pipeline.e2e.test.mts` — 1 (дамп → POT → `.dat`, rich и переводы доходят до словаря).

**Файлы.** Созданы: `scripts/inventory.mts`, `scripts/potgen.mts`,
`tests/{inventory,potgen,pipeline.e2e}.test.mts`, `test_data/tiny-dump/*`.
Удалены: `scripts/potgen.py`, `scripts/extractor.py`, `tests/potgen.test.py`,
`tests/extractor.test.py`. Обновлены: `package.json`, `SKILL.md`, `AGENTS.md`,
`docs/migration.md`, `.opencode/commands/{pot,test}.md`,
`references/PO_WORKFLOW.md`, `.github/workflows/ci.yml`.

**Осталось на следующую задачу (`port-po-tools`).** `prefill_po.py` и `find_source.py` ещё
импортируют удалённый `potgen.py` — это легаси-референсы, их `.mts`-порты в очереди; до порта
Python-версии не запускать.

## Вне рамок

- Порт `dump_assets.py` (UnityPy остаётся python-островом).
- Пересборка переводов и любое изменение `po/<lang>.po`.
- Изменение формата POT (добавление/удаление полей).

## Файлы (ожидаемые)

- `.opencode/skills/extract-text/scripts/potgen.mts` + `inventory.mts`
- `.opencode/skills/extract-text/tests/{inventory,potgen,pipeline.e2e}.test.mts`
- `package.json` (скрипты `potgen`, `test:e2e`), `docs/migration.md`, `SKILL.md`

## Связи

- Блокирует: `find_source` (импортирует `potgen`), `prefill_po`.
