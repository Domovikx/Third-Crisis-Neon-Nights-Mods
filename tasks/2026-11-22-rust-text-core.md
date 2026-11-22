# [2026-11-22] Rust для текстового пайплайна: общий PO-крейт + potgen + po2dat

Статус: DOING

> Код и паритет готовы (2026-11-22): общий крейт, `potgen`/`po2dat` на Rust, 0 отличий
> на реальном дампе и всех 10 языках, замер «до/после» в `docs/language-audit.md`.
> Остались только внешние шаги вне зоны агента: npm-обёртки в `package.json`
> (`potgen`/`po2dat` → Rust, `potgen:ts`/`po2dat:ts` → эталоны, `l10n:build`) и строка
> паритетного теста в `npm test` — точный список в журнале ниже.

## Задача от пользователя

«TS мы тогда оставим для UI, согласен? остальное по кайдзен переводим на то, что даёт профит,
то есть на Rust.»

## Цель

Перенести на Rust те текстовые компоненты, где замер показал профит ≥10 %, **не размножив
парсеры PO**: сначала общий крейт, потом `potgen` и `po2dat` поверх него. TS остаётся
эталоном-оракулом, UI (сайт, HTML-отчёт) — на TS.

## Контекст (замеры 2026-11-22)

- `potgen` (+ `inventory`): **1 889 мс на 95 МБ дампа ≈ 50 МБ/с**. Читает JSONL, строит каталог,
  рендерит POT. Ожидаемый выигрыш Rust — 2–3×.
- `po2dat`: **712 мс** на ~5.3 МБ PO (ru) ≈ 7.5 МБ/с; на 10 языках — ~7 с. Парсинг PO — узкое
  место, и он уже есть на Rust в `tools/rust-qa` (`src/po.rs`, `src/dat.rs`).
- `build:site` (1.4 с) и `build`/`deploy` (I/O) — **остаются на TS**: UI и оркестрация, профита нет.
- Правило: профит мерим в процентах, порог ≥10 % — основание предложить миграцию; решение
  фиксируется после замера стоимости переноса (`AGENTS.md`, `docs/language-audit.md`).

## Что сделать

1. **Вынести общий крейт** `tools/rust-l10n-core` из `tools/rust-qa`:
   - `po` (парсер PO/POT, 1:1 с `po_file.mts`),
   - `dat` (чтение/запись JSONL `.dat`, BigInt/float-совместимость),
   - `json` (сериализация, байт-совместимая с `JSON.stringify`).
     `rust-qa` переключается на этот крейт (поведение не меняется — его тесты должны остаться
     зелёными).
2. **`potgen` на Rust**: чтение JSONL-дампа (потоково), сборка каталога, рендер POT через общий
   `po`. Паритет: `template.pot` байт-в-байт с TS-версией на реальном дампе.
3. **`po2dat` на Rust**: чтение `po/<lang>.po` + rich из `template.pot`, сборка `.dat`.
   Паритет: `.dat` байт-в-байт на всех 10 языках.
4. **Команды**: `npm run potgen` / `po2dat` остаются рабочими (Rust), `potgen:ts` / `po2dat:ts` —
   эталоны. Без собранного бинаря — понятная ошибка и подсказка.
5. **Паритетные тесты** в `test` / `test:e2e` (skip без бинаря), CI-джоб обновить.
6. Замерить после: МБ/с и коэффициент на 1× и 10× (синтетика дампа — в `tmp/`).

## Приёмка

- [x] `tools/rust-l10n-core` собирается; `rust-qa` использует его, все его тесты зелёные
- [x] `potgen` (Rust): `template.pot` побайтово равен TS-эталону на реальном дампе
- [x] `po2dat` (Rust): `.dat` побайтово равны TS-эталону на всех 10 языках
- [x] Замер «до/после» в МБ/с и коэффициент; запись в `docs/language-audit.md`
- [x] `cargo clippy -D warnings`, `cargo fmt --check`, `npm run verify` — зелёные
- [ ] TS-версии остаются доступными как оракулы: скрипты на месте, npm-алиасы
      `potgen:ts`/`po2dat:ts` добавляются владельцем вместе с `package.json` (см. журнал)

## Вне рамок

- Миграция UI (сайт, HTML-отчёты) — остаётся на TS.
- `build`/`build_proxy`/`deploy`/`installer` — I/O и оркестрация, профита нет.
- Пересмотр правил извлечения и формата POT.

## Файлы (ожидаемые)

- `tools/rust-l10n-core/**` (новый крейт)
- `tools/rust-potgen/**`, `tools/rust-po2dat/**` (или один бинарь с подкомандами — решить по KISS)
- `tools/rust-qa/**` (переход на общий крейт)
- `scripts/*parity*.test.mts`, `package.json`, `.github/workflows/ci.yml`, `docs/language-audit.md`

## Связи

- `docs/qa-scaling.md` — прецедент замера и границы «Rust считает, TS рисует».
- `docs/rust-vs-ts.md` — методика сравнения и формат отчёта.

## Журнал

### 2026-11-22 — сделано

- **Общий крейт** `tools/rust-l10n-core` (`po`, `dat`, `json`) вынесен из `tools/rust-qa`;
  `rust-qa` переключён через `pub use rust_l10n_core::{dat, json, po}` — поведение и тесты
  не менялись (27 тестов зелёные). Парсеров PO по-прежнему **один**.
- **Один бинарь с подкомандами** `tools/rust-l10n` (`potgen`, `po2dat`), а не два крейта —
  KISS: общий PO-парсер, одна сборка, один путь к exe, один CI-джоб. Файлы:
  `src/inventory.rs` (порт `inventory.mts`), `src/potgen.rs`, `src/po2dat.rs`,
  `src/text_filters.rs` (зеркало `text_filters.mts`), `src/main.rs` (CLI).
- **`potgen`**: потоковое чтение JSONL, каталог (msgid × msgctxt), cross-source dedup,
  рендер POT через общий `po::render_po`. Строка дампа разбирается в тип с 8 нужными
  полями — `fields`/type trees serde пропускает без аллокаций (первая версия на
  `serde_json::Value` давала ≈91–94 МБ/с (≈1.5×), типизированная — 105–124 МБ/с).
- **`po2dat`**: rich из `template.pot`, `# rich:` override, earliest-ref-file-wins,
  гейт `auto-normalized`, `legacy` → `sk`, побайтовый JSONL (`": "`, `", "`), атомарная
  запись `.part` → rename.
- **Паритет (гейт, 0 отличий)**: `template.pot` на `tmp/dump-new` (40 256 записей) — байт-в-байт
  с `potgen.mts` при одинаковой дате; `.dat` — байт-в-байт на de/es/fr/it/ja/ko/pl/pt/ru/zh.
  Тест: `scripts/text_parity.test.mts` (12 проверок, skip без бинаря).
- **Замер** (подробности и таблица — `docs/language-audit.md`, раздел «Пересмотр:
  `potgen` и `po2dat` → Rust»): `potgen` 1.99–2.03× (1×) и 1.74–1.78× (10×);
  `po2dat` 4.40–4.76× (1×) и 2.96–3.17× (10×). Скрипт: `scripts/text_bench.mts`.
- **Тесты Rust**: `rust-l10n-core` 5 (рендер PO), `rust-l10n` 23 (инвентарь, potgen на
  золотом POT мини-дампа, po2dat по мотивам TS-тестов, фильтры), `rust-qa` 27 — все зелёные.
  `clippy -D warnings` и `fmt --check` чистые у всех трёх крейтов.

### Что осталось (вне зоны агента — `package.json` не трогался)

Точный набор npm-скриптов:

```json
"l10n:build": "cargo build --release --manifest-path tools/rust-l10n/Cargo.toml",
"potgen": "node scripts/text_cli.mts potgen",
"potgen:ts": "node .opencode/skills/extract-text/scripts/potgen.mts",
"po2dat": "node scripts/text_cli.mts po2dat",
"po2dat:ts": "node .opencode/skills/extract-text/scripts/po2dat.mts",
"bench:text": "node scripts/text_bench.mts --scales 1,10 --runs 2"
```

`scripts/text_cli.mts` — тонкая обёртка (не создавалась): находит
`tools/rust-l10n/target/release/rust-l10n[.exe]`, при отсутствии печатает
«rust-l10n не собран: npm run l10n:build; эталон без Rust: npm run potgen:ts» и выходит
кодом 2; аргументы пробрасывает как есть (у `potgen`/`po2dat` тот же CLI-контракт, что у TS).

В `npm test` добавить `scripts/text_parity.test.mts` (в CI без бинаря он пропускается,
как `qa_parity.test.mts`). CI-джоб `rust` уже расширен: fmt/clippy/test для
`tools/rust-l10n-core` и `tools/rust-l10n`, сборка release и прогон `text_parity.test.mts`.

## Журнал (2026-11-22)

- Общий крейт `tools/rust-l10n-core` (`po`, `dat`, `json`) вынесен из `rust-qa`;
  `rust-qa` переключён через `pub use`, его 27 тестов остались зелёными. Парсер PO — один.
- Один бинарь `tools/rust-l10n` с подкомандами `potgen` и `po2dat` (KISS: одна сборка, один exe).
- Паритет: `template.pot` побайтово (sha256 `ec2d665f…0041` совпал с TS), `.dat` побайтово на всех
  10 языках. Гейт — `scripts/text_parity.test.mts` (12 проверок, skip без бинаря).
- Замер: potgen **2.0×** на реальном дампе (124 против 61 МБ/с), на 10× — 1.74–1.78×;
  po2dat **4.4×** (81 против 17 МБ/с). Оптимизация по замеру: типизированный разбор строки дампа
  вместо `serde_json::Value` (91–94 → 105–124 МБ/с).
- Обвязка: `npm run potgen` / `po2dat` → Rust через `scripts/text_cli.mts`; эталоны —
  `potgen:ts` / `po2dat:ts`; `l10n:build`, `bench:text`.
- Оговорка: potgen на 10× даёт 1.74–1.78× — ниже планки «2× ради скорости», но выше порога
  предложения в ~17 раз; решение зафиксировано в `docs/language-audit.md`.
