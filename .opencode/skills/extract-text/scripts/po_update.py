#!/usr/bin/env python3
"""po_update.py — msgmerge -U analog: refresh po/<lang>.po from template.pot.

Best-practice update cycle (GNU gettext: def.po + ref.pot -> updated def.po):
  - exact (msgid, msgctxt) match -> translation carried, refs/comments refreshed
  - key vanished but text survives under another ctxt -> retargeted (rescued,
    runtime keys by bare text; e.g. ui-twin merge, speaker reclassification)
  - text gone from POT entirely -> kept live as legacy (stale .dat rows are
    harmless; dropping live translations is a regression)
  - new key in POT -> empty entry appended
  - translator comments (# rich: overrides, notes) always carried + rendered
  - no fuzzy guessing here (prefill owns the migration heuristics)

Run: python .opencode/skills/extract-text/scripts/po_update.py [lang]
Out: po/<lang>.po rewritten in place (+ .bak backup).
"""

import shutil
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
PATCH_DIR = SKILL_DIR.parent.parent.parent

sys.path.insert(0, str(SKILL_DIR / "scripts"))
import po_file  # noqa: E402 (same skill)


def merge_pot(po_entries: list, pot_entries: list):
    """Merge translations forward. Returns (merged, stats)."""
    po_map = {(e["msgid"], e.get("msgctxt", "")): e for e in po_entries if e["msgid"]}
    pot_keys = [(e["msgid"], e.get("msgctxt", "")) for e in pot_entries if e["msgid"]]
    pot_by_text = {}
    for e in pot_entries:
        if e["msgid"]:
            pot_by_text.setdefault(e["msgid"], []).append(e)
    merged, stats = [], {"carried": 0, "new": 0, "obsolete": 0, "retargeted": 0, "legacy_kept": 0}
    retarget_fill = {}  # (msgid, ctxt) -> (msgstr, translator) carried across ctxts
    for key in sorted(set(po_map) - set(pot_keys)):
        old = po_map[key]
        if not old.get("msgstr") or "legacy" in old.get("flags", []):
            continue
        cands = [c for c in pot_by_text.get(old["msgid"], [])]
        live = [k for k in [(old["msgid"], c.get("msgctxt", "")) for c in cands] if po_map.get(k, {}).get("msgstr")]
        if cands and not live:
            # Same EN text survives under another ctxt (ui-twin merge, speaker
            # reclassification): rescue the human translation onto it instead
            # of stranding it in #~. Runtime keys by bare text anyway.
            cands.sort(key=lambda c: c.get("msgctxt", ""))
            tgt = (old["msgid"], cands[0].get("msgctxt", ""))
            retarget_fill[tgt] = (old.get("msgstr", ""), list(old.get("translator", [])))
            stats["retargeted"] += 1
    for pe in pot_entries:
        if not pe["msgid"]:
            continue
        key = (pe["msgid"], pe.get("msgctxt", ""))
        old = po_map.get(key)
        if key in retarget_fill and not (old and old.get("msgstr")):
            msgstr, tr = retarget_fill[key]
            old = dict(old) if old else {}
            old["msgstr"] = msgstr
            old["translator"] = tr
        merged.append(
            {
                "msgid": pe["msgid"],
                "msgctxt": pe.get("msgctxt", ""),
                "msgstr": old.get("msgstr", "") if old else "",
                "refs": pe.get("refs", []),
                "comments": pe.get("comments", []),
                "flags": [f for f in (old.get("flags", []) if old else []) if f != "auto-normalized"],
                "translator": old.get("translator", []) if old else [],
            }
        )
        stats["carried" if old and old.get("msgstr") else "new"] += 1
    po_keys = set(po_map)
    for key in sorted(set(po_keys) - set(pot_keys)):
        old = po_map[key]
        if not old.get("msgstr"):
            continue
        if "legacy" in old.get("flags", []):
            # Migrated triage translations: not in POT by design, never obsolete.
            merged.append(old)
            continue
        if old["msgid"] in pot_by_text:
            # Rescued via retarget above (or a filled same-text dupe survives).
            continue
        # Text gone from POT entirely (stale dump objects, e.g. pid 1/2 ghosts):
        # human work is sacred — keep live as legacy. A stale .dat row costs
        # nothing (loader no-matches); dropping a live one is a regression.
        keep = dict(old)
        if "legacy" not in keep.get("flags", []):
            keep["flags"] = list(keep.get("flags", [])) + ["legacy"]
            tr = list(keep.get("translator", []))
            tr.append("legacy: text vanished from POT, kept for runtime lookup")
            keep["translator"] = tr
        merged.append(keep)
        stats["legacy_kept"] += 1
    return merged, stats


def render_merged(entries: list, header: list) -> str:
    """Render with obsolete entries as #~ commented blocks (gettext style)."""
    out = list(header) + [""]
    for e in entries:
        prefix = "#~ " if e.get("obsolete") else ""
        for ref in e.get("refs", []):
            out.append(f"{prefix}#: {ref}")
        for c in e.get("comments", []):
            out.append(f"{prefix}#. {c}")
        for t in e.get("translator", []):
            out.append(f"{prefix}# {t}".rstrip())
        flags = [f for f in e.get("flags", []) if f]
        if flags:
            out.append(f"{prefix}#, {', '.join(flags)}")
        if e.get("msgctxt"):
            out.append(f'{prefix}msgctxt "{po_file.po_escape(e["msgctxt"])}"')
        out.append(f'{prefix}msgid "{po_file.po_escape(e["msgid"])}"')
        out.append(f'{prefix}msgstr "{po_file.po_escape(e.get("msgstr", ""))}"')
        out.append("")
    text = "\n".join(out).rstrip("\n") + "\n"
    # parse_po skips unknown #~ lines on re-read (documented limitation:
    # obsolete entries are human-readable archive, re-adding needs manual edit)
    return text


def main() -> int:
    lang = sys.argv[1] if len(sys.argv) > 1 else "ru"
    po_dir = PATCH_DIR / "po"
    pot = [e for e in po_file.parse_po((po_dir / "template.pot").read_text(encoding="utf-8"))]
    po_path = po_dir / f"{lang}.po"
    if not po_path.exists():
        print(f"ERROR: {po_path} missing (seed it from template.pot first)", file=sys.stderr)
        return 1
    header, old = [], po_file.parse_po(po_path.read_text(encoding="utf-8"))
    # Header = verbatim first block of the old file (comments + metadata).
    raw = po_path.read_text(encoding="utf-8").split("\n\n", 1)[0].splitlines()
    header = [ln for ln in raw if ln]
    merged, stats = merge_pot([e for e in old if e["msgid"]], [e for e in pot if e["msgid"]])
    shutil.copy2(po_path, po_path.with_suffix(".po.bak"))
    po_path.write_text(render_merged(merged, header), encoding="utf-8")
    print(
        f"{lang}.po updated: carried={stats['carried']}, new={stats['new']}, "
        f"obsolete={stats['obsolete']}, retargeted={stats['retargeted']}, "
        f"legacy_kept={stats['legacy_kept']} (backup .bak)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
