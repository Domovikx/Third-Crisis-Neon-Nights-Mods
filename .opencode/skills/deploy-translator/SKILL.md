---
name: deploy-translator
description: Установка/удаление NeonTranslatorDX в игру — раскладка «одна папка» (<игра>/dwmapi.dll + <игра>/NeonTranslatorDX/), словарь из po/<lang>.po, манифест установки, --uninstall, --migrate со старой раскладки. Одна TS-точка входа (deploy.mts), путь к игре — scripts/game_dir.mts.
license: MIT
compatibility: opencode
---

# deploy-translator — установка и удаление NeonTranslatorDX

Вся нагрузка мода живёт в одной папке `<игра>/NeonTranslatorDX/`; вне её —
только лоадер `dwmapi.dll` (DLL-hijack, иначе рантайм не загрузится). Источник
переводов — POT-хаб (`po/template.pot` + `po/<lang>.po`), словарь собирается
тем же `rust-l10n po2dat`, что и `npm run po2dat` (второй реализации нет).

```text
<игра>/
  dwmapi.dll                    # единственный файл вне папки
  NeonTranslatorDX/
    NeonTranslatorDX.dll
    fonts/{RobotoCondensed-Regular,NotoSansSC,NotoSansJP}.ttf
    patch_<lang>.dat
    active_lang.txt
    install-manifest.json       # файл, размер, sha256 каждого поставленного файла
    dwmapi_real.dll             # цель форвардов прокси (если собрана)
```

## Команды

Из корня репозитория; путь к игре — `TCNN_GAME_DIR` или автопоиск по
Steam-библиотекам (`scripts/game_dir.mts`).

```bash
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang ru           # деплой RU
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang ru --dry-run # только план
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang en           # native English, без словаря
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang de --rebuild # + пересборка C# DLL
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang de --proxy   # + пересборка dwmapi.dll (MSVC)
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang ru --migrate # + чистка прежней раскладки
node .opencode/skills/deploy-translator/scripts/deploy.mts --uninstall         # удалить ровно поставленное
node .opencode/skills/deploy-translator/scripts/deploy.mts --uninstall --dry-run
node .opencode/skills/deploy-translator/scripts/deploy.mts --help
```

`--rebuild`/`--proxy` зовут функции скилла `build-translator` (не подпроцессы).

## Что делает деплой (и в каком порядке)

1. `--rebuild`: `runtime/NeonTranslatorDX.dll` (нужны `csc.exe` и игра).
2. `--proxy`: `<игра>/dwmapi.dll` + `<игра>/NeonTranslatorDX/dwmapi_real.dll`
   (+ копии в репозиторий; нужен MSVC).
3. `po/<lang>.po` → `runtime/patch_<lang>.dat` (`rust-l10n po2dat` подпроцессом;
   запись атомарная) → `NeonTranslatorDX/patch_<lang>.dat`.
4. В `NeonTranslatorDX/`: `NeonTranslatorDX.dll`, `fonts/*.ttf`,
   `patch_<lang>.dat`, `active_lang.txt` (без перевода строки),
   необязательный `dwmapi_real.dll`.
5. `dwmapi.dll` из репозитория → корень игры.
6. `install-manifest.json` — ПОСЛЕ копирования: размер и sha256 каждого файла
   (пути от корня игры). Без манифеста `--uninstall` отказывается что-либо
   удалять.

`--lang en` — native-режим: словарь не собирается и не кладётся, в
`active_lang.txt` пишется `en`.

## Удаление (`--uninstall`)

- читает манифест; удаляет только перечисленные файлы, причём лишь если sha256
  на диске совпал (изменённый вручную файл остаётся с предупреждением);
- дополнительно удаляет собственные артефакты рантайма в папке мода
  (`NeonTranslatorDX.log`, `dump_GUIDictionary.json`, `nolog.txt`);
- удаляет манифест и опустевшие папки (`NeonTranslatorDX/fonts`,
  `NeonTranslatorDX`) — непустые не трогает; никакого рекурсивного удаления;
- чужие файлы в `Managed/` и в папке мода не затрагиваются.

## Переезд со старой раскладки (`--migrate`)

По умолчанию старые артефакты не трогаются (только предупреждение в плане).
С флагом деплой сначала ставит новую раскладку, затем удаляет по списку:

- `Managed/`: `NeonTranslatorRuntime.dll`, `patch_*.dat`, `active_lang.txt`,
  `NeonTranslator.log`, `dump_GUIDictionary.json`, шрифты;
- старую папку `<игра>/NeonTranslator/` — только известные имена и `patch_*.dat`
  из неё; папка удаляется, если опустела (чужой файл её сохранит);
- мусор сборки в корне: `dwmapi.exp`, `dwmapi.lib`, `dwmapi_real.dll`, `nul`.

Каждое удаление печатается строкой `- legacy: <путь>`.

## Проверка после деплоя

```bash
G="<игра>"; M="$G/NeonTranslatorDX"
cat "$M/active_lang.txt"                          # ожидаемый код языка
sha256sum "$M/patch_ru.dat" runtime/patch_ru.dat  # хэши совпадают
cat "$M/install-manifest.json"                    # список поставленного
```

Затем перезапустить игру и смотреть `NeonTranslatorDX/NeonTranslatorDX.log`
(`Lang: ru`, `Translations: N`).

## Файлы

- `scripts/deploy.mts` — вся логика: `planDeploy`/`executeDeploy`,
  `planUninstall`/`executeUninstall`, `planMigrate`/`executeMigrate`,
  атомарные `writeAtomic`/`copyAtomic`, разбор CLI.
- `tests/deploy.test.mts` — 20 тестов на фейковой установке в `tmp/`
  (раскладка, манифест, uninstall, migrate, паритет `.dat`).
- `runtime/NeonTranslatorDX.dll`, `runtime/patch_<lang>.dat` — артефакты сборки
  (в git не попадают).
- `<игра>/dwmapi.dll` — лоадер; Steam «verify integrity» его удаляет → просто
  повторить деплой.
- `deploy.ps1` был легаси и удалён (2026-11-21, после порта на `.mts`).
