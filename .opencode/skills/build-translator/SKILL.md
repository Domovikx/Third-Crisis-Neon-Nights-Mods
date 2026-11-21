---
name: build-translator
description: Компиляция NeonTranslatorRuntime (C# → DLL) и нативного прокси dwmapi.dll (C → dll) для рантайм-перевода Unity-игр
---

# build-translator — Сборка рантайм-переводчика

Компилирует NeonTranslatorRuntime.dll (C#) и dwmapi.dll (C native proxy).
Scan-and-replace переводчик через NeonLateUpdate + Canvas.willRenderCanvases.

## Архитектура сборки

```
┌──────────────────────────┐     ┌──────────────────────────────┐
│  build.py                │     │  build_proxy.py              │
│  csc.exe → .dll          │     │  cl.exe → .dll               │
│                          │     │                              │
│  source/*.cs             │     │  source/dwmapi_proxy.c       │
│  + Unity refs.dll        │     │  + MSVC + Windows SDK        │
│  → NeonTranslatorRuntime │     │  → dwmapi.dll (native proxy) │
└──────────┬───────────────┘     └──────────┬───────────────────┘
           │                                │
           ▼                                ▼
   runtime/NeonTranslatorRuntime.dll  dwmapi.dll (корень игры)
```

## Файлы

- `source/NativeMethods.cs` — P/Invoke gdi32 (AddFontMemResourceEx)
- `source/TranslationLoader.cs` — читает `patch_<lang>.dat`, строит Dictionary; `Reload()` для живого переключения
- `source/NeonLateUpdate.cs` — MonoBehaviour exec order 10000, вызывает Populate
- `source/TranslatorPlugin.cs` — точка входа [RuntimeInitializeOnLoadMethod]; `SetLanguage()`, дефолт `en`
- `source/NeonLanguageSwitcher.cs` — in-game панель языков (кнопка/мини-кнопка/F9)
- `source/dwmapi_proxy.c` — native proxy DLL (32 forward + 2 intercepts)
- `scripts/build.py` — компиляция C# → DLL через csc.exe (+UnityEngine.InputLegacyModule)
- `scripts/build_proxy.py` — компиляция dwmapi_proxy.c → dwmapi.dll
- `tests/build.test.py` — тест сборки + проверка DLL (25 тестов)

## Сборка

```bash
python .opencode/skills/build-translator/scripts/build.py
```

Результат: `runtime/NeonTranslatorRuntime.dll`

## Установка (деплой)

Установка — через `deploy.ps1` из корня репо (см. скилл `deploy-translator`).
Вручную это: DLL + TTF + `patch_<lang>.dat` + `active_lang.txt` → `Managed/`,
`dwmapi.dll` → корень игры. Рантайм читает только `.dat`
(legacy YAML-фолбэк оставлен в коде на переходный период).

## Прокси (dwmapi.dll) — только один раз

```bash
python .opencode/skills/build-translator/scripts/build_proxy.py
```

Собирает `dwmapi.dll` + `dwmapi_real.dll` в корне игры.

## Кириллический шрифт

При переводе на русский кириллические глифы добавляются в существующий
TMP_FontAsset `Roboto-Condensed_DialogueUI` через `TryAddCharacters()`.

**Механизм** (TranslatorPlugin.cs::TryInstallCyrillicFont):

1. `RobotoCondensed-Regular.ttf` читается из `Managed/`
2. Регистрация через GDI `AddFontMemResourceEx` (без админ-прав)
3. Поиск `Roboto-Condensed_DialogueUI` через `Resources.FindObjectsOfTypeAll`
4. Переключение `atlasPopulationMode = Dynamic`
5. Установка `sourceFontFile` через рефлексию
6. `TryAddCharacters(cyrillicUnicodes)` + `ReadFontAssetDefinition()`

**Требования:**

- TTF в `Managed/` (`RobotoCondensed-Regular.ttf`, 371 KB)
- `NativeMethods.cs` содержит `AddFontMemResourceEx`
- `AtlasPopulationMode.Dynamic` поддерживается шрифтом
- Вызов отложен на 5 кадров (через `_fontInitDelay`) чтобы не тормозить старт

**Важно:** все глифы (латиница + кириллица + пунктуация) находятся в одном
шрифтовом ассете, поэтому `<font material="...Perversion">` работает
одинаково для всех символов (GLOW_ON + UNDERLAY_ON).

## Формат данных (PO → DAT)

Источник правды — `po/template.pot` + `po/<lang>.po` (POT-хаб, детали в README).
`po2dat.py` компилирует PO в `runtime/patch_<lang>.dat` — один JSON-объект
на строку (`t` текст, `x` перевод, `r`/`rt` rich, `sk` legacy-флаг).
Рантайм (TranslationLoader.cs):

- auto-generates `rich_translation` из `rich_text` + `translation`
- fallback: `rich_translation > translation > rich_text > text`
- `best != text` guard — не добавляет тождественные записи
- `_allKeys.Contains(text)` skip — пропускает уже обработанные дубликаты (defense-in-depth)
- `en` — нативный язык игры: пустой словарь, без патча
