# MAP — build-translator (факты и грабли)

Сборка C#-рантайма (csc) и нативного прокси (cl). Порт на `.mts` — 2026-11-21;
проверено на живой установке (Steam, `Program Files (x86)`), Windows 11,
RTX-машина разработчика.

## Готчи

- ⚠️ **`cl` получал свой же путь как исходник** → симптом: `LNK1107: недопустимый
или повреждённый файл … cl.exe` + `warning D9024: используется тип исходного
файла cl.exe`, код 2. Причина: `proxyArgs` кладёт `layout.cl` в `args[0]`
  (как список Python), а `spawnSync` ещё раз получал его первым аргументом —
  компилятор видел второй «cl.exe» среди входных файлов → проверено
  2026-11-21 (первый прогон упал именно так) → вызывать
  `spawnSync(args[0], args.slice(1))`, не `spawnSync(cl, args)`.

- ⚠️ **Ошибки `cl` были нечитаемы (кракозябры)** → cl пишет в OEM-кодировке
  консоли (cp866), `encoding: "utf8"` превращал текст в мусор → проверено
  2026-11-21 → читать вывод буфером и декодировать `new TextDecoder("ibm866")`
  (`decodeOem` в `build_proxy.mts`).

- ⚠️ **Хардкод MSVC из `build_proxy.py` (`…/18/BuildTools/…/14.50.35717`) не
  нужен** → версия 14.50.35717 находится через
  `vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64`;
  фолбэк — перебор `C:\Program Files[(x86)]\Microsoft Visual Studio\*\*\VC\Tools\MSVC` →
  проверено 2026-11-21 (vswhere вернул `…\18\BuildTools`).

- ⚠️ **Версия Windows SDK без каталога `Lib` ломает линковку** → в
  `C:\Program Files (x86)\Windows Kits\10\Include` могут лежать версии, у
  которых нет `Lib/<версия>` → проверено чтением каталога → выбирается только
  версия, где есть и `Include`, и `Lib` (`Lib/ucrt/x64`, `Lib/um/x64`).

- ⚠️ **`cl` пишет `.obj/.lib/.exp` в текущий каталог** → при `cwd = корень репозитория`
  мусор оказывался рядом с исходниками (в старом Python-скрипте) → проверено
  2026-11-21 → запуск с `cwd = tmp/build_proxy/`, туда же `/Fo`.

- ⚠️ **`build_proxy.mts` перезаписывает `<игра>/NeonTranslatorDX/dwmapi_real.dll`
  текущей системной копией** → это by design (форвардер должен быть живой системной DLL), но при
  отладке старое содержимое теряется → проверено 2026-11-21: до прогона
  `dwmapi_real.dll` был от января 2026 (`c322e8…`), после — `db0ad9…` (=
  `C:\Windows\System32\dwmapi.dll`).

- ⚠️ **В репозитории нет `dwmapi.dll`** (`git ls-files` его не знает; в старом
  дереве он лежал в корне и «трекался») → `build:proxy` создаёт его как
  untracked-файл, `deploy` берёт копию оттуда → проверено 2026-11-21 →
  порядок «сначала `npm run build:proxy`, потом деплой»; если прокси в игре уже
  стоит, `deploy` не падает, а предупреждает (см. MAP deploy-translator).
  Добавлять ли `dwmapi.dll` в `.gitignore` — решение владельца.

- ⚠️ **Сборка рантайма требует установленную игру** → `csc` берёт
  `UnityEngine*.dll`/`netstandard.dll` из `Managed/`; без них «мало сборок
  Unity» → проверено чтением `REF_DLLS` → в CI (ubuntu) сборку не гоняем, там
  только `npm run typecheck` и тесты чистых функций.

- ⚠️ **`cl /LD` без `/IMPLIB` кладёт `.exp/.lib` рядом с выходной DLL** → в корне
  игры появлялись `dwmapi.exp`/`dwmapi.lib` → проверено 2026-11-25 → `buildProxy`
  передаёт `/IMPLIB:tmp/build_proxy/dwmapi.lib`, мусор остаётся в `tmp/`;
  старые файлы убирает `deploy --migrate`.

- ⚠️ **Namespace C# переименован в `NeonTranslatorDX`** (файл —
  `NeonTranslatorDX.dll`) → прокси ищет класс по строке
  `mono_class_from_name(image, "NeonTranslatorDX", "TranslatorPlugin")`; менять
  namespace и строку в `dwmapi_proxy.c` только вместе → проверено 2026-11-25
  сборкой csc + запуском игры.

- ⚠️ **Python-скрипты (`build.py`, `build_proxy.py`) удалены 2026-11-21** после
  порта и проверки на живой установке (паритет `.dat` по sha256). Если что-то
  понадобится сверить — история в git, в рабочем дереве их больше нет.

## Проверенные цифры (2026-11-21)

- `node build.mts` → `runtime/NeonTranslatorDX.dll`, 43.0 KB (44032 байта),
  6 исходников, 11 из 11 ссылок Unity.
- `node build_proxy.mts` → `dwmapi.dll` 13.5 KB (13824 байта) в игре и в репо,
  `dwmapi_real.dll` 190.5 KB (системная копия), MSVC 14.50.35717 + SDK
  10.0.26100.0.
