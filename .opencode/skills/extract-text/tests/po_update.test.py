#!/usr/bin/env python3
"""Tests for po_update.py — python .opencode/skills/extract-text/tests/po_update.test.py"""

import sys
import tempfile
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TEST_DIR.parent / "scripts"))
import po_file  # noqa: E402 (needs sys.path above)
import po_update as pu  # noqa: E402 (needs sys.path above)


def _e(msgid, ctxt="", msgstr="", refs=None):
    return {
        "msgid": msgid,
        "msgctxt": ctxt,
        "msgstr": msgstr,
        "refs": refs or [],
        "comments": [],
        "flags": [],
        "translator": [],
    }


def test_carry_and_new():
    pot = [_e("A", "ui"), _e("B", "ui")]
    po = [_e("A", "ui", "А", refs=["f1"])]
    merged, s = pu.merge_pot(po, pot)
    assert s["carried"] == 1 and s["new"] == 1 and s["obsolete"] == 0
    by_id = {e["msgid"]: e for e in merged}
    assert by_id["A"]["msgstr"] == "А"
    assert by_id["A"]["refs"] == []  # refs refreshed from POT
    assert by_id["B"]["msgstr"] == ""
    print("  OK: carried + new")


def test_vanished_text_kept_as_legacy():
    pot = [_e("A", "ui")]
    old = _e("Gone", "ui", "Ушло")
    merged, s = pu.merge_pot([_e("A", "ui", "А"), old], pot)
    assert s["legacy_kept"] == 1 and s["obsolete"] == 0
    by_id = {e["msgid"]: e for e in merged}
    assert by_id["Gone"]["msgstr"] == "Ушло" and not by_id["Gone"].get("obsolete")
    assert "legacy" in by_id["Gone"]["flags"]
    print("  OK: vanished text kept live as legacy (never #~)")


def test_retarget_across_ctxt():
    pot = [_e("Go", "speaker:Zed")]
    old = _e("Go", "ui", "Иди", refs=["translations/old.yaml"])
    old["translator"] = ["rich: <b>Иди</b>"]
    merged, s = pu.merge_pot([old], pot)
    assert s["retargeted"] == 1 and s["obsolete"] == 0
    assert len(merged) == 1
    assert merged[0]["msgctxt"] == "speaker:Zed"
    assert merged[0]["msgstr"] == "Иди"
    assert merged[0]["translator"] == ["rich: <b>Иди</b>"]
    print("  OK: same-text translation rescued across ctxt change")


def test_empty_translation_not_obsolete():
    pot = [_e("A", "ui")]
    po = [_e("A", "ui", ""), _e("Gone", "ui", "")]
    merged, s = pu.merge_pot(po, pot)
    assert s["obsolete"] == 0 and len(merged) == 1
    print("  OK: empty entries dropped silently")


def test_cli_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "po").mkdir()
        (work / "po" / "template.pot").write_text(
            po_file.render_po([_e("A", "ui"), _e("B", "ui")], []), encoding="utf-8"
        )
        (work / "po" / "de.po").write_text(
            po_file.render_po([_e("A", "ui", "Ä", refs=["old"])], ["# de"]), encoding="utf-8"
        )
        old = pu.PATCH_DIR
        old_argv = sys.argv
        pu.PATCH_DIR = work
        try:
            sys.argv = ["po_update.py", "de"]
            assert pu.main() == 0
        finally:
            pu.PATCH_DIR = old
            sys.argv = old_argv
        back = [e for e in po_file.parse_po((work / "po" / "de.po").read_text(encoding="utf-8")) if e["msgid"]]
        assert {e["msgid"]: e["msgstr"] for e in back} == {"A": "Ä", "B": ""}
        assert (work / "po" / "de.po.bak").exists()
    print("  OK: CLI roundtrip with backup")


def test_translator_comments_survive():
    pot = [_e("A", "ui")]
    old = _e("A", "ui", "А", refs=["f1"])
    old["translator"] = ["rich: <b>А</b>", "note for humans"]
    merged, _ = pu.merge_pot([old], pot)
    out = pu.render_merged(merged, [])
    assert "# rich: <b>А</b>" in out and "# note for humans" in out
    back = [e for e in po_file.parse_po(out) if e["msgid"]]
    assert back[0]["translator"] == ["rich: <b>А</b>", "note for humans"]
    assert back[0]["msgstr"] == "А"
    print("  OK: translator comments survive merge+render")


if __name__ == "__main__":
    tests = [
        test_carry_and_new,
        test_vanished_text_kept_as_legacy,
        test_retarget_across_ctxt,
        test_empty_translation_not_obsolete,
        test_cli_roundtrip,
        test_translator_comments_survive,
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
