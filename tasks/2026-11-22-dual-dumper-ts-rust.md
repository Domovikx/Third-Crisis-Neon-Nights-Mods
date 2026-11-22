# [2026-11-22] Дампер в двух реализациях: TS и Rust (портфолио-сравнение)

Статус: DONE (осталась одна позиция вне зоны — CI-джоб Rust, см. «Остатки»)

## Задача от пользователя

«а можно ли поскольку этот проект и портфолио, напишем два дампера, один на TS а второй на Rust,
оба проверяем честно, оба покрываем тестами, оба сравниваем объективно и оба оставим на проекте
в качестве образца с возможностью быстрого переключения между ними.»

## Итог (одной строкой)

Байтовый уровень в Rust быстрее **в 3.0 раза** (48.0 с против 145.2 с на одинаковой работе и
одинаковом выходе) и ест **в 2.7 раза меньше памяти**; полный пайплайн — **59.6 с против 122.9 с
(2.1×)**, потому что TS оставляет себе семантику (11.2–11.6 с), а выход двух реализаций
**побайтово одинаков**: rd1 523 571 473 байта, дамп 143 файла, POT 37 663 записи.

## Выбранный вариант

**B — Rust как «байтовое ядро», TS — семантика** (см. «Варианты» ниже). Причина: правила
извлечения (что попадает в JSONL/POT, фильтры, дедуп, порядок) живут в одном месте; второй
экземпляр в Rust означал бы «каждое изменение дважды» и риск «почти совпало».

## Граница (контракт)

Промежуточный формат `rd1` — JSONL, одна запись на строку, порядок ключей фиксирован
(сверяется побайтово). Записи: `asset`, `sf`, `type`, `obj`, `warn`, `runs`, `keys`, `us`.
Описание — в шапке `tools/rust-decoder/src/rd1.rs` и `.opencode/skills/dump-assets/scripts/rawdump.mts`.

- **Rust** (`tools/rust-decoder/`): UnityFS (заголовок/blocksInfo/entry), LZ4 (свой) и LZMA
  (`lzma-rs`, единственная зависимость), SerializedFile v22 (header/type table/object table/
  externals/скрипты), raw-сканы объектов (печатные строки, пары `Speaker`/`Text`,
  `ColorParserList`, `Settings.*`), печатные строки файла (кандидаты в `global_strings`,
  дедуп по тексту), куча `#US` .NET-сборки, blob'ы type tree и сырые байты типизированных
  объектов (base64).
- **TS**: чтение type tree и generic-разбор объекта (`strings`/`fields`/`fsm_strings`,
  PlayMaker `line_X`), фильтры «это UI-текст» (`isGlobalStringCandidate`/`uiPriority`/
  `isUiString`), синтез подписей настроек и UI-строк DLL, сборка `summaries.jsonl` +
  `<asset>.jsonl` + `index.md`, POT/PO и всё ниже.

## Что сделано

- `tools/rust-decoder/` — крейт: `binio`, `unityfs`, `lz4`, `lzma`, `serialized`,
  `rawscan`, `dotnet`, `json` (свой JSON+base64), `rd1`, `discover`, `memstats` (пик RSS через
  `K32GetProcessMemoryInfo`), `testkit` (синтетические фикстуры), `main` (CLI:
  `list`/`dump`, `--game`/`--files`/`--asset`/`--list`/`--out`/`--report`).
- `.opencode/skills/dump-assets/scripts/rawdump.mts` — эталон rd1 на TS (`writeRawDumpTs`),
  запуск Rust (`runRustDecoder`, понятная ошибка без бинаря), чтение отчёта.
- `.opencode/skills/dump-assets/scripts/dump_assets.mts` — флаг `--decoder ts|rust` (команды
  `dump` и `structure`), потоковый сборщик дампа из rd1 (`dumpAssetsFromRaw`), отчёты
  `structureFromRaw`, `selectGlobalStrings`, `counterMostCommon`.
- `.opencode/skills/dump-assets/scripts/extract.mts` — опциональный `RawScans` в
  `extractObject` (готовые сканы от другого исполнителя; правила остаются здесь).
- `.opencode/skills/dump-assets/scripts/dotnet.mts` — `scanDotnetUiStrings` принимает уже
  вырезанную кучу `#US` (декодер отдаёт только её).
- `scripts/dump_bench.mts` — бенчмарк: 4 варианта × 2 прогона, фазовые тайминги, пик RSS
  (свой и дочернего процесса), размер выхода, паритет rd1 и дампа внутри прогона → `tmp/bench.json`.
- `.opencode/skills/dump-assets/tests/rust_parity.test.mts` — паритет на синтетике
  (rd1 побайтово + каталоги дампа побайтово); пропускается без бинаря.
- `tools/rust-decoder/tests/{rd1,game}.rs` — интеграционные: формат rd1 на синтетике и полный
  прогон по установленной игре (гейт по наличию; в debug пропускается, чтобы `cargo test` не
  длился 5 минут).
- `docs/rust-vs-ts.md` — методика, цифры (два прогона), где и почему выиграл Rust, условия
  пересмотра границы.

## Приёмка (факты)

- `cargo build --release`, `cargo test` (37 юнит + 5 интеграционных + game-gated),
  `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` — чисто.
- `npm run typecheck`, `npm run lint`, `npm test` (216), `npm run test:dump` (99) — чисто.
- CLI: `dump --decoder rust` на всю игру — 163 ассета, 507 415 объектов; без
  собранного бинаря — внятная ошибка и код 2; `structure --decoder rust` совпадает
  с TS (stdout побайтово); `--decoder bogus` отклоняется.
- Паритет: rd1 **523 571 473 байта** побайтово; дамп **143 файла** побайтово;
  `dump_parity --jsonl`: 142 файла / 507 578 строк / **0** расхождений; POT **37 663** записи,
  2 193 341 байт, `sha256` совпадает (после нормализации `POT-Creation-Date`).
- Бенчмарк: `tmp/bench.json`, два прогона каждого варианта; таблицы — в `docs/rust-vs-ts.md`.

## Решения и готчи (по ходу)

- **Что делает Rust «байтовым», а что нет.** Соблазн отдать в Rust и `strings`/`fields` —
  отклонён: это «что попадает в JSONL», то есть правило, и его место в TS. Взамен Rust
  передаёт blob type tree и сырые байты типизированных объектов (base64) — из них TS читает
  поля тем же кодом, что и в TS-пути, поэтому расхождений нет по построению.
- **Без этого нельзя было сохранить паритет.** `JSON.parse` съедает разницу `60.0` → `60`
  (Python-`repr` float), поэтому generic-дерево в JSON не годится: передаются байты.
- **`global_strings` — только по границам контракта.** Дедуп печатных строк идёт в Rust
  (это факт «строка уже была»), а решение «это UI-текст» и приоритеты — в TS. Фильтр
  ключей/подписей настроек применяется после `keys`, поэтому в rd1 `runs` идёт ДО `keys`.
- **Медленный участок обоих — 437 млн прогонов печатных байтов** (2.18 ГБ входа): Rust 41 с,
  TS 122 с. Ускорять дальше можно механическим предфильтром по длине (3..120) — сознательно
  НЕ делали: это изменило бы контракт формата и сравнивало бы «Rust против оптимизированного
  TS», а не две реализации одной работы.
- **Windows-специфика пика RSS.** Node не умеет отдавать пик дочернего процесса, поэтому
  Rust-бинарь сам пишет `PeakWorkingSetSize` через `K32GetProcessMemoryInfo` (FFI к kernel32,
  без крейтов). Иначе пришлось бы опрашивать `tasklist` и занижать пик.
- **`--list` вместо сотни `--asset`.** 163 ассета в командной строке Windows — на грани
  лимита 32 КБ; адаптер пишет список «имя<TAB>путь» и передаёт одним флагом.

## Остатки

- **CI-джоб Rust** (`.github/workflows/ci.yml` — вне зоны этой задачи). Готовый фрагмент —
  в `docs/rust-vs-ts.md` §11.
- **npm-скрипты** (`rust:build`, `rust:test`, `dump:rust`, `bench:dump`) — `package.json` тоже
  вне зоны; перечень в `docs/rust-vs-ts.md` §11.
- **SKILL.md / MAP.md скилла `dump-assets`** не обновлялись (их правит другая задача): стоит
  добавить абзац про `--decoder rust`, `rawdump.mts` и `rust_parity.test.mts`.
- `tl/`-подобных артефактов нет; промежуточный rd1 (523 МБ) лежит в `tmp/raw/` и в git не идёт.

## Связи

- Текущий порт: `tasks/2026-11-21-dump-assets-island.md`.
- Принципы и порядок: `AGENTS.md` («Принципы и их порядок», включая «оракул проверяет смысл»).
- Стол для сравнения: `scripts/dump_parity.mts`; методика и цифры — `docs/rust-vs-ts.md`.
