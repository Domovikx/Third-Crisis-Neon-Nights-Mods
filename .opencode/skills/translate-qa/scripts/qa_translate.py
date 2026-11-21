#!/usr/bin/env python3
"""qa_translate.py — Offline translation QA without launching the game.

Reads po/template.pot (work queue) + runtime/patch_<lang>.dat (deployed truth):

  1. coverage (total / per dir / per speaker via msgctxt)
  2. copy-through in dialogues (x == t, non-legacy) -> error
  3. rich tag imbalance (r vs rt) -> error
  4. latin leftovers in RU (<30% cyrillic, len>10, non-legacy) -> warning
  5. duplicate (msgid, msgctxt) with different msgstr in PO -> error
  6. empty x for dialogue entries present in POT -> error

Legacy triage rows (sk flag, from skipped YAML) are exempt from 2/4/6.

Run: python .opencode/skills/translate-qa/scripts/qa_translate.py [--out tmp/qa.html] [--lang ru]
Exit code 1 when errors are present (CI-ready).
"""

import html
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
PATCH_DIR = SKILL_DIR.parent.parent.parent
PO_DIR = PATCH_DIR / "po"

sys.path.insert(0, str(PATCH_DIR / ".opencode" / "skills" / "extract-text" / "scripts"))
import po_file  # noqa: E402 (same pipeline family; see R2 note)

CYR_RX = re.compile(r"[А-Яа-яЁё]")
LAT_RX = re.compile(r"[A-Za-z]")
TAG_RX = re.compile(r"<[^>]+>")


def load_pot():
    """Parse template.pot -> [(msgid, msgctxt, refs)]."""
    entries = [e for e in po_file.parse_po((PO_DIR / "template.pot").read_text(encoding="utf-8")) if e["msgid"]]
    return entries


def load_dat(lang: str):
    """Parse patch_<lang>.dat -> {text: row} (first wins, like the C# loader)."""
    rows = {}
    fp = PATCH_DIR / "runtime" / f"patch_{lang}.dat"
    if not fp.exists():
        return rows
    for line in fp.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("t") and r["t"] not in rows:
            rows[r["t"]] = r
    return rows


def speaker_of(ctxt: str) -> str:
    return ctxt.split(":", 1)[1] if ctxt.startswith("speaker:") else ""


def sourcedir_of(refs: list) -> str:
    for r in refs:
        if r.startswith("translations/"):
            parts = r.split("/")
            return parts[1] if len(parts) > 1 else r
    for r in refs:
        # New stable refs: [dlg:..], [bundle:..], [set:..], [fsm:..], [spk:..].
        # (raw-refs are no longer emitted; ref-less entries group as "ui".)
        if r.startswith("[") and r.endswith("]"):
            inner = r[1:-1]
            kind = inner.split(":", 1)[0]
            if kind in ("dlg", "bundle", "set", "fsm", "spk", "raw"):
                return kind
    return "ui" if not refs else "?"


def cyr_ratio(s: str) -> float:
    letters = [c for c in s if c.isalpha()]
    if not letters:
        return 1.0
    return sum(1 for c in letters if CYR_RX.match(c)) / len(letters)


def check(lang: str = "ru"):
    """Run all checks. Returns (summary, findings)."""
    findings = []  # (level, rule, rel, text, detail)
    pot = load_pot()
    dat = load_dat(lang)

    total = len(pot)
    filled = 0
    by_speaker = defaultdict(lambda: [0, 0])
    by_dir = defaultdict(lambda: [0, 0])
    seen_po_keys = defaultdict(set)  # (msgid, msgctxt) -> {msgstr}

    for e in pot:
        text, ctxt = e["msgid"], e.get("msgctxt", "")
        rel = next(
            (r for r in e.get("refs", []) if r.startswith("translations/") or (r.startswith("[") and r.endswith("]"))),
            "po",
        )
        row = dat.get(text)
        tr = (row or {}).get("x", "")
        sk = bool((row or {}).get("sk"))
        if tr:
            filled += 1
        d = sourcedir_of(e.get("refs", []))
        by_dir[d][0] += 1
        if tr:
            by_dir[d][1] += 1
        sp = speaker_of(ctxt)
        if sp:
            by_speaker[sp][0] += 1
            if tr:
                by_speaker[sp][1] += 1
        seen_po_keys[(text, ctxt)].add(e.get("msgstr", ""))
        dlg = bool(sp) or d == "dialogues"

        if sk or "no-translate" in e.get("flags", []):
            continue
        if dlg and not tr:
            findings.append(("error", "empty-dialogue", rel, text, "пустой перевод в диалоге"))
        if dlg and tr and tr == text:
            findings.append(("error", "copy-through", rel, text, "перевод совпадает с оригиналом"))
        r, rt = (row or {}).get("r", ""), (row or {}).get("rt", "")
        if r and rt:
            tags = TAG_RX.findall(r)
            ttags = TAG_RX.findall(rt)
            if [t.split()[0] for t in tags] != [t.split()[0] for t in ttags]:
                findings.append(("error", "tag-imbalance", rel, text, f"{tags} vs {ttags}"))
        # Latin-leftover check is Cyrillic-script specific (ru; extend per script family).
        if lang == "ru" and tr and len(tr) > 10 and cyr_ratio(tr) < 0.3 and LAT_RX.search(tr):
            findings.append(("warning", "latin-leftover", rel, text, tr[:80]))

    for (text, ctxt), variants in seen_po_keys.items():
        if len(variants) > 1:
            findings.append(("error", "duplicate-po", f"po/{lang}.po", text, f"{ctxt}: {sorted(variants)}"))

    summary = {
        "total": total,
        "filled": filled,
        "coverage": 100.0 * filled / max(total, 1),
        "errors": sum(1 for f in findings if f[0] == "error"),
        "warnings": sum(1 for f in findings if f[0] == "warning"),
        "by_speaker": {k: (v[1], v[0]) for k, v in sorted(by_speaker.items(), key=lambda x: -x[1][0])},
        "by_dir": dict(by_dir),
    }
    return summary, findings


def render_html(summary: dict, findings: list) -> str:
    def esc(s):
        return html.escape(str(s or ""), quote=False)

    cards = (
        f'<div class="card"><div class="num">{summary["coverage"]:.1f}%</div><div class="lbl">покрытие</div></div>'
        f'<div class="card"><div class="num">{summary["filled"]:,} / {summary["total"]:,}</div>'
        '<div class="lbl">заполнено</div></div>'
        f'<div class="card bad"><div class="num">{summary["errors"]}</div><div class="lbl">errors</div></div>'
        f'<div class="card warn"><div class="num">{summary["warnings"]}</div><div class="lbl">warnings</div></div>'
    ).replace(",", " ")
    bars = "".join(
        f'<div class="row"><span class="name">{esc(s)}</span>'
        f'<div class="bar" style="width:{f / max(t, 1) * 100:.0f}%"></div>'
        f'<span class="cnt">{f}/{t}</span></div>'
        for s, (f, t) in list(summary["by_speaker"].items())[:20]
    )
    dirs = "".join(
        f"<tr><td>{esc(d)}</td><td>{f}/{t}</td><td>{100.0 * f / max(t, 1):.0f}%</td></tr>"
        for d, (t, f) in sorted(summary["by_dir"].items())
    )
    rows = "".join(
        f'<tr class="{lv}"><td>{lv}</td><td>{esc(rule)}</td><td>{esc(rel)}</td>'
        f"<td>{esc(text[:100])}</td><td>{esc(detail[:120])}</td></tr>"
        for lv, rule, rel, text, detail in findings
    )
    return f"""<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<title>translate-qa — дашборд</title>
<style>
body{{font-family:Segoe UI,Arial,sans-serif;max-width:1200px;margin:0 auto;padding:20px;background:#14141c;color:#e8e8ef}}
h1,h2{{color:#EB83FF}} .cards{{display:flex;gap:12px;flex-wrap:wrap}}
.card{{background:#1f1f2b;border-radius:10px;padding:14px 20px;min-width:130px}}
.bad .num{{color:#ff6b6b}} .warn .num{{color:#ffd166}}
.num{{font-size:26px;font-weight:700}} .lbl{{color:#999}}
.row{{display:flex;align-items:center;gap:8px;margin:3px 0}} .name{{width:110px}}
.bar{{height:14px;background:#EB83FF;border-radius:4px}} .cnt{{color:#999}}
table{{border-collapse:collapse;width:100%;font-size:13px}} td,th{{border:1px solid #333;padding:4px 8px;text-align:left}}
tr.error td:first-child{{color:#ff6b6b;font-weight:700}} tr.warning td:first-child{{color:#ffd166}}
input{{width:100%;padding:8px;margin:8px 0;background:#1f1f2b;border:1px solid #444;color:#fff;border-radius:6px}}
.sec{{margin-top:30px}}
</style></head><body>
<h1>translate-qa — качество перевода без запуска игры</h1>
<div class="cards">{cards}</div>
<div class="sec"><h2>Покрытие по персонажам (топ-20)</h2>{bars}</div>
<div class="sec"><h2>Покрытие по папкам</h2>
<table><tr><th>папка</th><th>заполнено</th><th>%</th></tr>{dirs}</table></div>
<div class="sec"><h2>Находки ({len(findings)})</h2>
<input id="q" placeholder="Фильтр…">
<table id="ft"><tr><th>уровень</th><th>правило</th><th>файл</th><th>текст</th><th>детали</th></tr>{rows}</table></div>
<script>
const Q=document.getElementById('q'),T=document.getElementById('ft');
const all=[...T.rows].slice(1);
Q.addEventListener('input',e=>{{const f=e.target.value.toLowerCase();
for(const r of all){{r.style.display=r.innerText.toLowerCase().includes(f)?'':'none';}}}});
</script></body></html>"""


def main() -> int:
    lang = "ru"
    out = None
    if "--lang" in sys.argv:
        lang = sys.argv[sys.argv.index("--lang") + 1]
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else PATCH_DIR / "tmp" / "qa.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    summary, findings = check(lang)
    out.write_text(render_html(summary, findings), encoding="utf-8")
    print(
        f"QA[{lang}]: {summary['filled']}/{summary['total']} ({summary['coverage']:.1f}%), "
        f"errors={summary['errors']}, warnings={summary['warnings']} -> {out}",
        file=sys.stderr,
    )
    for lv, rule, rel, text, detail in findings:
        if lv == "error":
            print(f"  ERROR [{rule}] {rel} :: {text[:70]!r} :: {detail[:70]}", file=sys.stderr)
    return 1 if summary["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
