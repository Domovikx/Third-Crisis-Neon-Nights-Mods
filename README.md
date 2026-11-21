# Third Crisis: Neon Nights — локализация

> **18+ ONLY**
> Репозиторий содержит материалы (диалоги, UI, описания) из игры **Third Crisis: Neon Nights** —
> произведения для взрослых. Весь контент предназначен исключительно для лиц старше 18 лет.
> Администрация GitHub допускает такой контент в художественных и образовательных целях согласно
> [Acceptable Use Policies — Sexually Obscene Content](https://docs.github.com/en/site-policy/acceptable-use-policies/github-sexually-obscene-content).
>
> _If you are under 18, please leave this repository._

Инструменты для извлечения, перевода и рантайм-подмены текста игры
**Third Crisis: Neon Nights** (Anduo Games): дамп Unity-ассетов → POT/PO-хаб → компиляция
словаря → рантайм-переводчик на C# (scan-and-replace через BepInEx).

**Теги:** `Third Crisis Neon Nights` `русская локализация` `русификатор` `Russian translation`
`Anduo Games` `Unity 2022.3` `PlayMaker` `визуальная новелла` `киберпанк` `TypeScript` `BepInEx`

## Про игру

**Third Crisis: Neon Nights** — приквел к Third Crisis, действие через три года после мирового
кризиса. Киберпанк-метрополия Neon City, коррумпированное правительство GAG, наёмница Зои Мэдисон.
RPG / визуальная новелла на Unity 2022.3.62f3 (URP) со скриптингом PlayMaker FSM.

- Steam: https://store.steampowered.com/app/3400350/Third_Crisis_Neon_Nights/
- Itch.io: https://anduogames.itch.io/third-crisis-neon-nights

## Состояние

Репозиторий переехал из папки игры (старый `NeonTranslator` — **DEPRECATED**) и одновременно
переводится с Python на TypeScript. Новый код — только `.mts`; Python остаётся единственным
островом (дампер Unity-ассетов через UnityPy).

Подробности, инвентарь и порядок портирования — `docs/migration.md`, задачи — `tasks/`.

## Рамки и языки

- **Только текст.** Озвучки в проекте нет и не планируется.
- Оригинал — английский (`po/template.pot`), переводы — `po/<code>.po`.
- Набор и порядок языков — `config/language-priority.json` (статистика Steam, окт. 2026):
  `en` (источник) → `zh` → `ru` → `es` → `pt` → `de` → `ja` → `fr` → `pl` → `ko` → `it`.
  Проверка соответствия: `node scripts/languages.mts --check`.
- Выбор языка в игре — собственная панель (штатный селектор разработчики скрыли).

## Пайплайн

```text
dump_assets.py ──→ tmp/dump/ (JSONL, вне гита)
        │
        ▼
potgen ──→ po/template.pot (источник правды, ~33k записей)
        │
        ▼
po/<lang>.po ──→ po2dat ──→ runtime/patch_<lang>.dat (JSON-lines)
        │
        ▼
deploy ──→ <игра>/…/Managed/ (DLL + patch + шрифт + active_lang.txt)
```

Рантайм читает **один** `patch_<lang>.dat`; переводы живут в памяти, бинарники игры не
модифицируются. Штатного переключателя языка в игре нет — встроен свой оверлей (`F9`).

## Быстрый старт

```bash
npm install
npm run check:game     # найти установку игры (или задать TCNN_GAME_DIR)
npm run check:langs    # языки в po/ совпадают с приоритетом
npm run po2dat -- ru   # po/ru.po -> runtime/patch_ru.dat
npm run build:site     # собрать site/index.html (цифры — из po/)
npm run mod:install    # план установки в игру (dry-run)
npm test               # тесты (node --test)
npm run verify         # typecheck + lint + format + langs + tests + e2e
```

Путь к игре: переменная `TCNN_GAME_DIR`, иначе автопоиск по Steam-библиотекам
(`scripts/game_dir.mts`). Репозиторий больше **не** живёт внутри папки игры.

## Сайт и установка

- **Сайт (GitHub Pages).** `site/template.html` + `site/styles.css`; `npm run build:site`
  собирает `site/index.html`, подставляя языки и **реальное покрытие** из `po/*.po`.
  Цифры руками не правятся — иначе страница начнёт врать. Публикация — workflow `pages`.
- **Инсталлятор (заготовка).** `installer/install.mts`: находит игру, сверяет язык с
  приоритетом, показывает план раскладки и чего не хватает. Копирование появится вместе с
  портом `deploy.ps1` — двух реализаций быть не должно.
- **Мод-менеджер** — следующий шаг после деплоя (список языков, переключение, удаление,
  обновление); см. `installer/README.md`.

## Структура

- `.opencode/skills/` — скиллы пайплайна (`pipeline-common`, `extract-text`, `dump-assets`,
  `build-translator`, `translate-local`, `translate-qa`, `translates`, `deploy-translator`)
- `po/` — `template.pot` и `<lang>.po`: источник правды по текстам
- `fonts/` — TTF для кириллицы и CJK
- `runtime/` — артефакты сборки (DLL, `patch_*.dat`), в git не попадают
- `scripts/` — общие скрипты репозитория
- `docs/` — архитектура и миграция
- `tasks/` — очередь задач
- `tmp/` — временное (не коммитится)

## Технологии

- Unity 2022.3.62f3 (URP), .NET 4.x (Mono), IL2CPP не используется
- Фреймворк игры: ANToolkit; логика: PlayMaker FSM
- Addressables: 97 `.bundle` (LZ4HC), из них с UI-текстом — 4
- Рантайм: собственный `NeonTranslatorRuntime.dll` (BepInEx 5, без внешних библиотек)
- Пайплайн: TypeScript (`.mts`, Node 22+) + Python только для дампа Unity-ассетов

## Требования

- Node.js 22+
- Python 3.11+ и `UnityPy` — только для дампера (`dump-assets`)
- .NET Framework SDK (`csc.exe`) — для сборки DLL
- MSVC Build Tools (`cl.exe`) — для сборки прокси `dwmapi.dll`
- Лицензионная копия игры

## Лицензия

- **Код инструментов** (сборка, экстрактор, дампер, рантайм) — [MIT](LICENSE).
- **Файлы перевода** (`po/*.po`, собранные `patch_*.dat`) —
  [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/): свободно с указанием авторства,
  без коммерческого использования.

Перевод — неофициальная фанатская работа, не связанная с разработчиками. Все права на игру
принадлежат [Anduo Games](https://store.steampowered.com/app/3400350/Third_Crisis_Neon_Nights/).
Для использования перевода нужна лицензионная копия игры.
