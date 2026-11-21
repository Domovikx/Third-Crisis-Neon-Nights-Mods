#!/usr/bin/env python3
"""find_source.py — provenance lookup: which dump object(s) a POT msgid came from.

POT/PO carry no #: refs (dead weight, ~50% of file); tmp/dump is the source
of truth. Scans the dump via potgen.scan_dump() and prints every occurrence:

  [kind:source#idx] speaker=X :: text

Run: python .opencode/skills/extract-text/scripts/find_source.py "Yesss...!~"
     python .opencode/skills/extract-text/scripts/find_source.py "Yesss" --first
Exit 1 when nothing found (or the dump is missing).
"""

import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SKILL_DIR))
import potgen  # noqa: E402 (needs sys.path above)


def find(text: str, first: bool = False) -> list:
    """Exact-match scan. Returns [scan_dump item, ...]."""
    hits = []
    for item in potgen.scan_dump():
        if item["text"] == text:
            hits.append(item)
            if first:
                break
    return hits


def fmt(item: dict) -> str:
    base = f"{item['kind']}:{item['source']}"
    if item["idx"] is not None:
        base += f"#{item['idx']}"
    sp = f" speaker={item['speaker']}" if item.get("speaker") else ""
    return f"[{base}]{sp} :: {item['text'][:120]}"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    first = "--first" in sys.argv
    if not args:
        print('usage: find_source.py "msgid text" [--first]', file=sys.stderr)
        return 2
    import extractor as ext  # noqa: E402 (same skill, via potgen path)

    if not ext.find_chunks() and not ext.find_summaries():
        print("ERROR: tmp/dump is empty or missing; run dump_assets.py first", file=sys.stderr)
        return 1
    hits = find(args[0], first=first)
    for h in hits:
        print(fmt(h))
    if not hits:
        print("no occurrences in tmp/dump", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
