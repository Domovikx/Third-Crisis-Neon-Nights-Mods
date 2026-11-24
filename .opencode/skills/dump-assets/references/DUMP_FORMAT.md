# DUMP_FORMAT — контракт дампа ассетов

Дамп — кэш между игрой (бинарники) и экстрактором (текст). Правило:
**экстрактор читает только дамп, никогда бинарники игры.**

Собирается один раз: `tools/rust-decoder` читает байты → `rd1`-JSONL →
`rust-l10n dump_assemble` пишет файлы ниже. TS-реализации сборки нет
(удалена 2026-11-24); оракул — золотые фикстуры скилла `dump-assets`.

## JSONL (текущий, `tmp/dump/`)

Один объект — одна строка (UTF-8, `\n`-терминатор, пустые/битые строки
пропускаются). Стримится, grep'ается (`jq`, `rg`), диффается построчно.

- `summaries.jsonl` — по строке на ассет: `{asset, total_objects,
object_types{...}, settings_keys[{key, display}]?, global_strings[]?, format?}`
  - `settings_keys[]` — только `dll_*` (.NET US-heap)
  - `global_strings[]` — UI-кандидаты на ассет, лимит 500 по умолчанию
    (`--global-string-limit`, счётчик обрезки печатается; поле в POT не читается)
  - `format` — `raw_binary` / `dotnet_us_heap`, если не Unity-объекты
- `<asset>.jsonl` — по строке на объект: `{asset, path_id, type,
strings{m_Name}, fields{...}, raw_strings[], dialogues[{speaker, text,
rich_text}]?, fsm_strings[]?, color_parser_list?{name: hex}}`
  - `fsm_strings[]` — видимые UI-строки PlayMaker FSM (`FsmString.value`,
    `stringParams` из typetree; только объекты с полем `fsm`). ANToolkit
    DialogueHistory часто хранит устаревший вариант («Ask about Arm»),
    а показывает игра значение FSM («Ask about her Arm»). Имена
    стейтов/событий и `useVariable`/slash-пути не берутся.
- `index.md` — человекочитаемый индекс (не для машин)

Чанков нет (были костылём от нестримимого JSON: `OBJECTS_PER_CHUNK` удалён).
`path_id` неуникален между типами (PreloadData#1 vs GameObject#1) — связка
всегда через пару `(asset, path_id, type)`, не через голый path_id.

Вне гита (~310M, регенерируется). Перезапуск поверх — идемпотентен.

## Правила эволюции (заморозка)

1. Additive-only: новые поля — можно; переименование/удаление — только
   с bump `schema_version` (поле summary) и адаптером чтения старого.
2. Reader падает громко на неизвестном `schema_version`, а не читает криво.
3. Любое изменение формата сопровождается A/B: экстракция из нового должна
   совпасть со старой побайтово (или diff ревьюится глазами).
4. Удалены без возврата: chunked-JSON (`*.chunk*.json`, 2026-09),
   SQLite-дамп (`dump_assets.db`, 2026-09 — коллеги против бинарников).
