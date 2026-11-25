# MAP — deploy-translator (факты и грабли)

Установка NeonTranslatorDX в игру. Порт `deploy.ps1` на `.mts` — 2026-11-21;
раскладка «одна папка» + бренд NeonTranslatorDX — 2026-11-25;
конвенция TSSR `<игра>/mods/NeonTranslatorDX/` — 2026-11-25, проверено прогоном
на живой установке: migrate со старой корневой папки → игра → uninstall → diff
с чистым снимком = 0/0/0.

## Готчи

- ⚠️ **`Namespace` рантайма переименован в `NeonTranslatorDX`** вместе с файлом
  `NeonTranslatorDX.dll` → прокси ищет класс по строке
  `mono_class_from_name(image, "NeonTranslatorDX", "TranslatorPlugin")`; если
  namespace откатить, а DLL/путь оставить — `FAIL: mono_class_from_name` в
  `C:\temp\dwmapi_proxy.log` и пустой `NeonTranslatorDX.log` → проверено
  2026-11-25 (русское меню, `Font: preload ... = False` — отдельный баг TMP).

- ⚠️ **Рантайм разрешает ассеты от `Assembly.Location`**: `dllDir` = папка мода
  (`<игра>/mods/NeonTranslatorDX`), шрифты — в `dllDir/fonts`, остальное рядом с
  DLL. `gameDir` только для legacy-YAML `translations/` — это ДВА уровня вверх
  (`<game>/mods/NeonTranslatorDX` → `<game>`); в раскладке без `mods/` было
  достаточно одного → не упрощать обратно.

- ⚠️ **Деплой и прокси знают путь `<игра>/mods/NeonTranslatorDX/`** (прокси строит
  от каталога exe, не от cwd). Смена конвенции = одновременно
  `deploy.mts` (`MODS_FOLDER`/`MOD_FOLDER`), `dwmapi_proxy.c` (две строки) и
  `build_proxy.mts` (`MODS_FOLDER`), иначе прокси молча ищет старую папку.

- ⚠️ **`install-manifest.json` пишется последним**, после всех копий: в нём
  размер и sha256 каждого файла. Uninstall удаляет файл только при совпадении
  хэша; иначе оставляет и предупреждает (защита от ручных правок).

- ⚠️ **Артефакты рантайма не в манифесте** (`NeonTranslatorDX.log`,
  `dump_GUIDictionary.json`, `nolog.txt`) → uninstall удаляет их отдельным
  списком `RUNTIME_ARTIFACTS`, иначе папка не опустеет и не удалится → проверено
  2026-11-25: после uninstall diff с чистым снимком `0/0/0`.

- ⚠️ **`active_lang.txt` пишется БЕЗ перевода строки** → файл ровно 2 байта
  `ru`, так его читает рантайм → не «улучшать» до `lang + "\n"`.

- ⚠️ **Копия прокси в репозитории может отсутствовать** (`dwmapi.dll`,
  `dwmapi_real.dll` в `.gitignore`) → её создаёт только `build:proxy`; деплой не
  падает, если прокси уже лежит в игре, и печатает «пересобрать:
  npm run build:proxy». Порядок «build:proxy → deploy» обязателен для обновления
  самого прокси и `dwmapi_real.dll`.

- ⚠️ **`cl.exe` для DLL кладёт `.exp/.lib` рядом с `/Fe`, если не задан
  `/IMPLIB`** → раньше в корне игры появлялись `dwmapi.exp`/`dwmapi.lib` →
  `build_proxy.mts` передаёт `/IMPLIB:tmp/build_proxy/dwmapi.lib`; старые
  артефакты убирает `--migrate` (проверено 2026-11-25: повторная сборка пишет
  `.exp/.lib` только в `tmp/build_proxy`).

- ⚠️ **Steam «verify integrity» удаляет `dwmapi.dll`** → деплой просто
  повторяют; проверять наличие `dwmapi.dll` рядом с exe, а не в папке мода.

- ⚠️ **`--migrate` не рекурсивный и сначала ПЕРЕНОСИТ, потом удаляет**:
  `planMigrateCopies` копирует из `Managed/` и старых корневых
  `NeonTranslatorDX/`, `NeonTranslator/` недостающие `patch_*.dat`, шрифты,
  `typography.json`, `dwmapi_real.dll`; только затем известные имена удаляются.
  Старые папки исчезают лишь если опустели (чужой файл сохранит) → проверено
  2026-11-25 переносом 9 словарей из корневой папки без потерь.

- ⚠️ **Uninstall удаляет `mods/` только если она опустела** → если в `mods/` есть
  другие моды, папка остаётся; `rmdir` не рекурсивный. `patch_*.dat` всех языков
  удаляются по маске (после смены языка манифест знает только последний).

## Проверенные цифры (2026-11-25, финальная раскладка mods/)

- деплой RU: 16 файлов в манифесте (`dwmapi.dll` + `NeonTranslatorDX.dll`
  87 040 б, `dwmapi_real.dll` 195 032 б, 11 файлов `fonts/` включая
  `typography.json` и кандидаты шрифтов, `patch_ru.dat` 2 098 653 б,
  `active_lang.txt`); после `--migrate` и деплоя 10 языков в папке 25 файлов
  (+ лоадер в корне = 26 добавленных к чистому снимку);
- `patch_ru.dat`: 14 330 строк; `Translations: 14 006` в логе игры;
- E2E: игра стартует, лог в `mods/NeonTranslatorDX/NeonTranslatorDX.log`, меню
  русское (Продолжить / Новая игра / Загрузить файл сохранения / НАСТРОЙКИ /
  Выход), индикатор `RU`; скриншоты `tmp/shots/mods-menu-final2.png`;
- `Font: preload chain ru = True: needed 72 ... covered 72, unrenderable 0`
  (старый баг атласа 1024×1024 закрыт новым контуром шрифтов);
- `clean_room`: `game-clean → installed` = добавлено 26, изменено 0, удалено 0;
  `game-clean → uninstalled` = 0/0/0 (удалены `dwmapi.dll`, папка мода и
  опустевшая `mods/`);
- `TCNN_GAME_DIR=C:\no\such\game` → понятная ошибка, код 1 (без тихого отката
  на Steam).

- ❌ **App ID перепутан между проектами.** Проверено 2026-11-25: `2166470` — это
  The Survival of Sarah Rose (TSSR), у Third Crisis: Neon Nights — **`3400350`**.
  Симптом: установщик ищет игру по acf и не находит. Что делать: искать по маркерам
  файлов игры, App ID использовать только как подсказку (`appmanifest_3400350.acf`).
