---
description: Деплой мода в игру — сборка DLL/прокси, раскладка «одна папка» NeonTranslatorDX (--lang, --uninstall, --migrate)
agent: build
---

Всё на TypeScript. Игра находится по `TCNN_GAME_DIR` или автопоиску по Steam-библиотекам
(`scripts/game_dir.mts`), хардкода путей нет.

```bash
npm run build            # NeonTranslatorDX.dll (нужен csc.exe от .NET Framework)
npm run build:proxy      # dwmapi.dll (нужен MSVC Build Tools)
npm run deploy -- --dry-run --lang ru   # план без записи
npm run deploy -- --lang ru             # папка mods/NeonTranslatorDX/ + лоадер + манифест
npm run deploy -- --lang en             # native-режим: словаря нет
npm run deploy -- --uninstall           # удалить ровно поставленное
npm run deploy -- --lang ru --migrate   # + чистка прежней раскладки (Managed/)
```

Что делает деплой:

- собирает `po/<lang>.po` → `patch_<lang>.dat` через `rust-l10n po2dat` (одна реализация, не копия);
- кладёт в `<игра>/mods/NeonTranslatorDX/`: DLL рантайма, шрифты в `fonts/` (кириллица + CJK),
  словарь (кроме `en`), `active_lang.txt` и `install-manifest.json` (файл, размер, sha256);
- прокси `dwmapi.dll` — в корень игры: единственный файл вне папки мода.

Особенности, проверенные на живой установке:

- `active_lang.txt` — ровно код языка, **без перевода строки**;
- `.dat`, установленный деплоем, байт-в-байт равен `npm run po2dat -- <lang>`;
- `--dry-run` печатает план и ничего не пишет;
- `--uninstall` удаляет только файлы из манифеста (с проверкой sha256) и пустые
  папки; чужие файлы не трогает;
- `--migrate` убирает `Managed/`-артефакты и старую папку `NeonTranslator/`
  по списку, с логом каждого удаления (без флага ничего не трогается);
- при неверном `--lang` печатается список доступных языков (источник — приоритет языков).

Инсталлятор для конечного пользователя — `npm run mod:install` (тонкая обёртка над тем же
`deploy.mts`).
