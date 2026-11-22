# [2026-11-22] `#US`-куча DLL: лимит top-500 и фильтр отладки

Статус: READY

## Цель

Вернуть в POT видимые строки из `#US`-кучи `Assembly-CSharp.dll`, которые теряются
из-за жёсткого лимита «не больше 500 UI-строк на сборку», и не тащить в POT отладочный
лог.

## Контекст (независимый замер 2026-11-22, `tmp/dll_audit.mts`)

- `Assembly-CSharp.dll`: 751 UI-кандидат в `#US` (по фильтру `looksLikeDisplayText`),
  в `settings_keys` попадает 500 (`scanDotnetUiStrings` → `slice(0, 500)`), **251
  отрезан**, из них **237 отсутствуют в POT**.
- `Assembly-CSharp-firstpass.dll`: 151 кандидат, все 151 в POT (лимит не мешает).
- Из 237 отрезанных большинство — пути шейдеров/микшера (`Hidden/TCNN/NaN Catcher`,
  `Master/VA/Sex Scene VA`), отладочный лог (`SaveManager: Saving game:`,
  `LOVENSE: Searching for toys on Bluetooth...`) и тестовые строки (`HALLO2`,
  `AAAAAAAAAAAAAA`).
- **Видимые**: `Overwrite Save` (диалог сохранения), `Lovense Toy Search`,
  `APP NOT FOUND`, `CONNECTED, NO TOYS FOUND`, `CONNECTED`, `DISABLED`, `START`,
  `Please enter name of character like so: …` (консоль), `Unlocked by`, `Skip sleeping`,
  `Don't skip Sleeping` (выбор в диалоге).

Итого ~20–30 видимых строк, но это ровно те строки, которые игрок видит в редких
экранах (Lovense, сохранения, консоль) и которые сейчас остаются английскими.

## Что сделать

1. Снять/поднять лимит 500 и мерить реальное число кандидатов.
2. Добавить отсев отладки/технического:
   - строки с `Settings.`, `Material '`, `Shader `, `Hidden/`, `Master/`, `Fonts &`, `UI/`;
   - известные логи (`SaveManager:`, `LOVENSE:`, `NaN Catcher`, `Render Glitch`);
   - строки без букв или из повторов (`AAAA…`), тестовые (`HALLO2`).
3. Оставить приоритизацию (`dotnetUiPriority`), но обрезать не «по 500 всего», а по
   порогу приоритета (например, только `priority ≥ 50`).
4. Замерить: сколько добавилось в POT, сколько из них видимых (выборка 20).

## Приёмка

- [ ] В `settings_keys` попадают все кандидаты с `priority ≥ 50` (или иной
      документированный порог), лимит 500 больше не режет видимое
- [ ] `Overwrite Save`, `Lovense Toy Search`, `APP NOT FOUND` есть в POT
- [ ] Пути шейдеров/микшера и отладочный лог в POT не попали
- [ ] Числа до/после в журнале задачи
- [ ] POT: дифф аддитивный; паритет TS ↔ Rust не сломан

## Вне рамок

- Перевод `settings_keys` и `Settings.*` (это данные PO).
- Кучи `#US` других плагинов (сканируются только две сборки игры).
- `global_strings` из ассетов (отдельная задача).

## Файлы

- `.opencode/skills/dump-assets/scripts/dotnet.mts` (`scanDotnetUiStrings`,
  `looksLikeDisplayText`, `dotnetUiPriority`)
- `tools/rust-decoder/src/dotnet.rs`
- тесты дампера/декодера

## Связи

- `docs/pot-coverage-audit.md`.
- `tasks/2026-11-21-pot-noise-cleanup.md` (чтобы не вернуть шум).
