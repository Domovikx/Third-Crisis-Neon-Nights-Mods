---
name: dump-assets
description: Дамп Unity-ассетов игры в JSONL — на TypeScript (контейнер UnityFS, SerializedFile, объекты, raw-сканеры, type tree из бандлов) с тестами и паритетом против Python-эталона
---

# dump-assets — дамп Unity-ассетов и TS-парсер формата

## Где что

- `scripts/dump_assets.mts` — CLI и полный дамп: `structure` (контейнер +
  таблица объектов), `dump` (JSONL: `summaries.jsonl` + `<asset>.jsonl`).
- `scripts/unityfs.mts` — UnityFS: заголовок, блоки, список entry;
  `lz4.mts` — свой LZ4/LZ4HC-декодер; `lzma.mts` — LZMA-фолбэк на чистом TS.
- `scripts/serialized.mts` — SerializedFile v22: header, type table,
  object table, externals, сырые байты объекта по `path_id`.
- `scripts/typetree.mts` — type tree из бандла (узлы + общие строки Unity) и
  generic-чтение объекта.
- `scripts/rawscan.mts` — сырые сканеры: `raw_strings`, JSON-диалоги,
  PlayMaker `line_X`, `ColorParserList`, `Settings.*`, global strings.
- `scripts/dotnet.mts` — `Assembly-CSharp.dll`: куча `#US`, ключи настроек и
  UI-строки.
- `scripts/extract.mts` — сборка строки JSONL: raw-часть + типизированные
  `strings`/`fields`/`fsm_strings`.
- `scripts/pystr.mts`, `scripts/jsonl.mts` — примитивы Python-строк и
  сериализатор JSONL (BigInt-`path_id`, float как `repr`).
- `scripts/rawdump.mts` — **TS-эталон** контракта `rd1` (байтовый слой): работает без
  Rust-тулчейна и служит оракулом для `tests/rust_parity.test.mts`.
- `scripts/dump_parity.mts` (в корне репо, `scripts/`) — харнесс паритета:
  структура и построчная сверка каталогов дампа.

## Использование

```bash
# полный дамп в tmp/dump (нужен TCNN_GAME_DIR или установленная игра)
node .opencode/skills/dump-assets/scripts/dump_assets.mts dump

# дамп на подмножество файлов (быстрая проверка)
node .opencode/skills/dump-assets/scripts/dump_assets.mts dump \
  --files level0,bundle_sexscene-chairsaloncg_assets_all_... --out tmp/dump-ts

# структура: entry бандла + таблица объектов
node .opencode/skills/dump-assets/scripts/dump_assets.mts structure --all
```

Путь к игре — только через `scripts/game_dir.mts` (env `TCNN_GAME_DIR` или
Steam). В папку игры ничего не пишется.

## Паритет с Python

```bash
# структура (стадии 1–2): level0, sharedassets1, первый бандл
node scripts/dump_parity.mts
# JSONL: пот-релевантные поля (настоящая приёмка стадии 3)
node scripts/dump_parity.mts --jsonl --expect tmp/dump-py --actual tmp/dump-ts --pot-fields
# JSONL целиком (стадия 4)
node scripts/dump_parity.mts --jsonl --expect tmp/dump-py --actual tmp/dump-ts
```

Эталонный дамп можно снять только с `PYTHONPATH` на `text_filters.py` старого
репозитория (в этом репо он уже `.mts`), см. `MAP.md`. Дамп в старом репо
устарел (игра обновлялась) — сверять только свежие прогоны.

## Тесты

```bash
npm run test:dump                                        # все TS-тесты скилла
node --test .opencode/skills/dump-assets/tests/*.test.mts
```

Юнит: LZ4/LZMA, заголовок UnityFS, SerializedFile (type tree on/off, 64-битные
`path_id`), raw-сканеры (границы, `<color>`, `\n`-причуда), диалоги, PlayMaker,
`#US`-куча, type tree (общие строки, выравнивания), поля/FSM, JSONL-формат.
E2E: синтетические UnityFS/SerializedFile → JSONL → инвентарь → POT
(`dump_e2e.test.mts`), без файлов игры. Фикстуры — только синтетические:
контент игры в git не кладём.

## Статус

- Стадии 0–3 закрыты: POT из TS-дампа совпадает с POT из Python-дампа
  (37 663 = 37 663 после учёта крашей эталона, подробности — `MAP.md`).
- Стадия 4: полный JSONL-паритет требует типизированных полей `.assets`
  (в эталоне — база typetree UnityPy) — на POT не влияет. Полный разбор,
  цифры и что осталось — `MAP.md` и `tasks/2026-11-21-dump-assets-island.md`.

## Две реализации: `--decoder ts|rust`

Байтовый уровень (контейнер, декомпрессия, SerializedFile, raw-сканы) имеет две реализации,
семантика (что попадает в JSONL/POT) — одна, на TS. Переключение:

```bash
node .opencode/skills/dump-assets/scripts/dump_assets.mts dump --decoder ts    # эталон/пример
node .opencode/skills/dump-assets/scripts/dump_assets.mts dump --decoder rust  # быстрее
npm run bench:dump                                                             # замер по фазам
```

- **Rust** — `tools/rust-decoder/` (свой LZ4/LZMA, без правил извлечения): отдаёт промежуточный
  `rd1`-JSONL с байтами и blob'ами type tree.
- **TS** — `rawdump.mts` (эталон того же контракта) + чтение `rd1` тем же кодом, что и в TS-пути.
- Паритет стережёт `tests/rust_parity.test.mts`; цифры и методика — `docs/rust-vs-ts.md`.
