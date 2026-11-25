# Инсталлятор (заготовка)

`install.mts` — будущая точка входа для игрока. Сейчас умеет главное, что не зависит
от порта деплоя: **найти игру, проверить комплектность, показать точный план раскладки**.

```bash
node installer/install.mts                    # план для ru (dry-run)
node installer/install.mts --lang de          # другой язык
node installer/install.mts --game "D:/Games/Third Crisis Neon Nights"
node installer/install.mts --lang en          # native-режим (без словаря)
```

## Что делает сейчас

- Ищет установку игры: `TCNN_GAME_DIR` → Steam-библиотеки → проверка маркеров
  (`*.exe`, `Managed/Assembly-CSharp.dll`).
- Сверяет язык с `config/language-priority.json` (нельзя поставить язык вне приоритета).
- Строит план: что откуда куда копируется, чего не хватает.
- Возвращает код 1, если не хватает обязательных артефактов (DLL, шрифт, словарь).

## Чего ещё нет

- Копирования файлов — **намеренно**: реализация живёт в `deploy.mts`
  (задача `tasks/2026-11-21-port-build-deploy.md`), а инсталлятор — тонкая
  обёртка над ним. Двух реализаций копирования быть не должно.
- GUI — отдельное приложение `installer-ui/` (Tauri 2: React 19 + StyleX,
  Rust-команды `detect/install/uninstall/verify`, ручной `.7z` с тем же
  манифестом). Сборка, payload и подпись — `installer-ui/README.md`.

## Мод-менеджер (следующий шаг)

Отдельная задача, когда появится деплой:

- список установленных языков (по `Managed/patch_*.dat`) и их переключение;
- проверка целостности (файлы на месте, версия совпадает с релизом);
- удаление мода (вернуть `Managed/` в исходное состояние);
- обновление: скачать новый релиз, заменить DLL и словари, не трогая настройки.

## Раскладка установки (контракт)

- `dwmapi.dll` (прокси/лоадер) → корень игры — единственный файл вне папки мода
- `runtime/NeonTranslatorDX.dll` → `<игра>/mods/NeonTranslatorDX/`
- `runtime/patch_<lang>.dat` → `<игра>/mods/NeonTranslatorDX/` (кроме `en`)
- `fonts/*.ttf` + `fonts/typography.json` → `<игра>/mods/NeonTranslatorDX/fonts/`
- `mods/NeonTranslatorDX/active_lang.txt` → генерируется (код языка)
- `mods/NeonTranslatorDX/install-manifest.json` → генерируется (файл, размер, sha256)
