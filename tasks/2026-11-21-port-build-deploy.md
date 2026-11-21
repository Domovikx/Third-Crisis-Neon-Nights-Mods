# [2026-11-21] Портировать сборку и деплой: `build`, `build_proxy`, `deploy.ps1`

Статус: DONE (порт и проверка на живой установке; удаление `.py`/`.ps1` — за владельцем)

## Задача от пользователя

Часть общей задачи: «максимально запускаем миграцию на ts mts вместо питона».

## Цель

Сборка рантайма (C# → DLL, C → `dwmapi.dll`) и деплой в игру запускаются одной TS-командой,
без PowerShell-обвязки и без хардкода пути к игре.

## Что сделано

Новые файлы:

- `.opencode/skills/build-translator/scripts/build.mts` — `csc.exe`; экспортирует
  `buildRuntime`, `resolveGame`, `buildArgs`, `collectRefs`, `chooseCsc`, `cscCandidates`,
  `missingSources` (чистые функции отделены от запуска компилятора).
- `.opencode/skills/build-translator/scripts/build_proxy.mts` — `cl.exe`; автопоиск
  MSVC через `vswhere.exe` + фолбэк по каталогам VS, выбор самой новой версии MSVC и
  Windows SDK (только версии с `Lib`), оверрайды `TCNN_MSVC_TOOLS`/`TCNN_WINDOWS_SDK`/
  `TCNN_SDK_VERSION`; obj/lib/exp — в `tmp/build_proxy/`.
- `.opencode/skills/build-translator/tests/build.test.mts` — 14 тестов.
- `.opencode/skills/deploy-translator/scripts/deploy.mts` — `planDeploy` (только чтение ФС),
  `executeDeploy` (атомарные `.part` → rename), `parseArgs`; словарь — `buildDat`/`writeDat`
  из `po2dat.mts` (импорт, не подпроцесс).
- `.opencode/skills/deploy-translator/tests/deploy.test.mts` — 13 тестов.
- `.opencode/skills/deploy-translator/MAP.md` — новый.

Обновлены: `build-translator/SKILL.md`, `build-translator/MAP.md`, `deploy-translator/SKILL.md`.

Путь к игре — только `scripts/game_dir.mts` (`findGameDir`/`checkGameDir`), env
`TCNN_GAME_DIR`. Явный, но несуществующий `TCNN_GAME_DIR` — ошибка, а не тихий откат
на Steam-копию.

## Приёмка (фактические прогоны 2026-11-21)

- [x] `node .../build.mts` → `runtime/NeonTranslatorRuntime.dll` 44 032 байта
      (6 исходников, 11/11 ссылок Unity, `csc.exe` Framework64), код 0
- [x] `node .../build_proxy.mts` → `dwmapi.dll` 13 824 байта в игре и копия в репо,
      `dwmapi_real.dll` 190.5 KB, MSVC 14.50.35717 + SDK 10.0.26100.0, код 0
- [x] `node .../deploy.mts --lang ru --dry-run` — план из 7 операций, ничего не записано
- [x] `node .../deploy.mts --lang ru` — в `Managed/` DLL, 3 шрифта, `patch_ru.dat`
      (18 535 строк), `active_lang.txt` = `ru`; прокси в корне игры
- [x] `.dat` байт-в-байт = `npm run po2dat -- ru`: sha256 `81f74e56…` у
      `Managed/patch_ru.dat`, `runtime/patch_ru.dat` и независимой сборки
- [x] `node .../deploy.mts --lang en` — native-режим: словаря нет, `active_lang.txt` = `en`
      (2 байта, без `\n`)
- [x] `TCNN_GAME_DIR` на несуществующий путь — ошибка «TCNN_GAME_DIR указывает на несуществующую папку», код 1 (то же у `build.mts`)
- [x] `npm run typecheck`, `npm run lint` — чисто
- [x] `node --test` по новым тестам — 27/27
- [ ] `.py`/`.ps1` удалены — **не делал**: удаление старых файлов за владельцем
      (`build.py`, `build_proxy.py`, `deploy.ps1` остались как референс)

## Что перезаписано в живой установке (Steam, `Program Files (x86)`)

До деплоя: `active_lang.txt` = `pt`; `Managed/patch_ru.dat` от 2026-09-29
(1 757 709 б); `dwmapi.dll` 13 824 б; `dwmapi_real.dll` от января 2026 (`c322e8…`).

- `Managed/NeonTranslatorRuntime.dll` — 44 032 б (пересобран; старый был того же размера)
- `Managed/patch_ru.dat` — 1 739 174 б, sha256 `81f74e56…` (старый `e0d29a77…`)
- `Managed/active_lang.txt` — `ru`, затем `en` (оставлено `en` — native, как «исходное»
  состояние игры после экспериментов)
- `Managed/RobotoCondensed-Regular.ttf`, `NotoSansSC.ttf`, `NotoSansJP.ttf` — те же файлы
  из репозитория
- `<игра>/dwmapi.dll` — пересобран (13 824 б, sha256 `54fbdee8…`)
- `<игра>/dwmapi_real.dll` — заменён текущей системной копией (`db0ad9…`,
  было `c322e8…`): так и задумано, форвардер = живая системная DLL

Ничего не удалялось. Словари других языков (`patch_de.dat` и т.п.) не тронуты.

## npm-скрипты (добавить владельцу — `package.json` вне зоны задачи)

```json
"build": "node .opencode/skills/build-translator/scripts/build.mts",
"build:proxy": "node .opencode/skills/build-translator/scripts/build_proxy.mts",
"deploy": "node .opencode/skills/deploy-translator/scripts/deploy.mts",
```

Тесты в `test` (строка в `npm test`, туда же):

```text
.opencode/skills/build-translator/tests/build.test.mts
.opencode/skills/deploy-translator/tests/deploy.test.mts
```

## Блокеры

Нет: `csc.exe` (Framework64 v4.0.30319) и `cl.exe` (VS BuildTools 18, MSVC 14.50.35717)
найдены, запись в установку игры разрешена.

## Найденные гочи (записаны в MAP обоих скиллов)

- `spawnSync(cl, args)`, где `args[0]` — сам `cl.exe` (как в Python-списке), даёт
  `LNK1107` + `D9024`: компилятор получает свой путь как исходник.
- `cl` пишет в OEM-кодировке (cp866) — вывод надо декодировать `TextDecoder("ibm866")`,
  иначе ошибки нечитаемы.
- Версия Windows SDK без каталога `Lib` ломает линковку — выбирать только версии с `Lib`.
- `dwmapi.dll` в корне репо **не трекается** (`git ls-files` пуст): деплой не падает,
  если прокси уже в игре, но для обновления прокси нужен `build:proxy`.
- `active_lang.txt` — ровно код языка без `\n` (2 байта), как в `deploy.ps1`.

## Осталось (вне зоны этого порта)

- Удалить легаси `build.py`, `build_proxy.py`, `deploy.ps1` (решение владельца) и
  обновить ссылки на них: `.opencode/commands/deploy.md`, `docs/migration.md`,
  `docs/review-2026-11-21.md`, `package_release.ps1`.
- `installer/install.mts` дублирует план раскладки (`planInstall`) и до сих пор пишет
  «появится с портом deploy.ps1» — по контракту должен стать обёрткой над `deploy.mts`.
- Решить, добавлять ли untracked `dwmapi.dll` в `.gitignore` (или трекать как раньше).
- `docs/progress.md` — запись о порте.

## Связи

- Зависит от `scripts/game_dir.mts` (готово) и `po2dat.mts` (готово).
- Требует локально: .NET Framework (`csc.exe`), MSVC Build Tools, установленная игра.
