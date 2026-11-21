#!/usr/bin/env python3
"""Tests for qa_translate.py — python .opencode/skills/translate-qa/tests/qa_translate.test.py"""

import json
import sys
import tempfile
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TEST_DIR.parent / "scripts"))
import qa_translate as qa  # noqa: E402 (needs sys.path above)


def _fake_po_and_dat(work: Path):
    (work / "po").mkdir(parents=True)
    (work / "po" / "template.pot").write_text(
        "#: translations/dialogues/1.yaml [dlg:1#0]\n"
        'msgctxt "speaker:Z"\nmsgid "Hi"\nmsgstr ""\n\n'
        "#: translations/dialogues/1.yaml [dlg:1#1]\n"
        'msgctxt "speaker:Z"\nmsgid "Bye"\nmsgstr ""\n\n'
        "#: translations/raw/a.yaml [raw:a#0]\n"
        'msgctxt "ui"\nmsgid "Ok"\nmsgstr ""\n\n',
        encoding="utf-8",
    )
    (work / "runtime").mkdir(parents=True)
    rows = [
        {"t": "Hi", "x": "Привет", "r": "<b>Hi</b>", "rt": "<b>Привет</b>"},
        {"t": "Bye", "x": "Bye"},
        {"t": "Ok", "x": "Ok", "sk": True},
    ]
    (work / "runtime" / "patch_ru.dat").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8"
    )


def test_rules():
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        _fake_po_and_dat(work)
        old_patch = qa.PATCH_DIR
        qa.PATCH_DIR = work
        try:
            # point module dirs at the fake tree
            qa.PO_DIR = work / "po"
            summary, findings = qa.check("ru")
        finally:
            qa.PATCH_DIR = old_patch
            import importlib as _il

            _il.reload(qa)
    by_rule = {}
    for lv, rule, rel, text, detail in findings:
        by_rule.setdefault(rule, []).append((lv, text))
    assert summary["total"] == 3, summary
    assert summary["filled"] == 3, summary  # Hi + Bye + Ok(legacy triage still applied)
    assert "copy-through" in by_rule  # Bye == Bye
    assert "empty-dialogue" not in by_rule  # Hi filled; Bye is copy-through not empty
    assert not any(t == "Ok" for _, t in by_rule.get("copy-through", [])), "legacy exempt"
    assert summary["errors"] >= 1
    print("  OK: all rules fire correctly")


def test_cyr_ratio():
    assert qa.cyr_ratio("Привет мир") == 1.0
    assert qa.cyr_ratio("Hello world") == 0.0
    assert qa.cyr_ratio("АБВab") == 0.6
    assert qa.cyr_ratio("123") == 1.0
    print("  OK: cyrillic ratio")


def test_render():
    summary = {"total": 1, "filled": 1, "coverage": 100.0, "errors": 0, "warnings": 1, "by_speaker": {}, "by_dir": {}}
    out = qa.render_html(summary, [("warning", "latin-leftover", "f", "t", "d")])
    assert out.startswith("<!DOCTYPE html>") and out.rstrip().endswith("</html>")
    assert "latin-leftover" in out
    print("  OK: dashboard renders")


def test_no_translate_exempt():
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "po").mkdir(parents=True)
        (work / "po" / "template.pot").write_text(
            '#: [dlg:1#0]\n#. triage: manual\n#, no-translate\nmsgctxt "speaker:Z"\nmsgid "...!"\nmsgstr ""\n\n',
            encoding="utf-8",
        )
        (work / "runtime").mkdir(parents=True)
        (work / "runtime" / "patch_ru.dat").write_text("", encoding="utf-8")
        old_patch = qa.PATCH_DIR
        qa.PATCH_DIR = work
        try:
            qa.PO_DIR = work / "po"
            summary, findings = qa.check("ru")
        finally:
            qa.PATCH_DIR = old_patch
            import importlib as _il

            _il.reload(qa)
    assert summary["errors"] == 0, findings
    assert not [f for f in findings if f[1] == "empty-dialogue"]
    print("  OK: no-translate triage exempt from empty-dialogue")


if __name__ == "__main__":
    tests = [test_rules, test_cyr_ratio, test_render, test_no_translate_exempt]
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
