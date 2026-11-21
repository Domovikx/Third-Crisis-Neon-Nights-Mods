---
description: POT/PO-пайплайн — обновить шаблон, досинхронизировать переводы, собрать словарь; статусы отчётов
agent: build
---

Run from the repository root, strictly in order (см. скилл `extract-text`,
`references/PO_WORKFLOW.md`).

```bash
# 1. Шаблон EN из дампа (единственная команда, меняющая po/)
node .opencode/skills/extract-text/scripts/potgen.mts --update

# 2. Перенос переводов в новый POT (Python-референс, порт — tasks/2026-11-21-port-po-tools.md)
#    Пока НЕ запускается: импортирует удалённый potgen.py.
#    python .opencode/skills/extract-text/scripts/po_update.py

# 3. Словарь для игры
npm run po2dat -- ru
```

Что важно про отчёты (историческое описание `prefill_po.py` — для будущего
`.mts`-порта, сейчас не работает):

- `exact` — у ключа POT есть точный `(msgid, msgctxt)` перевод (покрытие);
- `fuzzy` — ключ не совпал, но для голого текста есть ровно один вариант
  (дрейф контекста; на ревью);
- `auto-normalized` — урезанные FSM-варианты наследуют перевод с флагом
  (≈162); `po2dat` их НЕ отдаёт в игру до снятия флага человеком;
- `conflicts` — один ключ, разные переводы в разных файлах (выбирает человек);
- `missing` — перевода нет нигде (очередь переводчика);
- `orphans` — перевод без записи в POT; приёмка `orphans == 0` (ноль тихих потерь);
- `skipped with translation` — skip-флаг + реальный перевод (ручной триаж;
  `po2dat` их переносит, чтобы игра продолжала применять).

`fuzzy`/`auto-normalized`/`conflicts` требует решения человека. Массовые
скипы (quest/FSM-метки, которые не показываются игроку) — отдельной группой.

`review_queue.py` (HTML-очередь) сейчас **не работает**: ему нужен
`output/stable_index.json`, удалённый вместе с `extractor.py`. Замена — в
`tasks/2026-11-21-port-qa-and-translate.md`.
