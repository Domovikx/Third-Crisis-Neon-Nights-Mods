---
description: Прогнать тесты TS, дампера и Rust-ядра
agent: build
---

Run from the repository root. По умолчанию — TS-матрица через npm:

```bash
npm test          # юнит-тесты TS: текст, PO/POT, языки, релиз
npm run test:dump # дампер: контейнеры, SerializedFile, извлечение, паритет TS↔Rust
npm run test:e2e  # дамп → POT → .dat на мини-фикстуре (без игры и сети)
npm run rust:test # ядро Rust (юнит + тест на живой игре, если установлена)
```

Всё, кроме теста на живой игре, работает без тулчейна Rust и без установленной игры.

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
