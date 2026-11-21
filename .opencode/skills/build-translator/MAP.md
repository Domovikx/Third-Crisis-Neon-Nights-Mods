# MAP — build-translator (факты и грабли)

Сборка C#-рантайма и нативного прокси. Python-скрипты — до `.mts`-порта
(`tasks/2026-11-21-port-build-deploy.md`). Проверено 2026-11-21.

## Готчи

- ⚠️ **После переезда репозитория сборка искала игру не там** → `build.py` и
  `build_proxy.py` брали `GAME_DIR = PATCH_DIR.parent` (верно только для старой
  раскладки) → проверено чтением (`build.py:6`, `build_proxy.py:8`) и фиксом:
  `resolve_game_dir()` читает `TCNN_GAME_DIR`; `py_compile` зелёный → собирать
  только с `TCNN_GAME_DIR="<Steam>/steamapps/common/Third Crisis Neon Nights"`
  (или старым деревом).

- ⚠️ **`deploy.ps1` звал удалённый `po2dat.py`** → после порта шаблон собирает
  `po2dat.mts` → проверено: скрипт переведён на `node …/po2dat.mts`, синтаксис
  проверен `Parser::ParseFile` → не возвращать `python po2dat.py`.

- ⚠️ **`deploy.ps1` удалял legacy `<игра>/translations/`** → это остаток старой
  YAML-раскладки; на текущей игре такой папки нет, `Remove-Item` с
  `-ErrorAction SilentlyContinue` не падает → проверено чтением скрипта →
  не «оптимизировать» без проверки, что папки правда нет.

- ⚠️ **Прокси `dwmapi.dll` живёт рядом с exe, а не в `Managed/`** → DLL-hijack
  требует корень игры; Steam «verify integrity» её удаляет → проверено
  комментарием в `deploy.ps1` и логикой копирования → после проверки файлов
  Steam просто перезапустить деплой.

- ⚠️ **Сборка требует установленную игру** → `build.py` берёт
  `UnityEngine*.dll`/`netstandard.dll` из `Managed/`, без них «Missing Unity
  assemblies» → проверено чтением (`REF_DLLS`) → в CI без игры сборку не
  гонять; для проверки кода хватает `npm run typecheck` (TS-часть).
