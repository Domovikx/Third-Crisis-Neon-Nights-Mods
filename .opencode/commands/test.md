---
description: Run the TS test matrix (node --test) and the Python island tests
agent: build
---

Run from repo root. Default — TS matrix through npm (unit + E2E):

```bash
npm test          # text_filters, po_file, po2dat, inventory, potgen
npm run test:e2e  # дамп -> POT -> .dat на мини-фикстуре (без игры/сети)
```

Python-остров (UnityPy, только пока он не портирован):

```bash
python .opencode/skills/dump-assets/tests/dump_assets.test.py
python .opencode/skills/dump-assets/tests/dump_sqlite.test.py
python .opencode/skills/dump-assets/tests/dump_sqlite_reader.test.py
```

Легаси Python-тесты `extract-text` (`po_file.test.py`, `po_update.test.py`,
`po2dat.test.py`) — референс до удаления; их TS-паритет уже в `npm test`.
Тесты `extractor`/`potgen` удалены вместе с портированными `.py`.

Report per-suite pass/fail with failing test names. If `$ARGUMENTS` names a
suite (e.g. `/test inventory`), run only that file.
