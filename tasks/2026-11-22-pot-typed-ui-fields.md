# [2026-11-22] POT: читать UI-поля `strings.*` без фильтра `isUiString`

Статус: READY

## Цель

Вернуть в POT типизированный текст интерфейса, который лежит в известных полях
`MonoBehaviour` и сейчас не читается вообще (инвентарь смотрит только `m_Name` для
bundle-логики). Это самый дешёвый источник покрытия: поле уже типизировано, гадать
«текст или ассет» не нужно.

## Контекст (замер 2026-11-22, `docs/pot-coverage-audit.md`)

- В дампе есть `strings` у 19 349 объектов (только bundle — там есть type tree).
- Инвентарь (`inventory.mts`) **не читает `strings` ни разу**, кроме `strings.m_Name`
  в `collectBundle` (признак PlayMaker) и в оверрайде спикера.
- Промахи по UI-полям (уникальные строки, `tmp/audit/miss-strings____typed_.json`):
  `Description` — 11, `DefaultDisplayName` — 9, `UnlockHint` — 5, `Name` — 3,
  `DisplayName` — 2, `m_text` — 7 (из них 4 служебные «i/d/b/y», 2 Lorem ipsum, 1 «0.2»).
- Примеры адресов:
  - `bundle_lewdanimation_liofuckmachine….jsonl:-5319264188927289000:strings.DefaultDisplayName`
    = `Look for keys.` (цель квеста, `dot+upper`);
  - `bundle_3dsuitcasescene….jsonl:-9057854576939689000:strings.Description`
    = `Just an old pair of shorts to wear around my apartment.` (`len>50`);
  - `bundle_sexscene-rosietitjob….jsonl:8825886232141749000:strings.UnlockHint`
    = `Have a close look at Rosies breasts.` (подсказка галереи).
- В `level`/`sharedassets`/`resources` эти поля в дампе пусты, потому что объекты
  `read_failed` — там правка сработает только после задачи
  `2026-11-22-pot-read-failed-typetree.md`. Но и без неё поля из bundle — реальный текст.

## Что сделать

1. В `inventory.mts` (и Rust `inventory.rs` — паритет) добавить чтение известных
   UI-полей из `strings` с новым `kind` (например `uiField`), минуя `isUiString`:
   `Description`, `DefaultDisplayName`, `UnlockHint`, `DisplayName`, `Name`, `m_text`,
   `UseText`, `TakenFromInventoryText`, `category`.
2. Отсеять служебные значения: длиной < 2, чистые цифры/версии (`0.2`), Lorem ipsum,
   одиночные буквы (`i`, `d`, `b`, `y`).
3. `potgen`: для `uiField` контекст `ui` (или `field:<Имя>` — решить по замеру, чтобы не
   плодить двойные переводы; cross-source dedup должен продолжать работать).
4. Замерить до/после на `tmp/dump-new`: сколько записей добавилось, сколько из них
   человекочитаемые (выборка 20 глазами), нет ли дублей с `raw`-записями.

## Приёмка

- [ ] `potgen` на `tmp/dump-new` добавляет записи из UI-полей; число записей и дельта
      зафиксированы в задаче
- [ ] Ни одна из 36 строк из `tmp/audit/miss-strings____typed_.json` с полями выше не
      осталась вне POT (кроме явно служебных: `0.2`, Lorem ipsum, `i/d/b/y`)
- [ ] Старые записи POT не исчезли (дифф аддитивный)
- [ ] Паритет TS ↔ Rust: POT совпадает побайтово (кроме `POT-Creation-Date`)
- [ ] Тесты: фикстура с объектом, у которого есть `strings.Description`, и без него
- [ ] `npm test`, `npm run test:e2e` зелёные

## Вне рамок

- Чтение `strings` в `*.assets` (это type tree, отдельная задача).
- Перевод новых строк.
- `global_strings` и `#US` (отдельные задачи).

## Файлы

- `.opencode/skills/extract-text/scripts/inventory.mts`
- `.opencode/skills/extract-text/scripts/potgen.mts` (контекст/дедуп)
- `tools/rust-l10n/src/inventory.rs`, `tools/rust-l10n/src/potgen.rs`
- `.opencode/skills/extract-text/tests/inventory.test.mts`, `potgen.test.mts`

## Связи

- `docs/pot-coverage-audit.md` — разделы «Матрица» и «Причины».
- `tasks/2026-11-22-pot-read-failed-typetree.md` — тот же эффект для 96 % объектов.
