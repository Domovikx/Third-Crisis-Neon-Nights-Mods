---
description: Прогнать TS-матрицу (node --test) и тесты python-острова
agent: build
---

Run from the repository root. По умолчанию — TS-матрица через npm:

```bash
npm test          # text_filters, po_file, po2dat, inventory, potgen, languages (71 тест)
npm run test:e2e  # дамп → POT → .dat на мини-фикстуре (без игры и сети)
```

Python-остров (UnityPy; тесты требуют установленную игру —
`TCNN_GAME_DIR` или старая раскладка):

```bash
TCNN_GAME_DIR="<Steam>/steamapps/common/Third Crisis Neon Nights" \
  python .opencode/skills/dump-assets/tests/dump_assets.test.py
python .opencode/skills/translate-local/tests/translate_local.test.py
```

Легаси Python-тесты `extract-text` (`po_file.test.py`, `po_update.test.py`,
`po2dat.test.py`) — референс до удаления; TS-паритет уже в `npm test`.
Тесты `extractor`/`potgen` удалены вместе с портированными `.py`;
`dump_sqlite*` не существует (SQLite-дамп удалён из формата).

Полный прогон (типы, линт, формат, языки, тесты):

```bash
npm run verify
```

Report per-suite pass/fail with failing test names. If `$ARGUMENTS` names a
suite (e.g. `/test inventory`), run only that file.
