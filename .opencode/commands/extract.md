---
description: Извлечь текст из игры: dump_assets.py (UnityPy) → potgen.mts (POT)
agent: build
---

Run from the repository root (`Third-Crisis-Neon-Nights-Mods`), strictly in order.
Дамп живёт вне гита (`tmp/dump/`, регенерируется; ~319 МБ).

```bash
# 1. Дамп ассетов (python-остров; UnityPy). Путь к игре — env, не хардкод.
TCNN_GAME_DIR="<Steam>/steamapps/common/Third Crisis Neon Nights" \
  python .opencode/skills/dump-assets/scripts/dump_assets.py

# 2. Пробный POT в tmp/potgen/ (po/ не трогается)
npm run potgen

# 3. Обновление шаблона (единственная команда, меняющая po/template.pot)
node .opencode/skills/extract-text/scripts/potgen.mts --update
```

Что делает каждый шаг (детали — скиллы `dump-assets`, `extract-text`):

1. `dump_assets.py` — JSONL по объектам (`summaries.jsonl` + `<asset>.jsonl`).
   Медленно, запускать после апдейта игры. Формат — `references/DUMP_FORMAT.md`.
2. `potgen.mts` — `inventory.mts` читает дамп потоково и собирает 38 973 строки;
   каталог `(msgid, msgctxt)` → 33 271 запись POT. Отчёт печатает
   `inventory items / new / vanished / triaged / rich / merged twins`.
3. `--update` пишет `po/template.pot` атомарно; без флага — только отчёт.

Если `$ARGUMENTS` задан, передай его в `potgen.mts` (например,
`/extract --dump "<игра>/NeonTranslator/tmp/dump"`).

Ожидание: повторный прогон на неизменной игре даёт POT, совпадающий с
`po/template.pot` после нормализации `POT-Creation-Date` и `CRLF`→`LF`.
Любой другой дифф — стадия грязная, разбираться до перевода.
