---
description: Извлечь текст из игры: дамп ассетов (Rust) → POT (Rust potgen)
agent: build
---

Run from the repository root (`Third-Crisis-Neon-Nights-Mods`), strictly in order.
Дамп живёт вне гита (`tmp/dump/`, регенерируется; ~319 МБ).

```bash
# 1. Дамп ассетов: Rust-декодер + сборка на Rust (единственный путь;
#    TS-реализации и флаг --decoder ts удалены 2026-11-24)
npm run dump            # = --decoder rust

# 2. Пробный POT в tmp/potgen/ (po/ не трогается)
npm run potgen

# 3. Обновление шаблона (единственная команда, меняющая po/template.pot)
npm run potgen -- --update
```

Что делает каждый шаг (детали — скиллы `dump-assets`, `extract-text`):

1. Дамп — JSONL по объектам (`summaries.jsonl` + `<asset>.jsonl`).
   Запускать после апдейта игры (`npm run check:version` напомнит).
   Формат — `references/DUMP_FORMAT.md`; сравнение реализаций — `docs/rust-vs-ts.md`.
2. `potgen` (Rust) — `inventory` читает дамп потоково и собирает строки;
   каталог `(msgid, msgctxt)` → `po/template.pot` (18 445 записей). Отчёт печатает
   `inventory items / new / vanished / triaged / rich / merged twins`.
3. `--update` пишет `po/template.pot` атомарно; без флага — только отчёт.

Если `$ARGUMENTS` задан, передай его в `potgen` (например,
`/extract --dump "<игра>/NeonTranslator/tmp/dump"`).

Ожидание: повторный прогон на неизменной игре даёт POT, совпадающий с
`po/template.pot` после нормализации `POT-Creation-Date` и `CRLF`→`LF`.
Любой другой дифф — стадия грязная, разбираться до перевода.
