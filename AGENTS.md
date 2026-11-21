# Third Crisis: Neon Nights — инструменты локализации

Репозиторий инструментов для перевода **Third Crisis: Neon Nights** (Anduo Games):
дамп Unity-ассетов → POT/PO-хаб → компиляция словаря → рантайм-переводчик C#
(scan-and-replace, BepInEx).

> **18+**: репозиторий содержит тексты игры для взрослых. См. `README.md`.

## Состояние: миграция в процессе (с 2026-11-21)

Репозиторий переехал из папки игры (`<Steam>/…/Third Crisis Neon Nights/NeonTranslator/`,
теперь **DEPRECATED**) в отдельный каталог. Одновременно идёт миграция **Python → TypeScript**.

- **Новый код — только `.mts`.** Никаких новых `.py`.
- **Python допускается только там, где физически не обойтись** — сейчас это единственный
  остров: `dump-assets/scripts/dump_assets.py` (UnityPy не имеет TS-эквивалента).
  Порт дампера — отдельная задача, не самоцель.
- Старые `.py` рядом с портированными модулями — **референс до удаления**, не править и не звать.
- План, инвентарь и порядок портирования — `docs/migration.md` и `tasks/`.

## Структура

```text
.opencode/skills/          # самодостаточные скиллы (SKILL.md + scripts + tests)
  pipeline-common/         # общие фильтры пайплайна — единственный владелец
  extract-text/            # POT/PO/DAT: po_file, po2dat, potgen + inventory (TS)
  dump-assets/             # дамп Unity-ассетов (PYTHON-ОСТРОВ: UnityPy)
  build-translator/        # C# рантайм + сборка DLL/прокси
  translate-local/         # пакетный перевод через локальную LLM
  translate-qa/            # офлайн-QA перевода
  translates/              # правила перевода (core + языки)
  deploy-translator/       # деплой в игру
po/                        # template.pot + <lang>.po — ИСТОЧНИК ПРАВДЫ (не форматировать)
fonts/                     # TTF для кириллицы/ CJK
runtime/                   # артефакты сборки (DLL, patch_*.dat) — не трекаются
scripts/                   # общие скрипты репо (поиск игры и пр.)
docs/                      # архитектура, миграция
tasks/                     # очередь задач (протокол — tasks/README.md)
tmp/                       # временное, в git не попадает
```

## Пайплайн

```text
dump_assets.py ─→ tmp/dump/ (JSONL, вне гита)
        │
        ▼
potgen ─→ po/template.pot (источник правды)
        │
        ▼
po/<lang>.po ─→ po2dat ─→ runtime/patch_<lang>.dat (JSON-lines)
        │
        ▼
deploy ─→ <игра>/…/Managed/ (DLL + patch + шрифт + active_lang.txt)
```

Рантайм читает **один** `patch_<lang>.dat` (UTF-8, один JSON-объект на строку).
Переводы живут в памяти (scan-and-replace), бинарники игры не модифицируются.

## Рамки мода

- **Только текст.** Озвучка (TTS, клоны голоса, VoxCPM и любое аудио) не входит в проект
  и не планируется.
- Несколько языков одновременно; выбор языка — **наша собственная панель в игре**
  (штатный селектор разработчики скрыли: в `StreamingAssets/Languages/` пусто).
- Оригинал не модифицируется: перевод подменяется в памяти (scan-and-replace).

## Языки

Единый источник — `config/language-priority.json` (копия приоритета TSSR: языковая статистика
Steam, окт. 2026). Правила:

- Язык-источник — `en`: его текст в `po/template.pot`, отдельного `en.po` нет.
- Остальные языки — `po/<code>.po`; **порядок везде берётся из конфига**, руками не переставлять.
- Новый язык = строка в JSON + `po/<code>.po` + запись в списке UI.
- Страж: `node scripts/languages.mts --check` и `scripts/languages.test.mts` — набор языков и
  порядок обязаны совпадать с конфигом.

## Команды

```bash
npm install
npm run check:game     # найти и проверить установку игры
npm run potgen         # дамп -> tmp/potgen/template.pot (без --update po/ не трогает)
npm run po2dat -- ru   # po/ru.po -> runtime/patch_ru.dat
npm test               # node --test
npm run test:e2e       # дамп -> POT -> .dat на мини-фикстуре
npm run typecheck      # tsc --noEmit
npm run lint           # oxlint
npm run format         # prettier --write
npm run verify         # всё вместе
```

Путь к игре: `TCNN_GAME_DIR` (иначе — автопоиск по Steam-библиотекам, `scripts/game_dir.mts`).

## Соглашения

- **Коммит — только по явной просьбе человека.** Ни авто-коммитов, ни «промежуточных».
- Проверяй сохранённый `.mts` сразу: `npx oxlint --fix <файл>` + `npx prettier --write <файл>`,
  сомнения в типах — `npm run typecheck`.
- Тесты — `node --test` рядом с кодом (`*.test.mts`), не pytest (pytest остался только у
  python-острова и C#-сборки).
- **Данные не форматируем:** `po/`, `fonts/`, `runtime/` под prettier не попадают (`.prettierignore`).
- **Запись файлов — атомарная** (`.part` → rename): обрыв посреди записи не должен обнулять
  каталог переводов.
- **JSON — только для конфигов.** Bulk-данные (дампы, каталоги) — JSONL.
- **Длина не критерий качества перевода.** Никаких проверок «msgstr короче/длиннее msgid».
  Единственная сверка — смысловая.
- Временное — только в `tmp/` этого репо, не в системный `%TEMP%`.
- Доки правятся вместе с кодом, а не после.

## Рантайм (C#), коротко

`NeonTranslatorRuntime.dll` — BepInEx-плагин: перехватывает отрисовку и подменяет текст в памяти.
Кириллица добавляется в TMP-атлас в рантайме (`TryAddCharacters`), CJK для ja/zh/ko рисуется
оверлеем UGUI. Штатного переключателя языка в игре нет — свой оверлей (`F9`).
Подробности — `AGENTS.md` старого репозитория (архив) и `docs/`.

## Связи

- Старый репозиторий: `<игра>/NeonTranslator` (DEPRECATED, см. `DEPRECATED.md` там).
- Дамп и перевод — `docs/migration.md`.
