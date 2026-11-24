---
name: deploy-translator
description: Деплой NeonTranslatorRuntime в игру — сборка словаря из po/<lang>.po, раскладка DLL/шрифтов/patch_<lang>.dat/active_lang.txt в Managed/ и прокси dwmapi.dll в корень игры. Одна TS-точка входа (deploy.mts), путь к игре — scripts/game_dir.mts.
license: MIT
compatibility: opencode
---

# deploy-translator — деплой переводчика в игру

Ставит в установку игры четыре вещи: рантайм-DLL, шрифт(ы), словарь и
прокси-лоадер. Источник переводов — POT-хаб (`po/template.pot` + `po/<lang>.po`),
словарь собирается тем же `rust-l10n po2dat`, что и `npm run po2dat` (второй
реализации нет).

## Команды

Из корня репозитория; путь к игре — `TCNN_GAME_DIR` или автопоиск по
Steam-библиотекам (`scripts/game_dir.mts`).

```bash
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang ru           # деплой RU
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang ru --dry-run # только план
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang en           # native English, без словаря
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang de --rebuild # + пересборка C# DLL
node .opencode/skills/deploy-translator/scripts/deploy.mts --lang de --proxy   # + пересборка dwmapi.dll (MSVC)
node .opencode/skills/deploy-translator/scripts/deploy.mts --help
```

Флаги: `--lang <code>` (по умолчанию `ru`; список и порядок — из
`config/language-priority.json`), `--dry-run`, `--rebuild`, `--proxy`.
`--rebuild`/`--proxy` зовут функции скилла `build-translator` (не подпроцессы).

## Что делает деплой (и в каком порядке)

1. `--rebuild`: `runtime/NeonTranslatorRuntime.dll` (нужны `csc.exe` и игра).
2. `--proxy`: `<игра>/dwmapi.dll` + `<игра>/dwmapi_real.dll` + копия прокси в
   репозиторий (нужен MSVC).
3. `po/<lang>.po` → `runtime/patch_<lang>.dat` (`rust-l10n po2dat` подпроцессом;
   запись атомарная) → `Managed/patch_<lang>.dat`.
4. В `Managed/`: `NeonTranslatorRuntime.dll`, `RobotoCondensed-Regular.ttf`,
   `NotoSansSC.ttf`/`NotoSansJP.ttf` (если есть), `patch_<lang>.dat`,
   `active_lang.txt` (без перевода строки — рантайм читает как есть).
5. `dwmapi.dll` из репозитория → корень игры (рядом с exe: требование
   DLL-hijack). Если копии в репо нет, но прокси в игре уже стоит — не
   перезаписываем, печатаем предупреждение (`npm run build:proxy`).

`--lang en` — native-режим: словарь не собирается и не кладётся, в
`active_lang.txt` пишется `en`.

### Чего деплой НЕ делает

Не удаляет файлы из папки игры: `patch_en.dat` прошлого деплоя и legacy
`translations/` только перечисляются в предупреждениях. Старые словари других
языков (`patch_de.dat` и т.п.) остаются — рантайм читает ровно один по
`active_lang.txt`.

## Проверка после деплоя

```bash
M="<игра>/Third Crisis Neon Nights_Data/Managed"
cat "$M/active_lang.txt"                       # ожидаемый код языка
npm run po2dat -- ru                                    # независимая сборка (Rust)
sha256sum "$M/patch_ru.dat" runtime/patch_ru.dat           # хэши совпадают
```

`Managed/patch_ru.dat` обязан совпадать с `runtime/patch_ru.dat` байт-в-байт:
деплой пишет staging тем же `writeDat`, копия — атомарная.

Затем перезапустить игру и смотреть `Managed/NeonTranslator.log`.

## Файлы

- `scripts/deploy.mts` — вся логика: `planDeploy` (план, только чтение ФС),
  `executeDeploy` (исполнение), атомарные `writeAtomic`/`copyAtomic`, разбор CLI.
- `tests/deploy.test.mts` — `node --test` на фейковой установке в `tmp/`.
- `runtime/patch_<lang>.dat` — staging словаря (в git не попадает).
- `<игра>/dwmapi.dll` — лоадер; Steam «verify integrity» его удаляет → просто
  повторить деплой.
- `deploy.ps1` был легаси и удалён (2026-11-21, после порта на `.mts`).
