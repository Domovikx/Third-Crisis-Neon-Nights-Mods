# MAP — deploy-translator (факты и грабли)

Установка NeonTranslatorDX в игру. Порт `deploy.ps1` на `.mts` — 2026-11-21;
раскладка «одна папка» + бренд NeonTranslatorDX — 2026-11-25, проверено прогоном
на живой установке (RU): install → игра → uninstall → diff с чистым снимком = 0.

## Готчи

- ⚠️ **`Namespace` рантайма переименован в `NeonTranslatorDX`** вместе с файлом
  `NeonTranslatorDX.dll` → прокси ищет класс по строке
  `mono_class_from_name(image, "NeonTranslatorDX", "TranslatorPlugin")`; если
  namespace откатить, а DLL/путь оставить — `FAIL: mono_class_from_name` в
  `C:\temp\dwmapi_proxy.log` и пустой `NeonTranslatorDX.log` → проверено
  2026-11-25 (русское меню, `Font: preload ... = False` — отдельный баг TMP).

- ⚠️ **Рантайм разрешает ассеты от `Assembly.Location`**, поэтому переезд не
  требует правок в `TranslationLoader`: `dllDir` = папка мода, шрифты — в
  `dllDir/fonts`, `patch_*.dat`/`active_lang.txt` — рядом с DLL. `gameDir` для
  legacy-YAML = `Path.GetDirectoryName(dllDir)` (в Managed-раскладке было два
  уровня) → не возвращать двойной `GetDirectoryName`.

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

- ⚠️ **`--migrate` не рекурсивный**: удаляет известные имена и `patch_*.dat`
  в `Managed/` и в старой папке `NeonTranslator/`; старая папка исчезает только
  если опустела. Чужой файл внутри → папка остаётся (проверено тестом).

## Проверенные цифры (2026-11-25, RU)

- установка: 9 файлов = `dwmapi.dll` + 8 в `NeonTranslatorDX/` (DLL 44 032 б,
  `dwmapi_real.dll` 195 032 б, 3 шрифта, `patch_ru.dat` 2 098 692 б,
  `active_lang.txt`, `install-manifest.json`);
- `patch_ru.dat`: 14 330 строк; `Translations: 14 007` в логе игры;
- E2E: игра стартует, лог в `NeonTranslatorDX/NeonTranslatorDX.log`, меню
  русское (Продолжить / Новая игра / Загрузить файл сохранения / НАСТРОЙКИ /
  Выход);
- `clean_room`: `game-clean → installed` = добавлено 9, изменено 0, удалено 0;
  `game-clean → uninstalled` = 0/0/0;
- `--lang en`: 8 файлов, словаря нет, `active_lang.txt` = `en`, 2 байта.
- `TCNN_GAME_DIR=C:\no\such\game` → понятная ошибка, код 1 (без тихого отката
  на Steam).

## Открытый баг (не блокирует приёмку)

`Font: preload Roboto-Condensed_DialogueUI (83) = False chars 236->236 atlas
1024x1024` — `TryAddCharacters` не добавляет кириллицу в статический атлас
1024×1024. Меню при этом рендерится по-русски (динамические глифы TMP), но
предзагрузка не работает; отдельная задача — увеличить/сделать динамическим
атлас или пересоздавать `TMP_FontAsset` из `RobotoCondensed-Regular.ttf`.
