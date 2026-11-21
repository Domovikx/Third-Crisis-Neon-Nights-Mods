# [2026-11-21] Инициализировать репозиторий и портировать базовый слой

Статус: DONE

## Задача от пользователя

«я хочу переписать и сделать миграцию в новую репу, которую надо создать по аналогии с текущей.
тоесть это будет нейминг кебебстайл и Third-Crisis-Neon-Nights-Mods название сделаем и положим в
C:\Users\Domo\workspace\ старую максимально запускаем миграцию на ts mts вместо питона. старую репу
помечаем как депрекейт. пока что просто запускаем процесс плавной миграции, с инициализацией.
е2е и запуск игры пока не делаем. оформляем задачки переезжаем структурой пушим инициализацию
репозитория, что можно переносим без запуска игры, проверяем что игра вообще есть, делаем планы.»

## Цель

Появился отдельный репозиторий (не внутри папки игры) с каркасом на TS, перенесёнными данными и
первым слоем кода, переведённым с Python без изменения поведения. Дальнейшие шаги разложены в
задачи, старая репа помечена как DEPRECATED.

## Контекст

- Старый репозиторий: `<Steam>/…/Third Crisis Neon Nights/NeonTranslator/`, 105 коммитов,
  remote `github.com/Domovikx/Third-Crisis-Neon-Nights`. Жил внутри папки игры.
- Игра установлена: `C:\Program Files (x86)\Steam\steamapps\common\Third Crisis Neon Nights`
  (Unity 2022.3, `Third Crisis Neon Nights_Data/Managed/Assembly-CSharp.dll` на месте).
- Пайплайн: дамп (UnityPy) → `potgen` → `po/<lang>.po` → `po2dat` → `runtime/patch_<lang>.dat`
  → `deploy`. Рантайм — C# scan-and-replace.
- Python в старом дереве: ~5.6k строк кода + ~2.4k тестов.

## Что сделано

- Каталог `C:\Users\Domo\workspace\Third-Crisis-Neon-Nights-Mods`, `git init`, первый коммит.
- Перенесены данные без правок: `po/` (11 языков + `template.pot`), `fonts/`, C#-источники,
  `deploy.ps1`, `package_release.ps1`, скиллы `.opencode/`.
- Каркас TS: `package.json` (npm-скрипты), `tsconfig.json`, `.prettierrc`, `.editorconfig`,
  `.gitignore`, `.gitattributes`, CI (`.github/workflows/ci.yml`), `opencode.json`.
- `scripts/game_dir.mts` — поиск и проверка установки игры (env `TCNN_GAME_DIR` → Steam-библиотеки
  через `libraryfolders.vdf` → маркеры `*.exe` и `Managed/Assembly-CSharp.dll`).
- Порты с тестами:
  - `pipeline-common/scripts/text_filters.mts` (паритет с `text_filters.py`);
  - `extract-text/scripts/po_file.mts` (паритет с `po_file.py`);
  - `extract-text/scripts/po2dat.mts` (паритет с `po2dat.py`).
- 27 тестов `node --test`, `tsc --noEmit` и `oxlint` — зелёные.
- **Паритет `po2dat` доказан на реальных данных:** `po/ru.po` → 18 535 строк,
  1 739 174 байта; после нормализации `CRLF`→`LF` файл **идентичен** сборке Python.
  Исходное расхождение — только переводы строк (Python на Windows пишет `\r\n`); рантайм читает
  `File.ReadLines`, поэтому LF безопасен.

## Журнал решения

- 2026-11-21: `po2dat.py` пишет через `open(..., "w")` → на Windows это CRLF. Порт пишет LF.
  Проверено чтение в рантайме (`TranslationLoader.cs:97` — `File.ReadLines`), смена EOL безопасна.
- 2026-11-21: `json.dumps` в Python даёт `": "`/`", "`, `JSON.stringify` — компактно. Чтобы `.dat`
  оставался сравнимым с прежней сборкой, строки собираются явно (`toJsonLine`).
- 2026-11-21: `voice_*` не относится к этому репо — контекст только для истории.

## Вне рамок

- E2E и запуск игры.
- Порт `potgen`/`extractor`/`dump_assets` (отдельные задачи).
- Сборка DLL и деплой (нужны `csc.exe`, MSVC, игра — локально).

## Файлы (ожидаемые)

- `package.json`, `tsconfig.json`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.prettierrc`,
  `.prettierignore`, `opencode.json`, `.github/workflows/ci.yml`
- `scripts/game_dir.mts`
- `.opencode/skills/pipeline-common/scripts/text_filters.mts` (+ тест)
- `.opencode/skills/extract-text/scripts/po_file.mts`, `po2dat.mts` (+ тесты)
- `AGENTS.md`, `docs/migration.md`, `tasks/*`
