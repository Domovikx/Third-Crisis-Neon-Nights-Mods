#!/usr/bin/env python3
"""prefill_po.py — Build po/ru.po from template.pot + current RU translations.

Migration (not re-translation): every msgstr is filled from the existing
YAML corpus. Nothing is translated here — this step MEASURES the migration:

  - coverage: POT entries with an exact (msgid, msgctxt) RU match
  - fuzzy: exact key missed, but exactly one RU variant exists for the bare
    text (context changed, e.g. speaker added) — filled, flagged for review
  - conflicts: same (text, context) with DIFFERENT RU in different files
    (human must pick one; entry left empty)
  - missing: no RU anywhere (translators' work queue)
  - orphans: RU translations with no POT entry (would be lost in PO world)
  - skipped_with_translation: skip flag + real translation (human triage queue)

Acceptance: orphans == 0 (zero silent loss), conflicts listed for humans.

Run: python .opencode/skills/extract-text/prefill_po.py
Out: po/ru.po (tracked)
"""

import re
import sys
from datetime import UTC, datetime
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SKILL_DIR))
import po_file  # noqa: E402 (needs sys.path above)
import potgen  # noqa: E402 (needs sys.path above)

PATCH_DIR = Path(__file__).resolve().parent.parent.parent.parent.parent
PO_DIR = PATCH_DIR / "po"
POT_PATH = PO_DIR / "template.pot"
RU_PATH = PO_DIR / "ru.po"
BLOCKLIST_PATH = PO_DIR / "autofill_blocklist.txt"


def load_blocklist() -> set:
    """Normalized forms that must never be auto-filled (human-reviewed rejects)."""
    blocked = set()
    if BLOCKLIST_PATH.exists():
        for line in BLOCKLIST_PATH.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                blocked.add(line)
    return blocked


def normalize_text(s: str) -> str:
    """Aggressive normal form for twin matching (guarded by single-variant rule).

    '004 Yeees yeees Ill be thereee 1' and "Yeees yeees, I'll be thereee!"
    both become 'yes yes ill be there'. Markers, punctuation, apostrophes and
    letter elongation are dropped; different words still differ.
    """
    s = (s or "").lower().replace("'", "").replace("’", "")
    s = re.sub(r"[^a-zа-яё ]", " ", s)
    s = re.sub(r"(.)\1{2,}", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


def load_ru_map():
    """(text, ctxt) -> [(translation, file)], plus skip bookkeeping.

    Skipped entries stay OUT of ru.po (triage, not translator work) but are
    reported: po2dat carries the skipped-with-translation ones over so the
    game keeps applying them until humans untriage.
    """
    ru_map = {}
    skipped_with_translation = []
    for rel, e in potgen.iter_source_entries():
        text = e.get("text", "")
        tr = e.get("translation", "")
        if not text:
            continue
        ctxt = potgen.entry_context(e, rel)
        if e.get("skip_translation"):
            if tr and tr != text:
                skipped_with_translation.append((text, ctxt, tr, rel))
            continue
        if not tr:
            continue
        ru_map.setdefault((text, ctxt), []).append((tr, rel))
    return ru_map, skipped_with_translation


def build_ru_po():
    """Fill ru.po entries. Returns (po_entries, report).

    Human state is sacred: existing translator comments are carried over,
    and confirmed translations (msgstr present without auto-normalized flag)
    are never recomputed away.
    """
    pot_text = POT_PATH.read_text(encoding="utf-8")
    pot_entries = [e for e in po_file.parse_po(pot_text) if e["msgid"]]
    old_human = {}
    if RU_PATH.exists():
        for e in po_file.parse_po(RU_PATH.read_text(encoding="utf-8")):
            if e["msgid"]:
                old_human[(e["msgid"], e.get("msgctxt", ""))] = e
    ru_map, skipped_tr = load_ru_map()
    blocked = load_blocklist()
    # text -> set of distinct RU (for fuzzy fallback + conflict scan)
    by_text = {}
    for (text, _ctxt), variants in ru_map.items():
        by_text.setdefault(text, set()).update(t for t, _f in variants)
    # normalized text -> set of RU (auto-propagate to stripped FSM variants)
    by_norm = {}
    for (text, _ctxt), variants in ru_map.items():
        by_norm.setdefault(normalize_text(text), set()).update(t for t, _f in variants)

    report = {
        "total": 0,
        "exact": 0,
        "fuzzy": [],
        "auto_normalized": [],
        "conflicts": [],
        "missing": [],
        "orphans": [],
        "skipped_with_translation": skipped_tr,
    }
    pot_keys = set()
    po_entries = []
    for pe in pot_entries:
        key = (pe["msgid"], pe.get("msgctxt", ""))
        pot_keys.add(key)
        report["total"] += 1
        variants = ru_map.get(key, [])
        distinct = sorted({t for t, _f in variants})
        out = {
            "msgid": pe["msgid"],
            "msgctxt": pe.get("msgctxt", ""),
            "msgstr": "",
            "refs": pe.get("refs", []),
            "comments": pe.get("comments", []),
            "flags": [],
            "translator": list(old_human.get(key, {}).get("translator", [])),
        }
        confirmed = old_human.get(key, {})
        if confirmed.get("msgstr") and "auto-normalized" not in confirmed.get("flags", []):
            # Human-confirmed (or exact from a previous run): keep verbatim.
            out["msgstr"] = confirmed["msgstr"]
            out["flags"] = [f for f in confirmed.get("flags", []) if f != "auto-normalized"]
            report["exact"] += 1
        elif len(distinct) > 1:
            report["conflicts"].append((key, variants))
        elif len(distinct) == 1:
            out["msgstr"] = distinct[0]
            report["exact"] += 1
        else:
            # Fuzzy fallback: exactly one RU for the bare text (context drifted)
            cands = sorted(by_text.get(pe["msgid"], set()))
            if len(cands) == 1:
                out["msgstr"] = cands[0]
                out["flags"] = ["fuzzy"]
                report["fuzzy"].append((key, cands[0]))
            else:
                # Normalized fallback: stripped FSM variants ("000 Aw ... 2")
                # inherit the single translation of their normalized twin —
                # unless the twin family is blocklisted (reviewed rejects).
                norm_cands = sorted(by_norm.get(normalize_text(pe["msgid"]), set()))
                if len(norm_cands) == 1 and normalize_text(pe["msgid"]) not in blocked:
                    out["msgstr"] = norm_cands[0]
                    out["flags"] = ["fuzzy", "auto-normalized"]
                    report["auto_normalized"].append((key, norm_cands[0]))
                else:
                    report["missing"].append(key)
        po_entries.append(out)

    for (text, ctxt), variants in sorted(ru_map.items()):
        if (text, ctxt) not in pot_keys:
            report["orphans"].append(((text, ctxt), variants))
    return po_entries, report


RU_HEADER = [
    "# Russian translation for NeonTranslator (migrated from YAML corpus).",
    'msgid ""',
    'msgstr ""',
    '"Project-Id-Version: NeonTranslator 1.0\\n"',
    f'"PO-Revision-Date: {datetime.now(UTC).strftime("%Y-%m-%d %H:%M+0000")}\\n"',
    '"Language: ru\\n"',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '"Content-Transfer-Encoding: 8bit\\n"',
    '"Plural-Forms: nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\\n"',
]


def main() -> int:
    if not POT_PATH.exists():
        print("ERROR: run potgen.py first (po/template.pot missing)", file=sys.stderr)
        return 1
    po_entries, r = build_ru_po()
    RU_PATH.write_text(po_file.render_po(po_entries, RU_HEADER), encoding="utf-8")

    cov = 100.0 * r["exact"] / max(r["total"], 1)
    print(f"ru.po: {r['exact']}/{r['total']} exact ({cov:.1f}%) -> {RU_PATH}", file=sys.stderr)
    print(f"  fuzzy (context drift): {len(r['fuzzy'])}", file=sys.stderr)
    print(f"  auto-normalized (stripped variants inherit): {len(r['auto_normalized'])}", file=sys.stderr)
    for (text, ctxt), tr in r["auto_normalized"][:10]:
        print(f"    AUTO {ctxt} {text[:60]!r} -> {tr[:60]!r}", file=sys.stderr)
    print(f"  conflicts (same key, different RU): {len(r['conflicts'])}", file=sys.stderr)
    for (text, ctxt), variants in r["conflicts"][:10]:
        print(f"    CONFLICT {ctxt} {text!r}:", file=sys.stderr)
        for t, f in variants:
            print(f"      {t!r}  [{f}]", file=sys.stderr)
    print(f"  missing (no RU anywhere): {len(r['missing'])}", file=sys.stderr)
    for text, ctxt in r["missing"][:10]:
        print(f"    MISSING {ctxt} {text[:70]!r}", file=sys.stderr)
    print(f"  orphans (RU with no POT entry): {len(r['orphans'])}", file=sys.stderr)
    for (text, ctxt), variants in r["orphans"][:10]:
        print(f"    ORPHAN {ctxt} {text[:70]!r}: {variants}", file=sys.stderr)
    print(f"  skipped with real translation: {len(r['skipped_with_translation'])}", file=sys.stderr)
    for text, ctxt, tr, f in r["skipped_with_translation"][:10]:
        print(f"    SKIPPED-TR {ctxt} {text[:50]!r} -> {tr[:50]!r} [{f}]", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
