#!/usr/bin/env python3
"""review_queue.py — Human review queue with context (neighbors, asset, flags).

The process fix for "reviewing bare strings is guessing":
  - review set A: auto-normalized (machine-proposed, human confirms) — TOP priority
  - review set B: missing translations, grouped by asset (scene), each with
    prev/next neighbor lines (RU included when translated) from stable_index
  - quest/FSM labels grouped separately (visibility triage, not translation)

Run: python .opencode/skills/translate-qa/scripts/review_queue.py [--limit 100]
Out: tmp/review_queue.html (untracked). Reply with approved numbers.
"""

import html
import json
import sys
from collections import defaultdict
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
PATCH_DIR = SKILL_DIR.parent.parent.parent
PO_DIR = PATCH_DIR / "po"

sys.path.insert(0, str(PATCH_DIR / ".opencode" / "skills" / "extract-text" / "scripts"))
import po_file  # noqa: E402 (same pipeline family; see R2 note)


def load_po_map():
    """(msgid) -> [(msgctxt, msgstr, flags, refs)]."""
    entries = [e for e in po_file.parse_po((PO_DIR / "ru.po").read_text(encoding="utf-8")) if e["msgid"]]
    m = defaultdict(list)
    for e in entries:
        m[e["msgid"]].append((e.get("msgctxt", ""), e.get("msgstr", ""), e.get("flags", []), e.get("refs", [])))
    return m


def load_index():
    """stable rows + per-(kind,source) ordered lists for neighbor lookup."""
    path = PATCH_DIR / "output" / "stable_index.json"
    if not path.exists():
        return [], {}
    rows = json.loads(path.read_text(encoding="utf-8"))
    groups = defaultdict(list)
    for r in rows:
        sid = r.get("stable_id", "")
        if "#" in sid:
            head, idx = sid.rsplit("#", 1)
            try:
                groups[head].append((int(idx), r))
            except ValueError:
                pass
    for head in groups:
        groups[head].sort()
    return rows, groups


def neighbors(groups: dict, po_map: dict, stable_id: str):
    """Prev/next texts (+RU) sharing the stable prefix."""
    if "#" not in stable_id:
        return None, None
    head, idx = stable_id.rsplit("#", 1)
    try:
        i = int(idx)
    except ValueError:
        return None, None
    lst = groups.get(head, [])
    pos = next((n for n, (k, _r) in enumerate(lst) if k == i), None)
    if pos is None:
        return None, None
    out = []
    for n in (pos - 1, pos + 1):
        if 0 <= n < len(lst):
            t = lst[n][1].get("text", "")
            ru = ""
            for _c, m, _f, _r in po_map.get(t, []):
                if m:
                    ru = m
                    break
            out.append((t, ru))
        else:
            out.append(None)
    return out[0], out[1]


def asset_of(refs: list) -> str:
    for r in refs:
        if r.startswith("translations/"):
            return r.split("/")[-1].replace(".yaml", "")
    return "?"


def kind_of(text: str, refs: list, ctxt: str = "") -> str:
    blob = text + " " + " ".join(refs)
    if any(k in blob for k in ("TalkToKlaudia", "Setup Quest", "GlowingHoleRevisit", "cleaning", "Bartending")):
        return "quest/fsm"
    if "speaker:" in ctxt or any(k in blob for k in ("dialogues/", "speaker:")):
        return "dialogue"
    return "ui"


def main() -> int:
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 100
    po_map = load_po_map()
    _rows, groups = load_index()

    auto, missing = [], []
    seen = set()
    for text, variants in po_map.items():
        if text in seen:
            continue
        seen.add(text)
        filled = [v for v in variants if v[1]]
        auto_v = [v for v in variants if "auto-normalized" in v[2]]
        if auto_v:
            auto.append((text, auto_v[0][1], auto_v[0][0], auto_v[0][3]))
        elif not filled:
            v = variants[0]
            missing.append((text, v[0], v[3]))

    # Stable ids per text for neighbor lookup (first registry row wins)
    sid_by_text = {}
    for head, lst in groups.items():
        for _i, r in lst:
            sid_by_text.setdefault(r.get("text", ""), head + "#" + str(_i))

    def row_html(n, text, proposed, ctxt, refs, tag):
        sid = sid_by_text.get(text, "")
        prev, nxt = neighbors(groups, po_map, sid) if sid else (None, None)

        def fmt(nb):
            if not nb:
                return "—"
            t, ru = nb
            return f"{html.escape(t[:90])}" + (f"<br><span class='ru'>→ {html.escape(ru[:90])}</span>" if ru else "")

        return (
            f"<tr><td><input type='checkbox' checked></td><td>{n}</td>"
            f"<td><span class='tag'>{tag}</span><br><span class='en'>{html.escape(text[:160])}</span><br>"
            f"<span class='ru'>→ {html.escape(proposed[:160]) if proposed else '<i>пусто — перевести</i>'}</span></td>"
            f"<td><span class='ctx'>{html.escape(ctxt)}<br>{html.escape(asset_of(refs))}<br>{html.escape(sid)}</span></td>"
            f"<td><span class='ctx'>▲ {fmt(prev)}<br>▼ {fmt(nxt)}</span></td></tr>"
        )

    h_auto = "".join(row_html(i + 1, t, p, c, r, "AUTO") for i, (t, p, c, r) in enumerate(auto[:limit]))
    rest = [m for m in missing if m[0] not in {t for t, _p, _c, _r in auto}]
    by_asset = defaultdict(list)
    for t, c, r in rest:
        by_asset[asset_of(r)].append((t, c, r))
    # dialogue assets first
    ordered = sorted(by_asset.items(), key=lambda kv: (0 if "dialog" in str(kv[1][:1]) else 1, kv[0]))
    h_missing, n = "", 0
    for asset, items in ordered:
        if n >= limit:
            break
        h_missing += f"<tr class='grp'><td colspan='5'>📁 {html.escape(asset)} ({len(items)})</td></tr>"
        for t, c, r in items[: max(1, limit // max(len(ordered), 1))]:
            if n >= limit:
                break
            n += 1
            h_missing += row_html(f"M{n}", t, "", c, r, kind_of(t, r, c))

    out = PATCH_DIR / "tmp" / "review_queue.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        f"""<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<title>review queue — перевод + ревью</title>
<style>
body{{font-family:Segoe UI,Arial,sans-serif;max-width:1200px;margin:0 auto;padding:20px;background:#14141c;color:#e8e8ef}}
h1,h2{{color:#EB83FF}} .note{{color:#888;font-size:13px}}
table{{border-collapse:collapse;width:100%;font-size:14px}} td,th{{border:1px solid #333;padding:6px 8px;vertical-align:top}}
th{{background:#1f1f2b}} .en{{color:#ffd166}} .ru{{color:#7CFC98}} .ctx{{color:#888;font-size:12px}}
.tag{{background:#2b6cb0;border-radius:4px;padding:1px 8px;font-size:12px}}
tr.grp td{{background:#1f1f2b;font-weight:700}}
input[type=checkbox]{{transform:scale(1.4)}}
</style></head><body>
<h1>Очередь ревью: {len(auto)} auto + {len(rest)} missing (показано {min(limit, len(rest))})</h1>
<p class="note">Секция AUTO — машинные подстановки по нормализации: подтвердить/поправить.
Секция missing — сгруппировано по ассетам (сценам), у каждой строки соседи сверху/снизу с их переводами.
Ответь номерами (A1.. / M1..) — применю в ru.po → .dat → QA.</p>
<h2>AUTO-normalized ({len(auto)})</h2>
<table><tr><th>✓</th><th>#</th><th>строка → предложение</th><th>контекст</th><th>соседи</th></tr>{h_auto}</table>
<h2>Missing по ассетам</h2>
<table><tr><th>✓</th><th>#</th><th>строка</th><th>контекст</th><th>соседи</th></tr>{h_missing}</table>
</body></html>""",
        encoding="utf-8",
    )
    print(f"review queue: {len(auto)} auto + {len(rest)} missing -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
