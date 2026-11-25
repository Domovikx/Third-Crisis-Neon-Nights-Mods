---
name: build-translator
description: Компиляция NeonTranslatorDX (C# → DLL через csc.exe) и нативного прокси dwmapi.dll (C → dll через cl.exe) для рантайм-перевода Unity-игр. Путь к игре — scripts/game_dir.mts (TCNN_GAME_DIR).
---

# build-translator — сборка рантайм-переводчика

Два независимых артефакта:

- `runtime/NeonTranslatorDX.dll` — C#-плагин (scan-and-replace через
  `NeonLateUpdate` + `Canvas.willRenderCanvases`), собирается `csc.exe` из
  `.NET Framework 4.x`.
- `<игра>/dwmapi.dll` — нативный прокси-лоадер, собирается `cl.exe` (MSVC).
  Форвардит все экспорты в `dwmapi_real.dll` (копия системной DLL), два
  перехватывает; без него рантайм в игре не загружается.

```text
source/*.cs ──csc.exe──▶ runtime/NeonTranslatorDX.dll ──deploy──▶ <игра>/mods/NeonTranslatorDX/
source/dwmapi_proxy.c ──cl.exe──▶ <игра>/dwmapi.dll + <игра>/mods/NeonTranslatorDX/dwmapi_real.dll (+ копии в репо)
```

## Скрипты (`scripts/`)

- `build.mts` — сборка рантайма. Чистые функции (`buildArgs`, `collectRefs`,
  `chooseCsc`, `resolveGame`) отделены от запуска компилятора: тесты не требуют
  ни игры, ни `csc.exe`.
- `build_proxy.mts` — сборка прокси. MSVC и Windows SDK ищутся через
  `vswhere.exe` (плюс фолбэк по каталогам установок), версии выбираются самые
  новые; все пути переопределяемы env-переменными.
- `build.py`, `build_proxy.py` — **легаси-референс** старой раскладки (читают
  только `TCNN_GAME_DIR` и хардкодят MSVC 14.50.35717). Не править и не звать;
  удаление — решение владельца.
- `tests/build.test.mts` — `node --test`, без игры и компиляторов.
- `tests/neoncore.test.mts` — компилирует `source/NeonFontCore.cs` настоящим `csc.exe`
  и проверяет свойства подбора кегля (не растёт, пол 60 %, влезает), типографику
  (zh/ja/ko/лат) и цепочку фолбэков `lat → SC → JP → KR → marks`.
- `tests/menu.test.mts` — порядок языков = `config/language-priority.json`, геометрия
  панели (не наезжает на кнопки на 1600×900 / 1920×1080 / 2560×1080 / 1440×1080),
  значения `fonts/typography.json`.

## Рантайм-модули шрифтов и меню

- `NeonFontCore.cs` — чистые функции (кегль, лицо по языку, цепочка, CJK-масштаб).
- `NeonFonts.cs` — динамические TMP-лица из TTF, клонирование игровых ассетов
  (`CloneGameFace`), fallback-цепочка, preload по объединению cmap цепочки.
- `NeonTypography.cs` — читает `fonts/typography.json` (кегль/интерлиньяж по языкам).
- `NeonFit.cs` — CJK-масштаб + авто-подгонка кегля (пол 60 %) для подписей.
- `NeonLanguageSwitcher.cs` — панель языка (F9), метрики — `docs/ui-kit.md`.
- `NeonUiKit.cs` — процедурные скругления/тени/палитра.
- `NeonFontDebug.cs` — скрытая страница `Ctrl+F12` (Font specimen; вкладка Compare —
  кандидаты шрифтов, применение только на сессию) и флаг `fontdebug.txt`.
- `NeonUiProbe.cs` — временный дамп метрик UI игры (F10), удалить после приёмки.

## Команды

```bash
# путь к игре: TCNN_GAME_DIR или автопоиск по Steam-библиотекам
node .opencode/skills/build-translator/scripts/build.mts          # C# → DLL
node .opencode/skills/build-translator/scripts/build_proxy.mts    # C → прокси

# нестандартные окружения
TCNN_CSC="<csc.exe>"            node .../build.mts
TCNN_MSVC_TOOLS="<...>/VC/Tools/MSVC/<версия>" \
TCNN_WINDOWS_SDK="C:\\Program Files (x86)\\Windows Kits\\10" \
TCNN_SDK_VERSION="10.0.26100.0" node .../build_proxy.mts
```

Когда чего не хватает, скрипт печатает, что именно и что задать; код выхода 1.
`TCNN_GAME_DIR` с несуществующей папкой — ошибка, а не тихий откат на
Steam-копию (иначе сборка уходит в другую установку).

### Что нужно на машине

- рантайм: `csc.exe` из .NET Framework 4.x (`C:\Windows\Microsoft.NET\Framework64\v4.0.30319`),
  установленная игра с `Managed/UnityEngine*.dll` (11 ссылок, минимум 4);
- прокси: Visual Studio Build Tools с C++ x64 + Windows SDK (include и lib).

### Куда что пишется

- `runtime/NeonTranslatorDX.dll` — артефакт сборки (в git не попадает);
- `<игра>/dwmapi.dll`, `<игра>/mods/NeonTranslatorDX/dwmapi_real.dll`;
- копия прокси в корень репозитория (`dwmapi.dll`) — её ставит `deploy.mts`;
- `tmp/build_proxy/` — `.obj/.lib/.exp` (в корне репозитория не мусорим).

## Тесты

```bash
node --test .opencode/skills/build-translator/tests/build.test.mts
```

Проверяют: сборку аргументов `csc`/`cl`, выбор компилятора и версий MSVC/SDK,
фильтрацию ссылок из `Managed/`, наличие `SOURCE_FILES` на диске, разрешение
пути к игре (включая ошибку на несуществующий `TCNN_GAME_DIR`).

## Установка

Деплой — `deploy.mts` скилла `deploy-translator` (`--rebuild` и `--proxy`
переиспользуют эти же функции, второй реализации сборки нет).
