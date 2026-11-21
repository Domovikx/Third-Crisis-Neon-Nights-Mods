---
description: Деплой мода в игру — сборка DLL/прокси и раскладка в Managed (--lang, --apply)
agent: build
---

Всё на TypeScript. Игра находится по `TCNN_GAME_DIR` или автопоиску по Steam-библиотекам
(`scripts/game_dir.mts`), хардкода путей нет.

```bash
npm run build            # NeonTranslatorRuntime.dll (нужен csc.exe от .NET Framework)
npm run build:proxy      # dwmapi.dll (нужен MSVC Build Tools)
npm run deploy -- --dry-run --lang ru   # план без записи
npm run deploy -- --lang ru             # словарь + DLL + шрифты + active_lang.txt
npm run deploy -- --lang en             # native-режим: словаря нет
```

Что делает деплой:

- собирает `po/<lang>.po` → `patch_<lang>.dat` через `po2dat.mts` (одна реализация, не копия);
- кладёт в `<игра>/<Game>_Data/Managed/`: DLL рантайма, шрифты (кириллица + CJK),
  словарь (кроме `en`), `active_lang.txt` с кодом языка;
- прокси `dwmapi.dll` — в корень игры (если он там нужен и собран).

Особенности, проверенные на живой установке:

- `active_lang.txt` — ровно код языка, **без перевода строки**;
- `.dat`, установленный деплоем, байт-в-байт равен `npm run po2dat -- <lang>`;
- `--dry-run` печатает план и ничего не пишет;
- при неверном `--lang` печатается список доступных языков (источник — приоритет языков).

Инсталлятор для конечного пользователя — `npm run mod:install` (тонкая обёртка над тем же
`deploy.mts`).
