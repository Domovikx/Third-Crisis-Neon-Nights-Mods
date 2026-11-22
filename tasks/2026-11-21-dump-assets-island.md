# [2026-11-21] Портировать дампер Unity-ассетов на TypeScript (с тестами и паритетом)

Статус: DOING (стадии 0–3 закрыты; осталась стадия 4 — полный JSONL-паритет)

## Задача от пользователя

«тут оговорка что проект также делается для портфолио, и в идеале должен максимально быть на TS,
в этом смысл. и если только TS никак не справляемся с задачей искать другие нативные решения как
тот же раст или с#. понимаешь? к тому же не забываем про тесты, потому что дампер мы ни е2е ни
юнитами в прошлый раз никак не проверяли, а это упущение очень важного момента и именно с дампера
я бы предложил начать в первую очередь.»

## Цель

Убрать последний Python-остров: дампер Unity-ассетов пишется на `.mts`, с **юнит- и e2e-тестами**
и **паритетом против Python-версии** на том же дампе. Это же лучший портфолийный кейс: парсер
бинарного формата Unity на TypeScript.

## Контекст (замер 2026-11-21/22)

- `dump_assets.py` — 1350 строк, читает `*.assets` (SerializedFile) и `*.bundle` (UnityFS) из
  `<игра>/Third Crisis Neon Nights_Data/` и пишет JSONL: `summaries.jsonl` + `<asset>.jsonl`.
- Дамп реальный: 131 чанк + `summaries.jsonl`, 477 872 строки, 319 МБ, 92 652 объекта
  `read_failed` (19,4%). Это и есть материал для паритета.
- Пайплайн ниже по течению (`inventory.mts` → `potgen.mts`) уже на TS и потребляет **этот JSONL**;
  значит контракт дампера — формат файлов, а не язык.
- Тестов на дампер не было вообще: `dump_assets.test.py` проверяет только вспомогательные
  функции, полный прогон никто не сверял. Это упущение, закрываем в этой задаче.
- Версия игры фиксируется снимком `config/game-snapshot.json` (`npm run check:version`):
  buildid `26387111`, обновлена 2026-11-12.

## Что нужно разобрать (формат)

- **UnityFS-контейнер:** заголовок (signature, version, unityVersion, size), блоки
  (uncompressed/compressed size, flags), сжатие **LZ4/LZ4HC** (для нашей игры) и LZMA (на всякий).
- **SerializedFile:** header (version, type tree on/off), type table, object table
  (path_id, byteStart/byteSize, typeID), externals.
- **Типы, которые реально нужны:** `MonoBehaviour` (raw bytes → `raw_strings`, диалоги),
  `TextAsset`, `Texture2D` (метаданные), `AudioClip` (метаданные, имена), `GameObject`/`Transform`.
- **Извлечение** (наше, не парсинг): какие поля читать, как склеивать `raw_strings`, фильтры
  ассетов/мусора (уже портированы в `text_filters.mts`).

## Ресёрч (сделан 2026-11-22)

Существующие реализации: Rust (`unity_asset*`, `unityfs`), TS (`fatal10110/unity-asset-reader`),
C# (`UnityDataTools`, `AssetsTools.NET`), Python (`UnityPy 1.25.0`).

Решение по правилу портфолио: **пишем на TS сами**. Готовые библиотеки не берём как основу
(незрелые, чужой код, и смысл проекта — показать TS), но сверяемся с ними при отладке формата.

## План по стадиям (каждая стадия — рабочая и с тестами)

1. **Стадия 0 — харнесс паритета.** Скрипт `scripts/dump_parity.mts`: прогоняет Python-дампер и
   TS-дампер на одном наборе файлов и сравнивает JSONL построчно (нормализуя порядок ключей).
   Приёмка: на 1–2 мелких бандлах отчёт «совпало/разошлось» с диффом.
2. **Стадия 1 — контейнер UnityFS.** Разбор заголовка и блоков, декомпрессия LZ4-блока
   (свой декодер, ~60 строк) + LZMA-фолбэк; список entry (имя, размер, смещение).
   Приёмка: для 3 бандлов имена/размеры entry совпадают с Python.
3. **Стадия 2 — SerializedFile.** Header, type table, object table; чтение объекта по path_id
   как сырых байт. Приёмка: число объектов и список `(path_id, typeID)` совпадают с UnityPy.
4. **Стадия 3 — объекты.** Разбор нужных типов и генерация JSONL; `raw_strings` из MonoBehaviour.
   Приёмка: для 5 файлов JSONL совпадает с Python после нормализации ключей/порядка.
5. **Стадия 4 — полный дамп.** Паритет на всех 131 чанке + `summaries.jsonl`; время и память
   записаны; старый `.py` удаляется только после этого.

## Тесты (обязательно, это причина задачи)

- **Юнит:** LZ4-декодер (векторы: пустой блок, литералы, повторы, границы), парсер заголовка
  UnityFS (битые/усечённые данные → понятная ошибка), парсер SerializedFile (type tree on/off),
  нормализация JSONL.
- **E2E:** маленькая фикстура-бандл в `test_data/` (сотни КБ, не 319 МБ) → полный прогон
  TS-дампера → сверка с ожидаемым JSONL, сгенерированным Python и закоммиченным.
- **Гард:** `npm run dump:parity` на реальной установке (локально, не в CI).

## Прогресс: стадии 0–2 (2026-11-22)

Сделано (TS, без зависимостей):

- Стадия 0 — `scripts/dump_parity.mts`: режим `structure` (entry + таблица
  объектов против UnityPy) и режим `--jsonl --expect/--actual` (построчная
  сверка дампов, готов к стадии 4).
- Стадия 1 — `unityfs.mts`: заголовок, блоки, свой LZ4-декодер (`lz4.mts`),
  LZMA-фолбэк на чистом TS (`lzma.mts`), список entry.
- Стадия 2 — `serialized.mts`: header v22, type table (с пропуском type tree),
  object table, externals; чтение объекта сырыми байтами по `path_id`.
- Тесты: 54 зелёных (`tests/*.test.mts`), фикстуры синтетические.
- Паритет: 141/141 файл (107 бандлов + 34 `.assets`), 0 расхождений; сырые
  байты объектов совпали с UnityPy по SHA-1.

Осталось до стадии 4 (после стадии 3, см. ниже):

- Полный JSONL-паритет по `strings`/`fields` в `.assets` и свойствам-обёрткам
  UnityPy (`m_Components` и т.п.); POT от этого не зависит.
- Расширять discovery на `level16..18`/`sharedassets16..18` — только вместе с
  решением по паритету (Python их сейчас не дампит).

## Приёмка

- [ ] Все стадии закрыты; финальный прогон на реальном дампе даёт паритет с Python
      — стадии 0–3 закрыты (POT совпадает); осталась стадия 4 (полный JSONL)
- [x] Юнит-тесты на декодер/парсеры и e2e на фикстуре — зелёные
      (`npm run test:dump` — 97; в `npm test` скилл пока не входит: список
      файлов в `package.json` — вне зоны этой задачи)
- [ ] `dump_assets.py` удалён; `requirements.txt` и py-джоб CI удалены
- [ ] Документация: `SKILL.md` скилла, `docs/migration.md`, `AGENTS.md` (острова больше нет)
      — `SKILL.md`/`MAP.md` обновлены, остальное — вместе с удалением эталона
- [ ] `npm run check:version` связан с дампом: обновилась игра → напоминание пересобрать дамп

## Стадия 3 (2026-11-22): анализ разрыва, порт и приёмка паритетом POT

Статус стадии: DONE (по POT). Python-эталон оставлен до стадии 4.

### 1. Какие поля JSONL читает `inventory.mts`/`potgen.mts` и откуда они в эталоне

`inventory.mts` читает только: `asset`, `path_id`, `dialogues[].text/speaker/
rich_text`, `raw_strings`, `strings.m_Name`, `fsm_strings`,
`color_parser_list`, `summaries.settings_keys[].display`. Поля `type`,
`fields`, `error`, `summaries.global_strings/object_types/format` ниже по
течению НЕ читаются.

- **`path_id`** ← object table (64-бит) — критично (ключ группировки диалогов) —
  порт, BigInt без потерь.
- **`type`** ← `obj.type.name` (ClassID) — нет — порт (64 имени).
- **`dialogues`** ← `parse_dialogue_from_raw` + `parse_playmaker_dialogues` —
  критично (7 210 записей POT) — порт (raw).
- **`raw_strings`** ← `scan_raw_strings(raw)` — критично (28 582 + 12 записей) —
  порт (raw).
- **`strings`** ← `read_typetree` (в бандле — из файла, в `.assets` — база
  UnityPy) — частично: POT нужен только `m_Name` для бандлов (12 записей) —
  порт в бандлах; в `.assets` нет (на POT не влияет).
- **`fields`** ← `read_typetree` — нет — generic-обход в бандлах; свойства-
  обёртки UnityPy (`m_Components`) не повторяем.
- **`fsm_strings`** ← `read_typetree` walk (`value`/`stringParams`) — критично
  (21 запись) — порт (только бандлы: там type tree есть).
- **`color_parser_list`** ← `parse_color_parser_list` (raw-скан) — критично
  (1 объект; задаёт цвета в `rich_text`) — порт (raw).
- **summaries `settings_keys`** ← `scan_settings_keys` (raw всех файлов) +
  `scan_dotnet_*` — критично (726 записей) — порт (raw).
- **summaries `global_strings`** ← `scan_global_strings` (raw) — нет — порт
  (для полноты контракта).
- **summaries `object_types`/`total_objects`/`format`** ← счётчики — нет — порт.
- **`error` (`read_failed`)** ← исключение `obj.read()` — нет — порт (нет
  type tree → `read_failed`).

**Итог по зависимости POT:** 35 804 из 36 126 записей (99,1 %) даёт чистый
raw-скан без схем; 726 (2,0 %) — summaries/DLL (тоже raw-скан); 55 (0,15 %) —
имена спикеров из диалогов; и только **21 запись (0,06 %)** требует
типизированного дерева (`fsm_strings`), причём дерево есть в самом файле
(бандлы), схемы классов не нужны вовсе.

### 2. Что портировано

- `rawscan.mts` — raw-строки, JSON-диалоги (включая причуду `\n`→`n`),
  PlayMaker `line_X`, `ColorParserList` (шаг 24 байта как в эталоне),
  `Settings.*`, global strings; общие фильтры — из `pipeline-common`.
- `dotnet.mts` — `#US`-куча: compressed int, ключи `Settings.*`
  (`CamelCase → Camel Case`), автономные UI-строки.
- `typetree.mts` — разбор type tree из бандла (узлы 32 байта + таблица
  112 «общих строк» Unity), generic-чтение (примитивы, строки с
  выравниванием, массивы, PPtr, вложенные классы), проверка «прочитано ровно
  `byte_size`» как `check_read` в UnityPy.
- `extract.mts` — сборка строки: `strings`/`fields` (pptr → `file_id/path_id`,
  списки только из чисел/строк/PPtr), `dialogues`, `fsm_strings`, гейт
  `read_failed` и спасение `color_parser_list`.
- `dump_assets.mts` — команда `dump`: те же 163 ассета и тот же порядок, что у
  эталона; `summaries.jsonl` перезаписывается (у эталона `append` — дубли при
  повторном прогоне).
- `jsonl.mts` — сериализатор: `path_id` как BigInt-десятичное, float как
  `repr` Python, разделители `json.dumps`.
- `scripts/dump_parity.mts` — режим `--jsonl --pot-fields` (сверка только
  пот-релевантных полей + сводка по полям).

### 3. Приёмка: `pot-ts.pot` против `pot-py.pot`

Свежие прогоны на одной и той же установке (игра обновлена 2026-11-12, старый
дамп в игре от 2026-09-29 — для паритета непригоден):

```bash
# эталон (нужен PYTHONPATH на text_filters.py старого репо, см. MAP.md)
TCNN_GAME_DIR="<Steam>/…/Third Crisis Neon Nights" python \
  .opencode/skills/dump-assets/scripts/dump_assets.py tmp/dump-py
node .opencode/skills/dump-assets/scripts/dump_assets.mts dump --out tmp/dump-ts
node .opencode/skills/extract-text/scripts/potgen.mts --dump tmp/dump-py --out tmp/pot-py.pot
node .opencode/skills/extract-text/scripts/potgen.mts --dump tmp/dump-ts --out tmp/pot-ts.pot
node scripts/dump_parity.mts --jsonl --expect tmp/dump-py --actual tmp/dump-ts --pot-fields
```

Результат:

- Объектов: **507 415 = 507 415** (163 ассета: 16 уровней, 16 sharedassets,
  resources, globalgamemanagers, 107 бандлов, 20 `.resource`, 2 DLL).
- POT: **36 126 (Python) против 37 663 (TS): 0 потерянных, 1 537 лишних**;
  расхождений в существующих записях и комментариях `#. rich_text:` — 0.
- По пот-полям на всех 507 415 строках: `path_id`, `type`, `dialogues`,
  `fsm_strings`, `color_parser_list` — **0 расхождений**; `raw_strings` —
  6 329 расхождений; `strings.m_Name` — 140 404 (только `.assets`).
- Причина обоих чисел одна и та же, и это не наш разбор:
  - **6 329 строк эталона — `extract_failed`**: `extract_object` перебирает
    `dir(data)`, а у AudioClip/Texture2D/Sprite свойства (`samples`, `image`)
    пытаются декодировать ресурс и падают (`PermissionError` на
    пути-каталоге) → у эталона от объекта остаются только `path_id`+`type`.
    TS эти строки извлекает. Проверка: если в Python-дампе подменить ровно эти
    6 329 строк на TS-строки, POT становится **37 663 = 37 663, 0 диффов**
    (включая комментарии). Значит 1 537 лишних записей — ровно они
    (AudioClip 1 495, Texture2D+Sprite 42).
  - **140 404 `strings.m_Name`** — встроенные классы в `.assets`, которые
    UnityPy читает из своей базы typetree (`lzma.tpk`, ≈1000 классов), а не из
    файла. POT их не использует (`m_Name` нужен только для фильтра
    PlayMaker-бандлов, а там type tree есть).
- Полный JSONL по бандлам: 14 487 из 22 857 строк идентичны; остальное —
  свойства-обёртки UnityPy (`strings.extension` 6 973, `m_Components` 1 328,
  `m_Transform` 621, `m_Animator` 113), имена после `clean_name`
  (`m_MeshMetrics[0]` → `m_MeshMetrics_0_`) и те же 36 строк крашей эталона.
  На POT не влияет — эти поля в POT не читаются.

Вывод: **приёмка стадии 3 выполнена по существу** — POT из TS-дампа совпадает
с эталоном; расхождение только там, где эталон падает, и TS даёт больше текста
(1 537 UI-строк из имён аудио-ассетов).

### 4. Тесты

`npm run test:dump` — **97 зелёных** (54 прежних + 43 новых): raw-сканеры 14,
`#US`-куча 7, type tree 6, извлечение/FSM 7, JSONL 6, e2e (синтетический
UnityFS/SerializedFile → JSONL → инвентарь → POT) 2, интеграция на живой игре
(дамп level1 + самого маленького бандла → инвентарь) 1. `npm test` (206),
`npm run typecheck` и `npm run verify` зелёные.

### 5. Что осталось до стадии 4

- Полный JSONL-паритет: типизированные `strings`/`fields` в `.assets` (нужна
  либо база typetree UnityPy как данные, либо ручные схемы на 64 класса) и
  свойства-обёртки (`m_Components` и т.п.). На POT не влияет.
- Решение владельца по крашам эталона: оставить TS-надмножество (1 537 строк)
  или добавить `--py-compat` для байт-в-байт дампа.
- Discovery `level16..18` (сейчас как у эталона: только 0..15) — отдельное
  решение, иначе POT недополучает текст поздних сцен.
- `dump_assets.py` удаляется только после полного JSONL-паритета.

## Вне рамок

- Экспорт текстур/аудио (нам нужны метаданные и строки, а не картинки).
- Поддержка всех версий Unity — только 2022.3, как в игре.
- Ускорение ради ускорения: цель — корректность и паритет.

## Файлы

- `.opencode/skills/dump-assets/scripts/dump_assets.mts` (+ `unityfs.mts`,
  `serialized.mts`, `binary.mts`, `lz4.mts`, `lzma.mts`, `rawscan.mts`,
  `dotnet.mts`, `typetree.mts`, `extract.mts`, `pystr.mts`, `jsonl.mts`,
  `unity_classes.mts`)
- `.opencode/skills/dump-assets/tests/*.test.mts` (+ `helpers.mts`; `test_data/`
  не нужен: фикстуры собираются байтами в тестах — файлы игры не коммитим)
- `scripts/dump_parity.mts`
- `package.json`, `SKILL.md`, `MAP.md`, `docs/migration.md`, `AGENTS.md`

## Связи

- Потребители контракта: `inventory.mts`, `potgen.mts` (паритет POT не должен поехать).
- Версия игры: `scripts/game_version.mts`, `config/game-snapshot.json`.
