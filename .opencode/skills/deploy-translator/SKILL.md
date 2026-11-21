---
name: deploy-translator
description: Деплой NeonTranslatorRuntime — сборка DLL, прокси, копирование словаря в Managed/
license: MIT
compatibility: opencode
---

# deploy-translator — Деплой переводчика в игру

## Описание

Деплой рантайм-переводчика в игру. Включает:

1. Компиляцию C# → DLL (через `build-translator/scripts/build.py`)
2. Компиляцию нативного прокси dwmapi.dll (только при первом запуске или изменении C-кода)
3. Компиляцию `po/<lang>.po` → `runtime/patch_<lang>.dat` + копирование DLL,
   шрифта, словаря и `active_lang.txt` в `Managed/`

## Команды

Все команды — из корня репо (`NeonTranslator/`). Единственная точка входа — `deploy.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1              # RU
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Lang de     # любой язык из po/
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Lang en     # native English, без словаря
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Rebuild     # + пересборка C# DLL
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Rebuild -Proxy  # + пересборка dwmapi.dll (нужен MSVC)
```

Что делает `deploy.ps1`:

1. (опционально) `build.py` → `runtime/NeonTranslatorRuntime.dll`
2. (опционально) `build_proxy.py` → `dwmapi.dll` в корень игры + ресинк копии в репо
3. `po2dat.py <lang>` → `runtime/patch_<lang>.dat` (один JSON-lines словарь)
4. DLL + шрифт + `patch_<lang>.dat` + `active_lang.txt` → `Managed/`
5. Удаляет legacy-зеркало `<игра>/translations/` (YAML в игре больше нет)
6. `dwmapi.dll` → корень игры (рядом с exe — требование DLL-hijack)

### Проверка после деплоя

```bash
ls -la "Third Crisis Neon Nights_Data/Managed/NeonTranslatorRuntime.dll"
cat "Third Crisis Neon Nights_Data/Managed/NeonTranslator.log"
```

## Формат

Источник переводов — POT-хаб (`po/template.pot` + `po/<lang>.po`, ~33k записей).
Старое `translations/` YAML-дерево удалено (остался тег `archive/pre-neontranslator`).

## Файлы

- `deploy.ps1 [-Lang]` — единственная точка деплоя (см. Команды)
- `runtime/NeonTranslatorRuntime.dll` — скомпилированная DLL (build.py)
- `runtime/patch_<lang>.dat` — скомпилированный словарь (po2dat.py, не трекается)
- `Managed/NeonTranslatorRuntime.dll` — установленная DLL (деплой)
- `Managed/patch_<lang>.dat` — установленный словарь (деплой)
- `Managed/active_lang.txt` — выбранный язык (деплой)
- `translations/` — удалено (POT-хаб; правки только через PO)
- `po/template.pot` + `po/<lang>.po` — источник переводов (трекается)
- `Managed/NeonTranslator.log` — лог рантайма
- `dwmapi.dll` (в репо) — собранный прокси (трекается)
- `<игра>/dwmapi.dll` — установленный лоадер (деплой, рядом с exe)
- `<игра>/dwmapi_real.dll` — форвардер (копия системной dwmapi.dll)

## После деплоя

- Перезапустить игру
- Проверить лог: `NeonTranslator.log`
- Лог создаётся в `Third Crisis Neon Nights_Data/Managed/`

## Очистка старых NDJSON

Рантайм больше не читает `*.ndjson`. Удали старые файлы из `Managed/`:

```bash
rm "Third Crisis Neon Nights_Data/Managed/"*.ndjson
```
