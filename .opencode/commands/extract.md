---
description: Извлечь текст из игры: дамп ассетов (Rust/TS) → POT (Rust potgen)
agent: build
---

Run from the repository root (`Third-Crisis-Neon-Nights-Mods`), strictly in order.
Дамп живёт вне гита (`tmp/dump/`, регенерируется; ~319 МБ).

```bash
# 1. Дамп ассетов. Рабочий декодер — Rust (в 3× быстрее); TS — эталон.
npm run dump            # = --decoder rust
npm run dump:ts         # эталон-образец (работает без Rust-тулчейна)

# 2. Пробный POT в tmp/potgen/ (po/ не трогается)
npm run potgen

# 3. Обновление шаблона (единственная команда, меняющая po/template.pot)
npm run potgen -- --update
```

Что делает каждый шаг (детали — скиллы `dump-assets`, `extract-text`):

1. Дамп — JSONL по объектам (`summaries.jsonl` + `<asset>.jsonl`).
   Запускать после апдейта игры (`npm run check:version` напомнит).
   Формат — `references/DUMP_FORMAT.md`; сравнение реализаций — `docs/rust-vs-ts.md`.
2. `potgen` (Rust) — `inventory` читает дамп потоково и собирает 38 973 строки;
   каталог `(msgid, msgctxt)` → 33 271 запись POT. Отчёт печатает
   `inventory items / new / vanished / triaged / rich / merged twins`.
3. `--update` пишет `po/template.pot` атомарно; без флага — только отчёт.

Если `$ARGUMENTS` задан, передай его в `potgen` (например,
`/extract --dump "<игра>/NeonTranslator/tmp/dump"`).

Ожидание: повторный прогон на неизменной игре даёт POT, совпадающий с
`po/template.pot` после нормализации `POT-Creation-Date` и `CRLF`→`LF`.
Любой другой дифф — стадия грязная, разбираться до перевода.
