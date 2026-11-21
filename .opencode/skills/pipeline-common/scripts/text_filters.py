#!/usr/bin/env python3
"""Shared pipeline text filters (single owner — pipeline-common).

Contract: import shared filters from here, never duplicate lists.
dump-assets and extract-text both use these; the definitions below are the
authoritative copies (moved verbatim from extract-text/scripts/extractor.py,
R2 refactor — no logic changes). Any fix goes here, never in a local copy.
"""

import re

__all__ = [
    "SKIP_RAW_PREFIXES",
    "KNOWN_NON_SPEAKERS",
    "_ASSET_SUFFIXES",
    "_ASSET_PREFIXES",
    "_is_asset_name",
    "_PCT_LEGIT_RX",
    "_is_garbage_fragment",
    "_auto_triage",
    "_RICH_TAG_RX",
    "_is_skip_prefix",
    "_strip_rich",
]

SKIP_RAW_PREFIXES = (
    "line_",
    "expressions/",
    "separatedexpressions/",
    "Poses/",
    "expressionadditive/",
    "p>xo",
    "Other Dialogue Presets",
    "Zoey Dialogue Presets",
    "_Preset",
    "Dialogue Presets",
    "Char_",
    "Apl_",
)

KNOWN_NON_SPEAKERS = {
    "GlowingHole",
    "GlowingHoleKeys/",
    "Narrator",
    "Confirm",
    "Other Dialogue Presets",
    "Zoey Dialogue Presets",
    "Simon",
}


# ---------------------------------------------------------------------------
# Auto-triage: asset names and binary garbage get skip_translation at birth.
# Applied ONLY to raw/settings (UI-ish) entries, never to dialogues —
# stories may legitimately contain anything.
# ---------------------------------------------------------------------------

# Unity component/class-name signals in spaceless single tokens.
# Legit UI labels (Back, Continue, New Game, ...) never match these.
_ASSET_SUFFIXES = (
    "Renderer",
    "System",
    "Manager",
    "Controller",
    "Handler",
    "Receiver",
    "Target",
    "Pickup",
    "Link",
    "Mask",
    "Interact",
    "Effect",
    "UI",
)
_ASSET_PREFIXES = ("NN", "AMS")


def _is_asset_name(s: str) -> bool:
    """Detect Unity component/script names (NNHsvRenderer, EventSystem, NodeLink2)."""
    if not s or " " in s or len(s) < 4:
        return False
    if s.startswith(_ASSET_PREFIXES):
        return True
    if s.endswith(_ASSET_SUFFIXES):
        return True
    if any(c.isdigit() for c in s):
        return True
    return False


_PCT_LEGIT_RX = re.compile(r"\d+\s?%$")


def _is_garbage_fragment(s: str) -> bool:
    """Detect binary-fragment garbage (Bff?D, H\\?d, %IR, S5?d).

    Legit %-usage is a trailing percent after digits ("50%"); legit "?"
    ends the string ("Really?"). Dialogues are exempt (checked by caller).
    """
    if not s:
        return False
    if "\\" in s:
        return True
    if "%" in s and not _PCT_LEGIT_RX.search(s):
        return True
    if "?" in s and " " not in s and not s.endswith("?") and len(s) <= 12:
        # Interrobang-style punctuation (?!, ?..., ??) is legit; a "?" glued
        # to letters/symbols (Bff?D, S5?d) is a binary fragment.
        for i, c in enumerate(s):
            if c == "?" and i + 1 < len(s) and s[i + 1] not in "!?.":
                return True
    return False


def _auto_triage(text: str) -> dict:
    """Return skip/translation preset for auto-triaged strings, else {}."""
    if _is_asset_name(text) or _is_garbage_fragment(text):
        return {"translation": text, "skip_translation": True}
    return {}


_RICH_TAG_RX = re.compile(r"<[^>]+>")


def _is_skip_prefix(s: str) -> bool:
    return any(s.startswith(p) for p in SKIP_RAW_PREFIXES)


def _strip_rich(s: str) -> str:
    return _RICH_TAG_RX.sub("", s).strip()
