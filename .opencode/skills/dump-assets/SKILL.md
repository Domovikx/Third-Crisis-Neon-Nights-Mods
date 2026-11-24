---
name: dump-assets
description: Дамп Unity-ассетов игры в JSONL — рабочая реализация на Rust (rust-decoder → rd1 → rust-l10n dump_assemble), TS-декодер и TS-сборка удалены 2026-11-24; оракул сборки — ЗОЛОТЫЕ фикстуры в test_data/
---

# dump-assets — дамп Unity-ассетов (Rust + золотые фикстуры)

## Где что

- `scripts/dump_assets.mts` — ТОНКАЯ обёртка CLI: найти игру, собрать список
  файлов, позвать бинари, показать пределы и итоги. Никакого разбора байтов
  и никакой сборки JSONL здесь нет.
- `tools/rust-decoder/` (вне скилла, корень репо) — байтовый уровень: UnityFS,
  LZ4/LZMA, SerializedFile, type tree, raw-сканеры. Пишет промежуточный
  `rd1`-JSONL.
- `tools/rust-l10n/src/assemble.rs` — сборка дампа из `rd1`:
  `summaries.jsonl` + `<asset>.jsonl` + `index.md`. **Единственное место, где
  живёт семантика** (какие поля попадут в JSONL, фильтры UI-строк, порядок).
- `scripts/rawdump.mts` — запуск Rust-декодера и чтение его отчёта.
- `scripts/truncation.mts` — лимиты и их счётчики (обрезка не бывает тихой).
- `scripts/unity_classes.mts` — таблица ClassID → имя. Оставлена как общий
  список: её читает кросс-скилловый гард
  `.opencode/skills/extract-text/tests/potgen.test.mts` (TS ↔ Rust).
- `test_data/` — ЗОЛОТО сборки (см. ниже).

**TS-легаси (`unityfs.mts`, `serialized.mts`, `typetree.mts`, `rawscan.mts`,
`dotnet.mts`, `extract.mts`, `lz4.mts`, `lzma.mts`, `binary.mts`, `pystr.mts`,
`jsonl.mts`, `writeRawDumpTs`, `dumpAssets`, `dumpAssetsFromRaw`,
`scripts/dump_parity.mts`, `scripts/dump_bench.mts`) удалено 2026-11-24**
(решение владельца: «всё TS-легаси выпиливаем»). История — в git и
`tasks/2026-11-22-dual-dumper-ts-rust.md`.

## Использование

```bash
# полный дамп в tmp/dump (нужен TCNN_GAME_DIR или установленная игра)
npm run dump

# на подмножество файлов (быстрая проверка)
node .opencode/skills/dump-assets/scripts/dump_assets.mts dump \
  --files level0,bundle_sexscene-chairsaloncg_assets_all_... --out tmp/dump-smoke

# структура: entry бандла + таблица объектов (тоже через rd1 Rust-декодера)
npm run dump:structure
node .opencode/skills/dump-assets/scripts/dump_assets.mts structure --files level0 --json
```

Путь к игре — только через `scripts/game_dir.mts` (env `TCNN_GAME_DIR` или
Steam). В папку игры ничего не пишется.

Промежуточный `rd1` — `tmp/raw/<имя-дампа>.rd1.jsonl` (сотни МБ, в git не
лежит): для полного прогона ≈ 523 МБ, это цена того, что правила извлечения
не дублируются.

### Пределы и обрезки (с 2026-11-22)

Дамп — источник данных, поэтому по умолчанию он **ничего не режет**. Любая
обрезка настраивается флагом и **печатается счётчиком** в конце прогона
(«отброшено N строк, затронуто M, лимит K»); пределы прогона видны и в начале.

```bash
--raw-string-limit <N|all>     # строк raw_strings на объект (по умолчанию all)
--global-string-limit <N|all>  # кандидатов global_strings на ассет (по умолчанию 500)
--dotnet-ui-limit <N|all>      # UI-строк из #US-кучи на сборку (по умолчанию all)
```

Зачем, что дало и почему POT пока нельзя перегенерировать — `docs/dump-losses.md`.

## Золотые фикстуры (оракул сборки)

Второго исполнителя больше нет, поэтому эталон — **байты последнего
принятого вывода**:

- `test_data/assemble-golden-small/` — весь каталог дампа на маленьком `rd1`
  (вход рядом: `test_data/assemble-fixture-smoke2.rd1.jsonl`, 183 КБ).
  Проверяется побайтово, быстро, без игры.
- `test_data/assemble-golden-full.json` — `{файл: sha256}` полного дампа
  (149 файлов). Проверяется только под `TCNN_FULL_GOLDEN=1`.

```bash
# быстрая проверка (вход — git-фикстура)
node --test scripts/assemble_parity.test.mts

# полная проверка: нужен полный rd1 (tmp/raw/dump.rd1.jsonl)
TCNN_FULL_GOLDEN=1 node --test scripts/assemble_parity.test.mts
TCNN_RD1=tmp/raw/other.rd1.jsonl TCNN_FULL_GOLDEN=1 node --test scripts/assemble_parity.test.mts
```

### Как обновить золото

Полное (после осознанного изменения формата в `assemble.rs`):

```bash
npm run dump -- --all --out tmp/dump          # rd1 → tmp/raw/dump.rd1.jsonl
node .opencode/skills/dump-assets/scripts/golden_capture.mts --dir tmp/dump
```

Маленькое (после правки на входе фикстуры — почти никогда):

```bash
node .opencode/skills/dump-assets/scripts/golden_capture.mts --dir tmp/dump --check  # сверка
rm -rf .opencode/skills/dump-assets/test_data/assemble-golden-small
tools/rust-l10n/target/release/rust-l10n.exe dump_assemble \
  .opencode/skills/dump-assets/test_data/assemble-fixture-smoke2.rd1.jsonl \
  .opencode/skills/dump-assets/test_data/assemble-golden-small --json
```

Правило: золото обновляется ТОЛЬКО вместе с осознанным решением о формате
(запись в MAP + `docs/`), а не «чтобы тест позеленел».

## Тесты

```bash
npm run test:assemble    # Rust-сборка против золота (маленькое + полное по env)
npm run test:dump        # discovery сцен + учёт обрезок
```

Фикстуры сборки — производные игры (маленький срез, 183 КБ); файлы игры в
тесты не кладём. Полный `rd1` и полный дамп регенерируются, в git их нет.

## Статус

- Байтовый уровень и сборка — Rust; паритет сборки 149/149 файлов, 0 байтовых
  расхождений (2026-11-24, до удаления TS).
- Полный JSONL-паритет с прежним Python-эталоном (типизированные поля
  `.assets`, обёртки UnityPy) закрыт как «на POT не влияет» — см. MAP.
