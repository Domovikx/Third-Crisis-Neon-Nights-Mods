---
name: dump-assets
description: Дамп Unity-ассетов игры в JSONL (Python-эталон UnityPy) + TS-парсер контейнера UnityFS и SerializedFile с тестами и харнессом паритета
---

# dump-assets — дамп Unity-ассетов и TS-парсер формата

## Где что

- `scripts/dump_assets.py` — **эталон контракта**: UnityPy 1.25.0, пишет
  `summaries.jsonl` + `<asset>.jsonl` (формат — `references/DUMP_FORMAT.md`).
  Пока именно он делает полный дамп; удалять его нельзя, пока TS не закроет
  стадии 3–4.
- `scripts/dump_assets.mts` — TS-дампер, **стадии 0–2**: контейнер UnityFS,
  SerializedFile, отчёт «entry + таблица объектов». Генерации JSONL ещё нет.
- `scripts/unityfs.mts` — UnityFS: заголовок, блоки, свой LZ4-декодер
  (`lz4.mts`), LZMA-фолбэк (`lzma.mts`).
- `scripts/serialized.mts` — SerializedFile v22: header, type table, object
  table, externals; чтение объекта по `path_id` сырыми байтами.
- `scripts/binary.mts` — общий курсор по байтам (LE/BE, cstring, align,
  `BinaryFormatError` с позицией).
- `scripts/dump_parity.mts` (в корне репо, `scripts/`) — харнесс паритета с
  UnityPy: структура (entry + объекты) и построчное сравнение JSONL-каталогов.

## Использование (TS, стадии 0–2)

```bash
# отчёт по структуре (человеческий вид)
node .opencode/skills/dump-assets/scripts/dump_assets.mts structure --all

# конкретные файлы: имя из установки или путь
node .opencode/skills/dump-assets/scripts/dump_assets.mts structure \
  --files level0,sharedassets1,0.2pinup-rosiesspecial_assets_all_ca47de7d23c78d171b98b2fdfa5aa400.bundle

# машинный JSONL (по объекту на файл) — для харнесса
node .opencode/skills/dump-assets/scripts/dump_assets.mts structure --all --json --no-objects
```

Путь к игре — только через `scripts/game_dir.mts` (env `TCNN_GAME_DIR` или
Steam). В папку игры ничего не пишется.

## Паритет с Python (обязательный шаг перед стадиями 3–4)

```bash
# по умолчанию: level0, sharedassets1, первый бандл
node scripts/dump_parity.mts
# произвольный набор (имена или пути)
node scripts/dump_parity.mts --files level0,resources.assets,bundle_...
# позже, когда появится TS-дамп JSONL:
node scripts/dump_parity.mts --jsonl --expect tmp/dump-py --actual tmp/dump-ts
```

Structure-режим запускает пробу на **том же UnityPy**, которым работает
эталон, и сравнивает: список entry (path/offset/size), `unityVersion`,
версию заголовка, наличие type tree и таблицу `(path_id, typeID)`.

## Полный дамп (пока Python-эталон)

```bash
pip install UnityPy
TCNN_GAME_DIR="<Steam>/steamapps/common/Third Crisis Neon Nights" \
  python .opencode/skills/dump-assets/scripts/dump_assets.py
```

По умолчанию пишет в `tmp/dump/` **этого репозитория**. Схема JSONL —
`references/DUMP_FORMAT.md`; потребители — `inventory.mts`, `potgen.mts`.

## Тесты

```bash
node --test .opencode/skills/dump-assets/tests/*.test.mts
python .opencode/skills/dump-assets/tests/dump_assets.test.py   # эталон (нужна игра)
```

TS-тесты: LZ4 (векторы), LZMA (синтетический поток), заголовок UnityFS
(битые/усечённые данные), SerializedFile (type tree on/off, пустая таблица,
64-битные `path_id`), ByteReader. Фикстуры — **только синтетические**: файлы
игры в git не кладём (перераспространение контента). `integration.test.mts`
работает на реальной установке и пропускается, если игры нет (CI).

## Что осталось (стадии 3–4)

- Стадия 3: разбор нужных типов без type tree (MonoBehaviour/TextAsset/
  GameObject/…), `raw_strings`, диалоги, `fsm_strings`, `color_parser_list` —
  генерация `<asset>.jsonl` с паритетом против Python.
- Стадия 4: полный прогон `summaries.jsonl` + все чанки, замер времени/памяти;
  только после этого `dump_assets.py` можно удалять.

Подробности и грабли — `MAP.md`.
