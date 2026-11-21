#!/usr/bin/env python3
"""Tests for translate_local.py (run: python <this file>)."""

import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SKILL_DIR / "scripts"))
sys.path.insert(0, str(SKILL_DIR.parent.parent / "extract-text" / "scripts"))
import translate_local as T  # noqa: E402

passed = failed = 0


def check(cond, msg):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"FAIL: {msg}")


# triage: garbage without LLM
check(T.triage("RestrictSaves", "ru") == "RestrictSaves", "camel copy")
check(T.triage("...", "ru") == "...", "punct copy")
check(T.triage("v 0.4.0-a17", "ru") == "v 0.4.0-a17", "version copy")
check(T.triage("Привет", "ru") == "Привет", "already ru copy")
check(T.triage("", "ru") == "", "empty copy")
check(T.triage("New Game", "ru") is None, "UI to LLM")
check(T.triage("OK", "ru") == "OK", "code token copy")
check(T.triage("Off", "ru") is None, "Off to LLM")
check(T.triage("? 8fA", "ru") == "? 8fA", "prefixed garbage copy")
check(T.triage("-#YA", "ru") == "-#YA", "hash token copy")
check(T.triage("- later...", "ru") is None, "dashed phrase to LLM")
check(T.triage("537d8372-b666-49a2-890c-9597ad5e94a1", "ru") == "537d8372-b666-49a2-890c-9597ad5e94a1", "uuid copy")
check(T.triage("Yesss...!~", "ru") is None, "moan to LLM")
check(T.triage("handlesOut must be same", "ru") is None, "mixed to LLM")

# parse numbered response
check(T.parse_response("1. Да\n2. Нет\n", 2) == ["Да", "Нет"], "parse ok")
check(T.parse_response("1) Да\n2) Нет\n", 2) == ["Да", "Нет"], "parse paren")
check(T.parse_response("1. Да\n", 2) is None, "parse count mismatch")
check(T.parse_response("blah", 1) is None, "parse garbage")

# validate
check(T.validate("Hi", "Привет", "ru") is None, "validate ok")
check(T.validate("Hi", "", "ru") == "empty", "validate empty")
check(T.validate("<color=x>Hi</color>", "Привет", "ru") == "tag imbalance", "validate tags")
check(T.validate("Ahhh", "Фхааа", "ru") == "banned cluster", "validate banned")

# inplace roundtrip: only target msgstr changes, rest byte-identical
sample = '#: [dlg:1#0]\nmsgctxt "ui"\nmsgid "Hi"\nmsgstr ""\n\n#: [dlg:2#0]\nmsgctxt "ui"\nmsgid "Bye"\nmsgstr "Пока"\n'
with tempfile.TemporaryDirectory() as d:
    p = Path(d) / "t.po"
    p.write_text(sample, encoding="utf-8")
    T.set_msgstr_inplace(p, {("ui", "Hi"): "Привет"})
    got = p.read_text(encoding="utf-8")
    check('msgid "Hi"\nmsgstr "Привет"' in got, "inplace write")
    check('msgid "Bye"\nmsgstr "Пока"' in got, "inplace untouched")
    check(got.count("msgstr") == 2, "inplace no dupes")

# filled entries are never overwritten (same text, other context keeps its own)
sample2 = 'msgctxt "speaker:Leona"\nmsgid "Yo"\nmsgstr "Йо (ж.)"\n\nmsgctxt "speaker:???"\nmsgid "Yo"\nmsgstr ""\n'
with tempfile.TemporaryDirectory() as d:
    p = Path(d) / "t.po"
    p.write_text(sample2, encoding="utf-8")
    T.set_msgstr_inplace(p, {("speaker:???", "Yo"): "Йо"})
    got = p.read_text(encoding="utf-8")
    check('msgstr "Йо (ж.)"' in got, "filled kept")
    check(got.count('msgstr "Йо"') == 1, "empty filled")

# speaker-tag leakage from the prompt is stripped, never stored
check(T.strip_speaker_leak("Привет (speaker: Leona)") == ("Привет", True), "leak strip")
check(T.strip_speaker_leak("Привет") == ("Привет", False), "no leak")
# oversized batches split to fit context budget
big = [{"msgid": "word " * 200, "msgctxt": "ui"} for _ in range(6)]
parts = T.split_for_ctx("s", big, 1200, 1900)
check(len(parts) > 1 and sum(map(len, parts)) == 6, "split")
check(T.split_for_ctx("s", big[:1], 1200, 1900) == [big[:1]], "no split small")
check(T.entry_key({"msgctxt": "speaker:Leona", "msgid": "Hi"}) == ("speaker:Leona", "Hi"), "key")
check(T.speaker_of({"msgctxt": "speaker:Leona", "msgid": "x"}) == "Leona", "speaker")
check(T.speaker_of({"msgctxt": "speaker:???", "msgid": "x"}) is None, "speaker unknown")
check(T.speaker_of({"msgctxt": "ui", "msgid": "x"}) is None, "speaker absent")
bp2 = T.batch_prompt([{"msgid": "Hi", "msgctxt": "speaker:Leona"}])
check("1. Hi (speaker: Leona)" in bp2, "batch speaker")
sp = T.system_prompt("de", "German", "Zoey=Zoe")
check("German" in sp and "Zoey=Zoe" in sp, "system prompt de")
check("{n}" not in sp.format(n=3), "system format ok")
bp = T.batch_prompt([{"msgid": "Hi", "msgctxt": "speaker:Zoey"}])
check(bp.startswith("Translate each line") and "1. Hi (speaker: Zoey)" in bp, "batch prompt")

# skill tables are pulled live (single source of truth)
sfx, gloss = T.load_skill_rules()
check(len(sfx) > 200 and "Аах" in sfx, "skill sfx table")
check("Zoey" in gloss and "Зои" in gloss, "skill glossary")
sp2 = T.system_prompt("ru", "Russian", "")
check("Аах" in sp2 and "Зои" in sp2, "system prompt uses skill")
# lang skills: thin per-language overlays with PROMPT blocks
check(T.load_lang_skill("xx") == "", "skill missing")
check("Единица перевода" in T.load_core(), "core from file, not hardcoded")
check("du with lovers" in T.load_lang_skill("de"), "de skill loads")
check("pan/pani" in T.load_lang_skill("pl"), "pl skill loads")
check("du with lovers" in T.system_prompt("de", "German", ""), "skill in prompt")
check("Аах" in sp2 and "Зои" in sp2, "system prompt uses skill")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
