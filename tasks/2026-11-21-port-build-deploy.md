# [2026-11-21] Портировать сборку и деплой: `build`, `build_proxy`, `deploy.ps1`

Статус: READY

## Задача от пользователя

Часть общей задачи: «максимально запускаем миграцию на ts mts вместо питона».

## Цель

Сборка рантайма (C# → DLL, C → `dwmapi.dll`) и деплой в игру запускаются одной TS-командой,
без PowerShell-обвязки и без хардкода пути к игре.

## Контекст

- `build.py` (76) — обёртка над `csc.exe`: собирает `NeonTranslatorRuntime.dll` из C#-исходников
  с ссылками на `Managed/*.dll` игры.
- `build_proxy.py` (94) — обёртка над `cl.exe` (MSVC) для `dwmapi.dll`.
- `deploy.ps1` — компилирует `po/<lang>.po` → `patch_<lang>.dat`, копирует DLL, шрифт, словарь и
  `active_lang.txt` в `Managed/`, умеет `-Lang`, `-Rebuild`, `-Proxy`.
- Путь к игре больше не «рядом с репозиторием»: `scripts/game_dir.mts` (env `TCNN_GAME_DIR` →
  Steam-библиотеки). Хардкод путей запрещён.

## Что сделать

1. Прочитать `build.py`, `build_proxy.py`, `deploy.ps1` и их тесты (`build.test.py`).
2. Вопросы ресёрча:
   - чем заменить `csc.exe`/`cl.exe` в TS-обёртке (прямой `spawn` с аргументами — достаточно?);
   - как воспроизвести поведение `-Rebuild`/`-Proxy` без PowerShell;
   - нужен ли `package_release.ps1` (архивация релиза) в TS или оставить как есть на этом шаге.
3. Реализовать `build.mts`, `build_proxy.mts`, `deploy.mts`; путь к игре — только через
   `scripts/game_dir.mts`.
4. Проверить локально: собрать DLL, собрать прокси, задеплоить `ru` и `en` (игра установлена).
5. Паритет: `deploy` даёт в `Managed/` те же файлы, что PowerShell-версия (содержимое `.dat`
   совпадает байт-в-байт с `po2dat`).
6. Удалить `.py`/`.ps1` из нового дерева, обновить `SKILL.md` скиллов `build-translator` и
   `deploy-translator`.

## Приёмка

- [ ] `node .../build.mts` собирает `runtime/NeonTranslatorRuntime.dll` (файл появляется, размер > 0)
- [ ] `node .../build_proxy.mts` собирает `dwmapi.dll`
- [ ] `node .../deploy.mts --lang ru` кладёт в `Managed/` DLL, `patch_ru.dat`, шрифт, `active_lang.txt`
- [ ] `node .../deploy.mts --lang en` даёт native-режим (без словаря)
- [ ] `.dat`, положенный деплоем, байт-в-байт равен собранному `po2dat.mts`
- [ ] Нет хардкода пути к игре: при `TCNN_GAME_DIR` на несуществующий путь — понятная ошибка
- [ ] `npm run typecheck`, `npm run lint`, `npm test` зелёные
- [ ] `.py`/`.ps1` удалены (или оставлены с причиной), доки обновлены

## Вне рамок

- Запуск игры и E2E-проверка перевода в игре.
- Установщик/архиватор релиза для GitHub Releases (отдельно, если понадобится).
- Изменение C#-кода рантайма.

## Файлы (ожидаемые)

- `.opencode/skills/build-translator/scripts/{build,build_proxy}.mts`
- `.opencode/skills/deploy-translator/scripts/deploy.mts`
- `package.json` (скрипты `build`, `deploy`), `SKILL.md`, `docs/migration.md`

## Связи

- Зависит от `scripts/game_dir.mts` (готово) и `po2dat.mts` (готово).
- Требует локально: .NET Framework SDK (`csc.exe`), MSVC Build Tools, установленная игра.
