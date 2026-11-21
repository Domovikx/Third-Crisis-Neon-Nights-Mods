#!/usr/bin/env python3
"""Tests for pipeline-common text_filters — python .opencode/skills/pipeline-common/tests/text_filters.test.py"""

import sys
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TEST_DIR.parent / "scripts"))
import text_filters as tf  # noqa: E402 (needs sys.path above)


def test_skip_raw_prefixes():
    for s in [
        "line_1",
        "line_27",
        "expressions/smile",
        "separatedexpressions/a",
        "Poses/idle",
        "expressionadditive/x",
        "p>xo123",
        "Other Dialogue Presets",
        "Zoey Dialogue Presets",
        "_PresetFoo",
        "Dialogue Presets Bar",
        "Char_Zoey",
        "Apl_test",
    ]:
        assert tf._is_skip_prefix(s), f"should skip: {s}"
    for s in ["Continue", "Hello there!", "", "line", "Char", "Back", "50%"]:
        assert not tf._is_skip_prefix(s), f"false positive on: {s}"
    print("  OK: _is_skip_prefix (positives + negatives)")


def test_known_non_speakers():
    for s in [
        "GlowingHole",
        "GlowingHoleKeys/",
        "Narrator",
        "Confirm",
        "Other Dialogue Presets",
        "Zoey Dialogue Presets",
        "Simon",
    ]:
        assert s in tf.KNOWN_NON_SPEAKERS, f"missing non-speaker: {s}"
    for s in ["Zoey", "Sarah", "Max", "", "Intercom"]:
        assert s not in tf.KNOWN_NON_SPEAKERS, f"false positive on: {s}"
    print("  OK: KNOWN_NON_SPEAKERS (members + non-members)")


def test_strip_rich():
    assert tf._strip_rich("<color=red>Hello</color>") == "Hello"
    assert tf._strip_rich("plain") == "plain"
    assert tf._strip_rich("  <b>sp</b>  ") == "sp"
    assert tf._strip_rich("") == ""
    assert tf._strip_rich("<i>(Ah-...!)</i>") == "(Ah-...!)"
    assert tf._RICH_TAG_RX.sub("", "<color=#B867FF>Hi</color>").strip() == "Hi"
    print("  OK: _strip_rich (+ _RICH_TAG_RX)")


def test_asset_name_detection():
    """Mirror of extract-text test_asset_name_detection (shared contract)."""
    for s in ["NNHsvRenderer", "EventSystem", "NodeLink2", "SpotterUI", "ItemPickup", "UISoftMask", "AMSUISoftMask"]:
        assert tf._is_asset_name(s), f"should detect asset: {s}"
    for s in ["Continue", "Back", "Settings", "New Game", "Dialogue Log", "Hide", "Yes", "50%", "Zoey"]:
        assert not tf._is_asset_name(s), f"false positive on: {s}"
    print("  OK: asset-name detection (no UI false positives)")


def test_garbage_detection():
    """Mirror of extract-text test_garbage_detection (shared contract)."""
    for s in ["Bff?D", "S5?d", "D?p[", "%IR", "%(EA", "back\\slash"]:
        assert tf._is_garbage_fragment(s), f"should detect garbage: {s}"
    for s in ["Really?", "Hello world", "50%", "Volume 50%", "What?!"]:
        assert not tf._is_garbage_fragment(s), f"false positive on: {s}"
    print("  OK: garbage-fragment detection")


def test_auto_triage():
    """Mirror of extract-text test_auto_triage (shared contract)."""
    preset = tf._auto_triage("NNHoverInteract")
    assert preset == {"translation": "NNHoverInteract", "skip_translation": True}
    assert tf._auto_triage("New Game") == {}
    assert tf._auto_triage("Continue") == {}
    garbage = tf._auto_triage("Bff?D")
    assert garbage == {"translation": "Bff?D", "skip_translation": True}
    print("  OK: auto-triage presets")


def test_pct_legit_rx():
    assert tf._PCT_LEGIT_RX.search("50%")
    assert tf._PCT_LEGIT_RX.search("Volume 50%")
    assert not tf._PCT_LEGIT_RX.search("%IR")
    assert not tf._PCT_LEGIT_RX.search("100 things")
    print("  OK: _PCT_LEGIT_RX (legit trailing percent only)")


def test_asset_affixes_shape():
    assert "Renderer" in tf._ASSET_SUFFIXES and "UI" in tf._ASSET_SUFFIXES
    assert tuple(tf._ASSET_PREFIXES) == ("NN", "AMS")
    assert isinstance(tf.SKIP_RAW_PREFIXES, tuple) and "line_" in tf.SKIP_RAW_PREFIXES
    print("  OK: affix/prefix table shapes")


if __name__ == "__main__":
    tests = [
        test_skip_raw_prefixes,
        test_known_non_speakers,
        test_strip_rich,
        test_asset_name_detection,
        test_garbage_detection,
        test_auto_triage,
        test_pct_legit_rx,
        test_asset_affixes_shape,
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
