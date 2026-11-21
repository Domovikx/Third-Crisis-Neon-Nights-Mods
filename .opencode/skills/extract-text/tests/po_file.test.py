#!/usr/bin/env python3
"""Tests for po_file.py and prefill_po.py — python .opencode/skills/extract-text/po_file.test.py"""

import sys
import tempfile
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TEST_DIR.parent / "scripts"))
import po_file  # noqa: E402 (needs sys.path above)


def test_escape_roundtrip():
    for s in ['say "hi"', "a\\b", "l1\nl2", "a\rb", "a\tb", "", "Юникод — тест"]:
        assert po_file.po_unescape(po_file.po_escape(s)) == s, s
    print("  OK: escape roundtrip")


def test_parse_single_line():
    entries = po_file.parse_po('#: f.yaml\n#: [dlg:1#0]\n#. rich_text: x\nmsgctxt "ui"\nmsgid "Hi"\nmsgstr "Привет"\n')
    assert len(entries) == 1
    e = entries[0]
    assert e["msgid"] == "Hi" and e["msgctxt"] == "ui" and e["msgstr"] == "Привет"
    assert e["refs"] == ["f.yaml", "[dlg:1#0]"]
    assert e["comments"] == ["rich_text: x"]
    print("  OK: single-line parse")


def test_parse_ref_with_spaces():
    # Stable refs carry speaker names with spaces — one #: line is one
    # ref, never split (regression: split corrupted them into fragments
    # on every parse->render round-trip).
    entries = po_file.parse_po('#: [spk:Cartel Guy]\nmsgid "Cartel Guy"\nmsgstr ""\n')
    assert entries[0]["refs"] == ["[spk:Cartel Guy]"]
    back = po_file.parse_po(po_file.render_po(entries, []))
    assert back[0]["refs"] == ["[spk:Cartel Guy]"]
    print("  OK: spaced ref roundtrip")


def test_parse_multiline_and_flags():
    text = 'msgctxt "speaker:Zoey"\nmsgid ""\n"Hello "\n"world"\nmsgstr ""\n"Привет "\n"мир"\n#, fuzzy\n'
    # Note: flags line after msgstr still attaches (translator tools do this)
    entries = po_file.parse_po(text)
    assert len(entries) == 1
    assert entries[0]["msgid"] == "Hello world"
    assert entries[0]["msgstr"] == "Привет мир"
    assert "fuzzy" in entries[0]["flags"]
    print("  OK: multiline + flags parse")


def test_parse_header_skipped_by_caller():
    entries = po_file.parse_po('msgid ""\nmsgstr "Language: ru\\n"\n\nmsgid "A"\nmsgstr "Б"\n')
    assert len(entries) == 2
    assert entries[0]["msgid"] == ""
    print("  OK: header entry parsed (caller filters)")


def test_render_single_newline():
    out = po_file.render_po([{"msgid": "A", "msgctxt": "", "msgstr": "Б", "refs": [], "comments": []}], [])
    assert out.endswith("\n") and not out.endswith("\n\n")
    back = po_file.parse_po(out)
    assert back[0]["msgid"] == "A" and back[0]["msgstr"] == "Б"
    print("  OK: render roundtrip")


def test_prefill_exact_and_report():
    import prefill_po as pre

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "translations" / "dialogues").mkdir(parents=True)
        (work / "translations" / "dialogues" / "1.yaml").write_text(
            '- text: "Hi"\n  translation: "Привет"\n  speaker: "Z"\n\n'
            '- text: "Bye"\n  translation: ""\n  speaker: "Z"\n\n'
            '- text: "Skip"\n  translation: "Skip"\n  skip_translation: true\n\n',
            encoding="utf-8",
        )
        old_patch, old_pot, old_ru = pre.PATCH_DIR, pre.POT_PATH, pre.RU_PATH
        pre.PATCH_DIR = work
        try:
            import potgen

            old_potgen = potgen.PATCH_DIR
            potgen.PATCH_DIR = work
            try:
                catalog, _ = potgen.build_pot()
                assert len(catalog) == 2, catalog.keys()  # Skip excluded
                # Fake a POT file from the catalog
                (work / "po").mkdir(exist_ok=True)
                pre.POT_PATH = work / "po" / "template.pot"
                pre.RU_PATH = work / "po" / "ru.po"
                pre.POT_PATH.write_text(potgen.render_pot(catalog), encoding="utf-8")
                entries, r = pre.build_ru_po()
                assert r["total"] == 2
                assert r["exact"] == 1
                by_id = {e["msgid"]: e for e in entries}
                assert by_id["Hi"]["msgstr"] == "Привет"
                assert by_id["Bye"]["msgstr"] == ""
                assert len(r["missing"]) == 1
                assert r["orphans"] == []
            finally:
                potgen.PATCH_DIR = old_potgen
        finally:
            pre.PATCH_DIR, pre.POT_PATH, pre.RU_PATH = old_patch, old_pot, old_ru
    print("  OK: prefill exact/missing/skip on tmp corpus")


def test_prefill_conflict_and_fuzzy():
    import prefill_po as pre

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "translations" / "dialogues").mkdir(parents=True)
        (work / "translations" / "raw").mkdir(parents=True)
        (work / "translations" / "dialogues" / "1.yaml").write_text(
            '- text: "Same"\n  translation: "Один"\n\n', encoding="utf-8"
        )
        (work / "translations" / "raw" / "a.yaml").write_text(
            '- text: "Same"\n  translation: "Два"\n\n', encoding="utf-8"
        )
        (work / "translations" / "dialogues" / "2.yaml").write_text(
            '- text: "Drift"\n  translation: "Дрейф"\n  speaker: "Z"\n\n', encoding="utf-8"
        )
        old_patch, old_pot, old_ru = pre.PATCH_DIR, pre.POT_PATH, pre.RU_PATH
        pre.PATCH_DIR = work
        try:
            import potgen

            old_potgen = potgen.PATCH_DIR
            potgen.PATCH_DIR = work
            try:
                catalog, _ = potgen.build_pot()
                (work / "po").mkdir(exist_ok=True)
                pre.POT_PATH = work / "po" / "template.pot"
                pre.RU_PATH = work / "po" / "ru.po"
                pre.POT_PATH.write_text(potgen.render_pot(catalog), encoding="utf-8")
                # Simulate context drift: POT has Drift without speaker
                entries, r = pre.build_ru_po()
                # "Same"/ui exists twice with different RU -> conflict, left empty
                same = [e for e in entries if e["msgid"] == "Same"]
                assert len(same) == 1 and same[0]["msgstr"] == ""
                assert len(r["conflicts"]) == 1
            finally:
                potgen.PATCH_DIR = old_potgen
        finally:
            pre.PATCH_DIR, pre.POT_PATH, pre.RU_PATH = old_patch, old_pot, old_ru
    print("  OK: prefill conflict left empty + reported")


def test_prefill_auto_normalized():
    import prefill_po as pre

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "translations" / "dialogues").mkdir(parents=True)
        (work / "translations" / "dialogues" / "1.yaml").write_text(
            '- text: "Wake up, tough!"\n  translation: "Проснись, крепыш!"\n\n', encoding="utf-8"
        )
        (work / "translations" / "raw").mkdir(parents=True)
        (work / "translations" / "raw" / "a.yaml").write_text(
            '- text: "000 Wake up tough 2"\n  translation: ""\n\n', encoding="utf-8"
        )
        old_patch, old_pot, old_ru = pre.PATCH_DIR, pre.POT_PATH, pre.RU_PATH
        pre.PATCH_DIR = work
        try:
            import potgen

            old_potgen = potgen.PATCH_DIR
            potgen.PATCH_DIR = work
            try:
                catalog, _ = potgen.build_pot()
                (work / "po").mkdir(exist_ok=True)
                pre.POT_PATH = work / "po" / "template.pot"
                pre.RU_PATH = work / "po" / "ru.po"
                pre.POT_PATH.write_text(potgen.render_pot(catalog), encoding="utf-8")
                entries, r = pre.build_ru_po()
                auto = [e for e in entries if "auto-normalized" in e.get("flags", [])]
                assert len(auto) == 1, [e["msgid"] for e in auto]
                assert auto[0]["msgid"] == "000 Wake up tough 2"
                assert auto[0]["msgstr"] == "Проснись, крепыш!"
                assert len(r["auto_normalized"]) == 1
            finally:
                potgen.PATCH_DIR = old_potgen
        finally:
            pre.PATCH_DIR, pre.POT_PATH, pre.RU_PATH = old_patch, old_pot, old_ru
    print("  OK: prefill auto-normalizes stripped variants")


if __name__ == "__main__":
    tests = [
        test_escape_roundtrip,
        test_parse_single_line,
        test_parse_ref_with_spaces,
        test_parse_multiline_and_flags,
        test_parse_header_skipped_by_caller,
        test_render_single_newline,
        test_prefill_exact_and_report,
        test_prefill_conflict_and_fuzzy,
        test_prefill_auto_normalized,
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
