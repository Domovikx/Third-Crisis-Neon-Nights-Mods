#!/usr/bin/env python3
"""po2dat.py — Compile po/<lang>.po into runtime/patch_<lang>.dat (single file).

The game reads ONE JSON-lines file instead of 1176 YAML files. Each row:
{"t": text, "x": translation, "r": rich_text?, "rt": rich_translation?,
 "sk": true?} (only filled translations).

rich_text comes from template.pot #. comments; explicit rich_translation
from `# rich: ...` translator comments in the PO. The runtime auto-generates
rich_translation from rich+translation itself; explicit rt wins.

Duplicate texts resolve by earliest-ref-file-wins (mimics the C# loader's
first-wins over sorted files).

Run: python .opencode/skills/extract-text/scripts/po2dat.py [lang]
Out: runtime/patch_<lang>.dat (untracked build artifact; deploy ships it).
"""

import json
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
PATCH_DIR = SKILL_DIR.parent.parent.parent

sys.path.insert(0, str(SKILL_DIR / "scripts"))
import po_file  # noqa: E402 (same skill)


def load_pot_rich():
    """text -> rich_text from template.pot #. comments (first wins, file order)."""
    rich_map = {}
    pot_path = PATCH_DIR / "po" / "template.pot"
    if not pot_path.exists():
        return rich_map
    for e in po_file.parse_po(pot_path.read_text(encoding="utf-8")):
        if not e["msgid"] or e["msgid"] in rich_map:
            continue
        for c in e.get("comments", []):
            if c.startswith("rich_text:"):
                rich_map[e["msgid"]] = c[len("rich_text:") :].strip()
                break
    return rich_map


def rt_override(entry: dict) -> str:
    """Explicit rich_translation from `# rich: ...` translator comments."""
    for c in entry.get("translator", []) or []:
        if c.startswith("rich:"):
            return c[len("rich:") :].strip()
    return ""


def build_dat(lang: str):
    """Compile po/<lang>.po (+ template.pot rich) into .dat rows. Returns (rows, report)."""
    po_path = PATCH_DIR / "po" / f"{lang}.po"
    if not po_path.exists():
        raise FileNotFoundError(f"missing {po_path}")
    entries = [e for e in po_file.parse_po(po_path.read_text(encoding="utf-8")) if e["msgid"]]
    rich_map = load_pot_rich()
    report = {"po_entries": len(entries), "filled": 0, "dupes": [], "no_rich": 0, "rich_only": 0}
    rows = []
    seen_texts = set()
    gated = 0

    def ref_key(e):
        # Legacy ordering hook: earliest-ref-file-wins when refs exist
        # (POT no longer emits #: refs; then all keys are "~" and the
        # file order — sorted by msgid — wins deterministically).
        files = sorted(r for r in e.get("refs", []) if r.startswith("translations/"))
        stable = sorted(r for r in e.get("refs", []) if r.startswith("["))
        files.extend(stable)
        return files[0] if files else "~"

    by_text = {}
    for e in entries:
        by_text.setdefault(e["msgid"], []).append(e)

    for text, group in by_text.items():
        filled = [e for e in group if e.get("msgstr", "")]
        if filled:
            # Earliest-ref-file-wins: mirrors the C# loader's first-wins over
            # sorted files (e.g. dialogues/ beats speakers.yaml for Cartel Guy).
            filled.sort(key=ref_key)
            if len({e["msgstr"] for e in filled}) > 1:
                report["dupes"].append((text, [(e["msgstr"][:60], e.get("msgctxt", "")) for e in filled]))
            msgstr = filled[0]["msgstr"]
            # Review gate: auto-normalized ships only after human confirms
            # (removes the auto-normalized flag). Until then it stays out.
            if "auto-normalized" in filled[0].get("flags", []):
                gated += 1
                continue
        else:
            # Untranslated but styled: the game remaps these to their rich form
            # (best = rich_text when translation is empty). Row carries r only.
            msgstr = ""
        if text in seen_texts:
            continue
        rich = rich_map.get(text, "")
        rich_tr = rt_override(filled[0]) if filled else ""
        if not rich and not msgstr:
            continue
        seen_texts.add(text)
        if not rich:
            report["no_rich"] += 1
        row = {"t": text, "x": msgstr}
        if rich:
            row["r"] = rich
        if rich_tr:
            row["rt"] = rich_tr
        if filled and "legacy" in filled[0].get("flags", []):
            row["sk"] = True
        rows.append(row)
        if msgstr:
            report["filled"] += 1
        else:
            report["rich_only"] += 1

    report["gated_auto_normalized"] = gated
    return rows, report


def write_dat(rows: list, out_path: Path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def main() -> int:
    lang = sys.argv[1] if len(sys.argv) > 1 else "ru"
    rows, r = build_dat(lang)
    out = PATCH_DIR / "runtime" / f"patch_{lang}.dat"
    write_dat(rows, out)
    kb = out.stat().st_size // 1024
    print(f"patch_{lang}.dat: {len(rows)} rows ({kb} KB) -> {out}", file=sys.stderr)
    print(f"  po entries: {r['po_entries']}, filled: {r['filled']}, no rich_text: {r['no_rich']}", file=sys.stderr)
    print(f"  gated auto-normalized (awaiting human): {r.get('gated_auto_normalized', 0)}", file=sys.stderr)
    for text, variants in r["dupes"]:
        print(f"  DUPE {text!r}: {variants}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
