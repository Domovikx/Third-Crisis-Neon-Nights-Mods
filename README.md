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

Репозиторий переехал из папки игры (старый `NeonTranslator` — **DEPRECATED**). Миграция
**Python → TS → TS + Rust** завершена: Python в проекте больше нет, а текстовый пайплайн
(дамп, POT/PO, `.dat`, QA) целиком работает на Rust. Новый код — `.mts` или `.rs`.

Подробности, инвентарь и порядок портирования — `docs/migration.md`, задачи — `tasks/`.

## Стек: TypeScript + Rust

Проект намеренно использует **оба языка** и показывает, где каждый силён.

- **TypeScript** — продукт и обвязка: PO-парсер и правила проверок, QA-очередь и HTML-отчёты,
  перевод, сборка, деплой, сайт, CLI.
- **Rust** — вычисления с плотными данными: декодер контейнеров Unity (свой LZ4/LZMA, единственная
  зависимость — `lzma-rs`), сборка дампа, POT/PO/`.dat` и вычислительное ядро QA перевода
  (2.6–3.7× быстрее TS и без упора в память на корпусах в сотни МБ).

Замер на реальной игре (163 ассета, 507 415 объектов, два прогона, `docs/rust-vs-ts.md`):

| Что              | TypeScript | Rust   | Разница  |
| ---------------- | ---------- | ------ | -------- |
| Байтовый уровень | 145.2 с    | 48.0 с | **3.0×** |
| Пиковая память   | 1306 МБ    | 483 МБ | **2.7×** |
| Весь пайплайн    | 119.3 с    | 57.5 с | **2.1×** |

Таблица — замер 2026-11-22 против TS-реализаций, которые **удалены 2026-11-24**: рабочая
версия осталась на Rust, а эталон заморожен в золотые фикстуры (`test_data/`, `sha256`
выходов). Паритет проверяется побайтово: дамп (149 файлов) и POT (18 445 записей, один
`sha256`) обязаны совпасть со слепком.

Один рабочий путь: `npm run dump` (Rust-декодер + сборка на Rust).

## Рамки и языки

- **Текст — и отдельная ветка озвучки.** Текст (POT/PO/`.dat`) — рабочий релиз.
  Озвучка — подготовка: карта голосов, рефы и план
  (`tasks/2026-11-26-pot-voicing-plan.md`), в публичный релиз пока не входит.
- Оригинал — английский (`po/template.pot`), переводы — `po/<code>.po`.
- Набор и порядок языков — `config/language-priority.mts` (источник; JSON рядом —
  генерируемый артефакт). Статистика Steam, окт. 2026:
  `en` (источник) → `zh` → `ru` → `es` → `pt` → `de` → `ja` → `fr` → `pl` → `ko` → `it`.
  Проверка соответствия: `node scripts/languages.mts --check`.
- Выбор языка в игре — собственная панель (штатный селектор разработчики скрыли).

## Пайплайн

```text
npm run dump ──→ tmp/dump/ (JSONL, вне гита)
        │
        ▼
npm run potgen ──→ po/template.pot (источник правды, ~18k записей)
        │
        ▼
po/<lang>.po ──→ npm run po2dat ──→ runtime/patch_<lang>.dat (JSON-lines)
        │
        ▼
npm run deploy ──→ <игра>/dwmapi.dll + <игра>/mods/NeonTranslatorDX/ (DLL + patch + шрифты + active_lang.txt + манифест)
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
- **Менеджер (exe).** `installer-ui/` — `NeonTranslatorDX Manager` на Tauri 2
  (Rust + React 19 + StyleX): находит игру по Steam, показывает состояние мода
  (версия, язык, целостность) и из одного окна **ставит, обновляет, проверяет и
  удаляет** перевод. Манифест `install-manifest.json` (sha256 + версия пакета)
  — общий с ручным `.7z` (там манифест создаёт рантайм при первом запуске),
  поэтому удаление одинаковое. Payload
  (`payload/`) собирается `npm run payload` и **вшивается в бандл** как ресурс
  (`bundle.resources`): NSIS кладёт его в папку установки, fallback — папка
  `payload/` рядом с exe. Иконки — `npm run icons` из исходного арта. Ручной
  архив (`npm run manual`) — без `.exe/.cmd/.ps1`, манифест создаёт рантайм при
  первом запуске, FOMOD для Vortex. См. `installer-ui/README.md`.
- **CLI-план.** `installer/install.mts`: находит игру, сверяет язык с
  приоритетом, показывает план раскладки; копирование — через `deploy.mts`
  (отдельной второй реализации нет).

## Структура

- `.opencode/skills/` — скиллы пайплайна (`pipeline-common`, `extract-text`, `dump-assets`,
  `build-translator`, `translate-local`, `translate-qa`, `translates`, `deploy-translator`)
- `po/` — `template.pot` и `<lang>.po`: источник правды по текстам
- `fonts/` — TTF для кириллицы и CJK
- `runtime/` — артефакты сборки (DLL, `patch_*.dat`), в git не попадают
- `scripts/` — общие скрипты репозитория
- `installer-ui/` — установщик (Tauri 2 + React 19 + StyleX) и сборка payload/ручного `.7z`
- `docs/` — архитектура и миграция
- `tasks/` — очередь задач
- `tmp/` — временное (не коммитится)

## Технологии

- Unity 2022.3.62f3 (URP), .NET 4.x (Mono), IL2CPP не используется
- Фреймворк игры: ANToolkit; логика: PlayMaker FSM
- Addressables: 97 `.bundle` (LZ4HC), из них с UI-текстом — 4
- Рантайм: собственный `NeonTranslatorDX.dll` (scan-and-replace, без внешних библиотек)
- Пайплайн: TypeScript (`.mts`, Node 22+) + Python только для дампа Unity-ассетов

## Требования

- Node.js 22+
- Python 3.11+ и `UnityPy` — только для дампера (`dump-assets`)
- .NET Framework SDK (`csc.exe`) — для сборки DLL
- MSVC Build Tools (`cl.exe`) — для сборки прокси `dwmapi.dll`
- Лицензионная копия игры

## Лицензия

- **Код инструментов** (сборка, экстрактор, дампер, рантайм, установщик) — [MIT](LICENSE).
  Лицензия покрывает **только код**: ассеты игры, тексты, персонажи и голоса ею
  не лицензируются.
- **Файлы перевода** (`po/*.po`, собранные `patch_*.dat`) —
  [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/): свободно с указанием авторства,
  без коммерческого использования.
- **Фан-статус, голоса и порядок удаления** — [NOTICE-FANWORK.md](NOTICE-FANWORK.md)
  (русский и английский): некоммерческая фан-работа, голоса синтезированы ИИ,
  референс-аудио не распространяется, удаление по первому требованию.

Перевод — неофициальная фанатская работа, не связанная с разработчиками. Все права на игру
принадлежат [Anduo Games](https://store.steampowered.com/app/3400350/Third_Crisis_Neon_Nights/).
Для использования перевода нужна лицензионная копия игры.

## Где посмотреть и послушать

- **Сайт (опубликован):** https://domovikx.github.io/Third-Crisis-Neon-Nights-Mods/ — RU/EN.
- **Релиз:** https://github.com/Domovikx/Third-Crisis-Neon-Nights-Mods/releases/tag/v2026.11.26-1
  (`NeonTranslatorDXManager.exe`, NSIS-setup, `manual.7z`).
- **UI менеджера локально:** собрать `cd installer-ui && npm run build && npm run tauri dev`
  или запустить `dist/NeonTranslatorDXManager.exe` (payload лежит в `dist/payload/`).
  Браузерный мок без Tauri: `cd installer-ui && npm run dev`.
- **Послушать пробу озвучки:** `tmp/vox-test/` — варианты рефа Narrator A/B/C на одной
  длинной русской фразе с эмоцией (`report.md` рядом: длительности, LUFS, время).
- **Рефы голосов:** `voice-refs/<Персонаж>/candidates/` (+ `chosen/` — выбранный вручную).
