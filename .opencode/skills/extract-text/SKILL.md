---
name: extract-text
description: PO-пайплайн текста игры (inventory, pot_rules, po_file, skip-политика). Рабочие команды — Rust (`rust-l10n`, обёртка `scripts/text_cli.mts`); TS-эталоны potgen/po_update удалены 2026-11-24, их выход заморожен в золотых фикстурах. Строки берутся из дампа JSONL; YAML-дерево translations/ удалено.
---

# extract-text — PO-пайплайн текста

## Что где

- Источник правды — `po/template.pot` + `po/<lang>.po` (POT-хаб, **33 447 записей**).
- Строки берутся **из дампа** `tmp/dump/*.jsonl` (выход `dump-assets`),
  не из YAML: дерево `translations/` удалено. `#: translations/*` в старых PO —
  историческое происхождение, не существующие файлы.
- TS-модули: `po_file`, `inventory`, `pot_rules`, `pot_skip`,
  `pot_skip_review`. **Сборщика POT в TS больше нет**: `potgen.mts` и
  `po_update.mts` удалены 2026-11-24, единственная рабочая реализация — Rust
  (`tools/rust-l10n`, обёртка `scripts/text_cli.mts`). `pot_rules.mts` —
  правила каталога для ПРОВЕРОК (`scripts/pot_invariants.mts`: перегенерация и
  сверка POT с дампом); `po2dat`, `prefill` и `find_source` тоже без TS-дублей.
- **Золото выхода** (оракул вместо эталона): `po/template.pot` + метаданные
  (`sha256`, размер, число записей, исходный дамп) в
  `test_data/pot-golden.json`; мини-дамп — `test_data/pot-golden-small.pot`;
  `po_update` — `test_data/po-update-golden/` (вход `po/` + `expected/ru.po`).
  Паритет с золотом стерегут `scripts/text_parity.test.mts` и
  `tests/po_update.test.mts`.
- Правило миграции (владелец, 2026-11-23): как только Rust-реализация
  доказана и протестирована, старый аналог **удаляется в том же коммите** —
  см. `docs/rust-vs-ts.md`.
- Грабли, проверенные на реальном дампе — `MAP.md` этого скилла.
- Формат PO/POT и первоисточники (gettext, translate-toolkit, Babel) —
  `references/PO_FORMAT.md`: что значит каждый префикс, почему флаги через
  запятую, какие правила нельзя нарушать.

## Скрипты (`scripts/`)

- `inventory.mts` — потоковое чтение дампа → плоский список строк
  (`text, speaker, richText, kind, source, idx`). 319 МБ в память не грузятся.
- `pot_rules.mts` — правила каталога `(msgid, msgctxt)` (политика отбора,
  skip-политика, дедуп, `renderPot`) — ТОЛЬКО для проверок POT; генератора и
  CLI здесь нет (рабочий — Rust).
- `po_file.mts` — парсер/рендер PO (детерминированный round-trip).
- `pot_skip.mts` — условия skip-политики (что переводить не нужно) и чистка
  TMP-тегов; `pot_skip_review.mts` — отчёт для ревью правил.

Удалены после миграции на Rust (брать из `rust-l10n`): `prefill_po.mts`,
`po2dat.mts`, `find_source.mts`, `potgen.mts`, `po_update.mts` (2026-11-24).

## Команды

```bash
# Свежий дамп: рабочий декодер — Rust (~3× быстрее), TS — эталон
npm run dump            # = --decoder rust
npm run dump:ts         # эталон-образец, без Rust-тулчейна

# Безопасный прогон: отчёт + tmp/potgen/template.pot (po/ не трогается)
npm run potgen

# Явный дамп (например, старый кэш в папке игры)
npm run potgen -- --dump "<Steam>/…/NeonTranslator/tmp/dump" --out tmp/check.pot
#   то же напрямую: node scripts/text_cli.mts potgen --dump … --out …

# Политика отбора по провенансу (данные): по умолчанию config/pot-src-policy.json
npm run potgen -- --no-policy         # POT как до политики
npm run potgen -- --policy <path>     # другая политика
npm run potgen -- --excluded <path>   # свой журнал
#   исключённые → tmp/pot-excluded.jsonl, состав обоснован в docs/pot-provenance.md

# Обновление EN-шаблона (единственный флаг, меняющий po/)
npm run potgen -- --update

# Перенос переводов в обновлённый POT (бэкап po/<lang>.po.bak)
npm run po:update -- ru
#   флаги: [lang] (по умолчанию ru), --po-dir <dir>, --json <path>

# Предзаполнение PO из YAML-корпуса (легаси-вход translations/, см. ниже)
npm run po:prefill -- ru
#   флаги: [lang], --po-dir <dir>, --corpus <dir>

# Где эта строка в дампе (все вхождения, либо первое)
npm run find:source -- "Yesss...!~"
npm run find:source -- "Wait" --first
#   флаги: --first, --dump <dir> (по умолчанию tmp/dump)
#   exit: 0 — найдено, 1 — нет/дампа нет, 2 — аргументы

# Сборка словаря для игры
npm run po2dat -- ru

# Аудит TMP-разметки в POT (классы: unclosed/crossed/unknown/named-color/…)
npm run rich:audit
npm run rich:audit -- --examples 20 --out tmp/rich-audit.md
```

Запись `template.pot`, `po/<lang>.po` и `.dat` атомарная (`.part` → rename):
обрыв процесса не обнуляет файл. `po_update` пишет `po/<lang>.po.bak`.

`npm run po:prefill` — **про YAML-корпус**: в новой репе дерева `translations/`
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

> Числа выше — дамп ДО снятия лимита `raw_strings`; на `tmp/dump-after`
> (2026-11-22) POT — 143 871 запись без политики и 78 477 с политикой
> (см. `docs/pot-provenance.md`).

### Политика отбора по провенансу

`config/pot-src-policy.json` — **данные**, а не код: `exclude` перечисляет
метки `#. src:`, которые не попадают в POT (точная метка или префикс с `*`:
`raw:Font`, `raw:Tex*`, `raw:*`, `field:*`), `include: ["*"]` — «всё
остальное». По умолчанию исключены 5 идентификаторных raw-классов
(`Font`, `Mesh`, `MonoScript`, `Texture2D`, `Sprite`): −45,5 % записей ценой
1,4 % «прозы».

- Исключённые записи не теряются: `tmp/pot-excluded.jsonl`
  (`{src, msgid, msgctxt, reason}`), порядок POT, запись атомарная.
- Отчёт прогона: `policy: excluded N, kept M` + разбивка по меткам + размер POT
  в MiB.
- Ошибка (а не молчание): битый JSON, неизвестное поле, пустой `include`,
  неизвестная метка (`raw:Fontt`, `dilog`).
- Флаги: `--policy <path>`, `--no-policy` (POT как до политики),
  `--excluded <path>`. У Rust те же.
- Обоснование, полный замер и список меток «на решение владельцу» (`TextAsset`,
  `AudioClip`, `Material`…) — `docs/pot-provenance.md`, раздел «Политика».

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
- `#:` refs **не пишутся**; провенанс ищется по дампу (`npm run find:source`);
- `#. src:` — провенанс записи: `dialog`, `bundle`, `field:<ИмяПоля>`,
  `settings`, `us`, `raw:<TypeName>`, `global` (метка = путь доставки в POT,
  первое вхождение побеждает; список фиксирован — инвариант 14 контракта,
  смысл и распределение — `docs/pot-provenance.md`);
- `#. rich_text:` — исходная TMP-разметка; `<font>`/`<material>` вырезаны
  (шрифт выбирает рантайм), цвет остаётся;
- ui-двойник строки с диалоговым контекстом удаляется: рантайм ищет по голому
  тексту, иначе один текст переводится дважды;
- `msgstr ""` → не переведено.

Записи, чья метка `#. src:` исключена политикой
(`config/pot-src-policy.json`), в POT не пишутся — они лежат в
`tmp/pot-excluded.jsonl` (`{src, msgid, msgctxt, reason}`), чтобы отбор не был
потерей данных.

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

## Золото и тесты

Золото — это снятые с TS-эталона байты, закоммиченные как оракул. Пересобирать
его вручную нельзя: любое расхождение Rust с золотом — сигнал, что изменилось
поведение генератора (данные политики, дедуп, порядок).

- `test_data/pot-golden.json` — паспорт полного POT: `sha256`, размер, число
  записей, дата и дамп (`tmp/dump-after`), команда воспроизведения.
- `test_data/pot-golden-small.pot` — POT мини-дампа `test_data/tiny-dump`
  (воспроизводим без игры, `--created 2026-01-02 03:04+0000`,
  `--no-policy --no-skip-policy --no-skip-ids`).
- `test_data/po-update-golden/` — вход `po/` (template.pot + ru.po) и
  `expected/ru.po` + `expected/stats.json` для `po_update`.

```bash
# Вся TS-матрица (правила POT через Rust CLI + золотые слепки)
npm test

# Сквозной: дамп → POT → .dat на мини-фикстуре (без игры и сети)
npm run test:e2e

# Слепки остальных команд (обновление — только осознанно, дифф виден):
npm run test:golden
GOLDEN_UPDATE=1 npm run test:golden
```

Проверка золота вручную:

```bash
npm run potgen -- --dump tmp/dump-after --out tmp/pot-check.pot
# сравнить с po/template.pot, игнорируя строку POT-Creation-Date
```

Фикстура — `test_data/tiny-dump/`. Rust-сторона: `cargo test -p rust-l10n`
(`tools/rust-l10n/tests/`).

История паритета с Python и TS (цифры, даты, чем сверяли) — `docs/rust-vs-ts.md`
и `tasks/2026-11-22-*`. Здесь остаётся только то, что действует сейчас.
