---
description: PO pipeline potgen -> prefill_po -> review_queue with report meanings
agent: build
---

Run from repo root, strictly in order (see skill `extract-text`,
`references/PO_WORKFLOW.md`, skill `translate-qa`):

```bash
node .opencode/skills/extract-text/scripts/potgen.mts --update
python .opencode/skills/extract-text/scripts/prefill_po.py
python .opencode/skills/translate-qa/scripts/review_queue.py
```

1. `potgen.mts --update` → `po/template.pot` (EN-база, 33 271 запись из дампа;
   одна запись на уникальную пару `(msgid, msgctxt)`, порядок — сортировка по
   паре; `#: refs` не пишутся, rich — в `#. rich_text:`).
2. `prefill_po.py` → `po/ru.po` — **пока Python-легаси и не запускается**
   (`translations/` удалено, импортирует удалённый `potgen.py`). Порт —
   задача `tasks/2026-11-21-port-po-tools.md`. Описание отчётов ниже —
   историческое, для будущего `.mts`-порта:
   - `exact` — POT key has an exact `(msgid, msgctxt)` RU match (coverage)
   - `fuzzy` — key missed but exactly one RU variant for the bare text
     (context drift, flagged for review)
   - `auto-normalized` — stripped FSM variants inherit RU with an
     `auto-normalized` flag (~162); gated — `po2dat.mts` does NOT ship them
     until a human clears the flag
   - `conflicts` — same key, different RU in different files (human picks one)
   - `missing` — no RU anywhere (translators' work queue)
   - `orphans` — RU with no POT entry; acceptance is `orphans == 0`
     (zero silent loss)
   - `skipped with translation` — skip flag + real translation (human triage
     queue; `po2dat.mts` carries them over so the game keeps applying them)
3. `review_queue.py [--limit 100]` → `tmp/review_queue.html` (untracked; Python,
   тоже ждёт порта).
   Set A (top priority): AUTO-normalized awaiting human confirm. Set B:
   missing grouped by asset (scene) with prev/next neighbor lines from
   `stable_index` (удалён вместе с `extractor.py`; порт возьмёт дамп).
   Quest/FSM labels grouped separately (visibility triage: mass-skip if never
   shown, don't translate).
