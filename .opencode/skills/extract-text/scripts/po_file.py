#!/usr/bin/env python3
"""po_file.py — Minimal PO file parser/renderer for the NeonTranslator pipeline.

Handles the subset translators actually produce (Poedit/Weblate/msgmerge):
  - msgid / msgctxt / msgstr, single- or multi-line ("..." continuations)
  - #: references, #. extracted comments, #, flags (incl. fuzzy), # translator comments
  - header entry (msgid "")

Not a full gettext implementation — just enough to round-trip our catalogs
deterministically. Used by prefill_po.py and po2yaml.py.
"""

import re

_MSG_RX = re.compile(r'^(msgid|msgctxt|msgstr)\s+"(.*)"$')
_CONT_RX = re.compile(r'^"(.*)"$')
_REF_RX = re.compile(r"^#: +(.+)$")
_FLAG_RX = re.compile(r"^#, +(.+)$")
_CMT_RX = re.compile(r"^#\. +(.+)$")
_TR_RX = re.compile(r"^# +(.+)$")


def po_unescape(s: str) -> str:
    """Decode PO string escapes."""
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            n = s[i + 1]
            out.append({"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\"}.get(n, n))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def po_escape(s: str) -> str:
    """Encode a string for PO (single-line, deterministic)."""
    return (
        (s or "")
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\r", "\\r")
        .replace("\n", "\\n")
        .replace("\t", "\\t")
    )


def _new_entry() -> dict:
    """Blank PO entry."""
    return {"msgid": "", "msgctxt": "", "msgstr": "", "refs": [], "comments": [], "flags": [], "translator": []}


def parse_po(text: str) -> list:
    """Parse PO/POT text into a list of entry dicts.

    Entry: {"msgid": str, "msgctxt": str, "msgstr": str,
            "refs": [...], "comments": [...], "flags": [...], "translator": [...]}
    """
    entries = []
    cur = None
    field = None

    def flush():
        if cur is not None and (cur["msgid"] or cur["msgstr"] or cur["msgctxt"] or cur["refs"]):
            entries.append(cur)

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            flush()
            cur = None
            field = None
            continue
        m = _MSG_RX.match(line)
        if m:
            if cur is None:
                cur = _new_entry()
            field = m.group(1)
            cur[field] = po_unescape(m.group(2))
            continue
        m = _CONT_RX.match(line)
        if m and cur is not None and field:
            cur[field] += po_unescape(m.group(1))
            continue
        m = _REF_RX.match(line)
        if m:
            if cur is None:
                cur = _new_entry()
            # One ref per #: line (all our writers emit it that way).
            # Never split on spaces: stable refs contain speaker names
            # with spaces ([spk:Cartel Guy]) — splitting corrupts them
            # into fragments on every parse->render round-trip.
            cur["refs"].append(m.group(1).strip())
            field = None
            continue
        m = _FLAG_RX.match(line)
        if m:
            if cur is None:
                cur = _new_entry()
            cur["flags"].extend(x.strip() for x in m.group(1).split(","))
            field = None
            continue
        m = _CMT_RX.match(line)
        if m:
            if cur is None:
                cur = _new_entry()
            cur["comments"].append(m.group(1))
            field = None
            continue
        m = _TR_RX.match(line)
        if m:
            if cur is None:
                cur = _new_entry()
            cur["translator"].append(m.group(1))
            field = None
            continue
        # Unknown line: ends current field continuation, otherwise ignored
        field = None
    flush()
    return entries


def render_po(entries: list, header_lines: list) -> str:
    """Render entries + header lines to PO text (single trailing newline)."""
    out = list(header_lines) + [""]
    for e in entries:
        for ref in e.get("refs", []):
            out.append(f"#: {ref}")
        for c in e.get("comments", []):
            out.append(f"#. {c}")
        for t in e.get("translator", []):
            out.append(f"# {t}")
        flags = [f for f in e.get("flags", []) if f]
        if flags:
            out.append(f"#, {', '.join(flags)}")
        if e.get("msgctxt"):
            out.append(f'msgctxt "{po_escape(e["msgctxt"])}"')
        out.append(f'msgid "{po_escape(e["msgid"])}"')
        out.append(f'msgstr "{po_escape(e.get("msgstr", ""))}"')
        out.append("")
    return "\n".join(out).rstrip("\n") + "\n"
