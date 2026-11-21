---
description: Full extract pipeline dump_assets -> dump_sqlite -> extractor (sqlite default)
agent: build
---

Run from repo root (`NeonTranslator/`), strictly in order. Dumps live outside
the repo in `<game>/dump_assets/` (regenerated, untracked).

```bash
python .opencode/skills/dump-assets/scripts/dump_assets.py
python .opencode/skills/dump-assets/scripts/dump_sqlite.py
python .opencode/skills/extract-text/scripts/extractor.py
```

Steps (see skills `dump-assets`, `extract-text`):

1. `dump_assets.py` — UnityPy dump of `Third Crisis Neon Nights_Data/*.assets`
   - recursive `StreamingAssets/**/*.bundle` → JSON summary + chunk files.
     Slow, run rarely (after game update).
2. `dump_sqlite.py` — JSON → `dump_assets.db` (~17s, A/B-equivalent).
   Schema: `references/DUMP_FORMAT.md`; inspect via DB Browser or
   `alexcvzz.vscode-sqlite`.
3. `extractor.py` — dump → `translations/` YAML (default source is SQLite;
   `--source json` is the JSON fallback). Also writes
   `output/stable_index.json` (`{stable_id, text_hash, context}` registry for
   the PO pipeline) and `output/orphans.yaml` (quarantine for vanished lines).
   `raw/` + `settings/` get auto-triage (asset names, binary junk →
   copy-through + `skip`); dialogues are never auto-touched.

A/B expectation: re-running `extractor.py` (or sqlite vs json source) must
produce zero diff (`git status` clean on `translations/` + `po/`). Any diff
means the stage is dirty — investigate before translating. If `$ARGUMENTS`
is given, append it to the `extractor.py` call (e.g. `/extract --source json`).
