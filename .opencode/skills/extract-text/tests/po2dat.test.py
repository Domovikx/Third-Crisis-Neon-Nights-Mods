#!/usr/bin/env python3
"""Tests for po2dat.py — python .opencode/skills/extract-text/tests/po2dat.test.py."""

import json
import sys
import tempfile
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TEST_DIR.parent / "scripts"))
import po2dat  # noqa: E402 (needs sys.path above)


def _po(entries: list) -> str:
    out = ['msgid ""', 'msgstr ""', ""]
    for item in entries:
        msgid, ctxt, msgstr = item[0], item[1], item[2]
        tr_comments = item[3] if len(item) > 3 else []
        for c in tr_comments:
            out.append(f"# {c}")
        if ctxt:
            out.append(f'msgctxt "{ctxt}"')
        out.append(f'msgid "{msgid}"')
        out.append(f'msgstr "{msgstr}"')
        out.append("")
    return "\n".join(out)


def _pot(rich: dict) -> str:
    out = ['msgid ""', 'msgstr ""', ""]
    for msgid, r in rich.items():
        out.append(f"#. rich_text: {r}")
        out.append('msgctxt "ui"')
        out.append(f'msgid "{msgid}"')
        out.append('msgstr ""')
        out.append("")
    return "\n".join(out)


def _run(po_text: str, pot_text: str = ""):
    """Build .dat rows from fake PO + fake POT. Returns (rows, report)."""
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "po").mkdir()
        (work / "po" / "ru.po").write_text(po_text, encoding="utf-8")
        (work / "po" / "template.pot").write_text(pot_text, encoding="utf-8")
        old = po2dat.PATCH_DIR
        po2dat.PATCH_DIR = work
        try:
            return po2dat.build_dat("ru")
        finally:
            po2dat.PATCH_DIR = old


def test_basic_and_rich():
    po_text = _po([("Hi", "ui", "Привет", ["rich: <b>Привет</b>"]), ("Bye", "ui", "")])
    rows, r = _run(po_text, _pot({"Hi": "<b>Hi</b>"}))
    assert len(rows) == 1
    assert rows[0] == {"t": "Hi", "x": "Привет", "r": "<b>Hi</b>", "rt": "<b>Привет</b>"}
    assert r["filled"] == 1
    print("  OK: basic compile with POT rich + # rich: override")


def test_rich_only_row():
    # Untranslated but POT-styled: game remaps to rich form (row carries r only).
    rows, r = _run(_po([("Wow", "ui", "")]), _pot({"Wow": "<i>Wow</i>"}))
    assert len(rows) == 1 and rows[0] == {"t": "Wow", "x": "", "r": "<i>Wow</i>"}
    assert r["rich_only"] == 1
    # No rich, no translation: dropped entirely.
    rows, _ = _run(_po([("Meh", "ui", "")]), _pot({}))
    assert rows == []
    print("  OK: rich-only rows ship, bare empties dropped")


def test_dupes_first_wins():
    po_text = (
        '#: translations/b.yaml\nmsgctxt "ui"\nmsgid "Go"\nmsgstr "Иди"\n\n'
        '#: translations/a.yaml\nmsgctxt "ui"\nmsgid "Go"\nmsgstr "Ступай"\n\n'
    )
    rows, r = _run(po_text, _pot({}))
    assert len(rows) == 1 and rows[0]["x"] == "Ступай", "earliest ref file wins"
    assert len(r["dupes"]) == 1
    print("  OK: dupe msgstr divergence reported, earliest-ref wins")


def test_legacy_flag():
    po_text = (
        "#: translations/raw/a.yaml\n#. legacy: migrated from skipped YAML\n"
        '#, legacy\nmsgctxt "ui"\nmsgid "Evt2"\nmsgstr "Рус"\n\n'
    )
    rows, r = _run(po_text, _pot({}))
    by_t = {row["t"]: row for row in rows}
    assert by_t["Evt2"]["x"] == "Рус", "legacy-with-translation must survive"
    assert by_t["Evt2"].get("sk") is True, "legacy rows flagged for QA"
    print("  OK: legacy flag carried into sk")


def test_write_read_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "patch_ru.dat"
        po2dat.write_dat([{"t": "A", "x": "Б"}, {"t": "C", "x": "Д", "r": "<i>C</i>"}], out)
        lines = out.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2
        assert json.loads(lines[0]) == {"t": "A", "x": "Б"}
    print("  OK: dat write/read roundtrip")


def test_gated_auto_normalized():
    po_text = (
        'msgctxt "ui"\nmsgid "Hi"\nmsgstr "Привет"\n\n'
        '#, fuzzy, auto-normalized\nmsgctxt "ui"\nmsgid "Hi!"\nmsgstr "Привет"\n\n'
    )
    rows, r = _run(po_text, _pot({}))
    by_t = {row["t"]: row for row in rows}
    assert "Hi" in by_t and "Hi!" not in by_t, "gated entries stay out until confirmed"
    assert r["gated_auto_normalized"] == 1
    print("  OK: auto-normalized gated from shipping")


if __name__ == "__main__":
    tests = [
        test_basic_and_rich,
        test_rich_only_row,
        test_dupes_first_wins,
        test_legacy_flag,
        test_write_read_roundtrip,
        test_gated_auto_normalized,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:
            print(f"  FAIL: {t.__name__}: {e}")
            import traceback

            traceback.print_exc()
            failed += 1
    print(f"\n{len(tests) - failed}/{len(tests)} tests passed")
    sys.exit(1 if failed else 0)
