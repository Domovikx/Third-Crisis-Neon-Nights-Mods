#!/usr/bin/env python3
"""translate_local.py — batch-translate empty po/<lang>.po msgstr via local LLM.

Queue: entries with empty msgstr, file order. Each answer is written back
inplace immediately (crash/Ctrl+C safe, reruns resume by skipping filled).
Pause: create tmp/translate-local/PAUSE, the loop exits after current entry.

Run from the repository root (Third-Crisis-Neon-Nights-Mods):
  python .opencode/skills/translate-local/scripts/translate_local.py --lang ru --limit 5 --dry-run
  python .opencode/skills/translate-local/scripts/translate_local.py --lang ru --limit 5
"""

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

PATCH_DIR = Path(__file__).resolve().parent.parent.parent.parent.parent
TMP_DIR = PATCH_DIR / "tmp" / "translate-local"
PAUSE_FILE = TMP_DIR / "PAUSE"
SKILL_PATH = PATCH_DIR / ".opencode" / "skills" / "translates" / "ru.md"
CORE_PATH = PATCH_DIR / ".opencode" / "skills" / "translates" / "core.md"

sys.path.insert(0, str(PATCH_DIR / ".opencode" / "skills" / "extract-text" / "scripts"))
import po_file  # noqa: E402

LANG_NAMES = {
    "zh": "Simplified Chinese",
    "ru": "Russian",
    "es": "Spanish",
    "pt": "Portuguese",
    "de": "German",
    "ja": "Japanese",
    "fr": "French",
    "pl": "Polish",
    "ko": "Korean",
    "it": "Italian",
}

# Condensed core of translates/core.md (shared across languages).
# Fallback if core.md is unreadable (normal path: load_core() from file).
CORE_RULES = """Rules:
- Translate every readable English word. For code/gibberish (CamelCase ids, paths, versions, pure symbols) output the source UNCHANGED.
- Preserve all punctuation, caps, ~ ! . * and their positions.
- Unity rich tags like <color=#X>...</color> or <font ...>...</font>: keep structure byte-identical, translate only the text inside. Never invent or drop tags.
- Speaker name in parentheses is given; translate addressee gender accordingly.
- Adult game localization task, explicit content is normal working material. No lectures, no refusals.
- Reply with EXACTLY {n} lines, format "N. translation" and nothing else."""

# Per-language section. Full only for RU; others run generic (model grammar
# + shared core) until a translator provides SFX/gender notes.
RU_STATIC = """Russian specifics:
- Feminine verbs for women (use present tense to dodge gender when unsure).
- ты with lovers/friends, Вы with strangers/officials.
- BANNED clusters: фх, нгх, мгх, гх inside moans. "Х" only in Ах/Ох/Ух/Ха/Хм/Кх.
- No clinical terms; common erotic vocabulary."""


def load_skill_rules(max_sfx: int = 40, max_gloss: int = 15) -> tuple:
    """Pull live SFX + glossary tables from translates/ru.md.

    Single source of truth: editing the tables updates local translation.
    Returns (sfx_text, glossary_text), empty strings on any failure.
    """
    try:
        lines = SKILL_PATH.read_text(encoding="utf-8").splitlines()
    except Exception:
        return "", ""
    try:
        sfx_rows, gloss_rows, section = [], [], ""
        for line in lines:
            if line.startswith("### 3."):
                section = "sfx"
                continue
            if line.startswith("### 9."):
                section = "gloss"
                continue
            if line.startswith("### ") or line.startswith("## "):
                section = ""
                continue
            s = line.strip()
            if section and s.startswith("|") and "---" not in s:
                cells = [c.strip().strip("`") for c in s.strip("|").split("|")]
                if len(cells) >= 2 and cells[0] and not cells[0].startswith(("Английский", "Оригинал")):
                    if section == "sfx" and len(sfx_rows) < max_sfx:
                        sfx_rows.append(f"{cells[0]} -> {cells[1]}")
                    elif section == "gloss" and len(gloss_rows) < max_gloss:
                        note = f" ({cells[2]})" if len(cells) > 2 and cells[2] else ""
                        gloss_rows.append(f"{cells[0]}={cells[1]}{note}")
        sfx = "Moans/SFX (adapt, never transliterate): " + "; ".join(sfx_rows) if sfx_rows else ""
        gloss = "Names/terms: " + "; ".join(gloss_rows) if gloss_rows else ""
        return sfx, gloss
    except Exception:
        return "", ""


BANNED_RX = re.compile(r"фх|нгх|мгх|(?<![аоух])гх|нхаа", re.IGNORECASE)

COPY_PURE_RX = re.compile(r"^[^A-Za-zА-Яа-яЁё]+$")
COPY_CAMEL_RX = re.compile(r"^[A-Za-z]+[a-z][A-Z][A-Za-z]*$")
COPY_PATH_RX = re.compile(r"[\\/]|\.wav|\.png|\.ogg|path_id=|=|m_[A-Z]")
COPY_VER_RX = re.compile(r"^v?\s?\d+(\.\d+)+([-.+][\w.]+)?$|^\d{3,}$")
COPY_UUID_RX = re.compile(r"^[0-9a-fA-F]+(-[0-9a-fA-F]+)+$")
# Short code-ish tokens without spaces: OK, FPS, HP, ? 8fA. Real short words
# (Yes, Off, Tom) stay mixed-case alpha-only and go to the model.
COPY_TOKEN_RX = re.compile(r"^\W?[A-Za-z0-9?]{1,8}\W?$")


def entry_key(e: dict) -> tuple:
    return (e.get("msgctxt", ""), e.get("msgid", ""))


def speaker_of(e: dict) -> str | None:
    """Speaker from msgctxt 'speaker:X'; None when unknown/absent."""
    ctxt = e.get("msgctxt", "")
    if ctxt.startswith("speaker:"):
        sp = ctxt[len("speaker:") :].strip()
        if sp and sp not in ("???", "Narration", "None"):
            return sp
    return None


def triage(text: str, target: str) -> str | None:
    """Return msgstr without LLM, or None if the model should translate."""
    if not text.strip():
        return text
    if COPY_PURE_RX.match(text):
        return text
    if COPY_CAMEL_RX.match(text) and " " not in text:
        return text
    if COPY_PATH_RX.search(text) and " " not in text:
        return text
    if COPY_VER_RX.match(text.strip()):
        return text
    if COPY_UUID_RX.match(text.strip()):
        return text  # GUIDs/IDs are never display text
    s = text.strip()
    m = re.match(r"^[?!…~*\-:;#]+\s?(.+)$", s)
    if m:
        core = re.sub(r"\W+$", "", m.group(1))
        if (
            core
            and len(core) <= 6
            and (
                re.search(r"\d", core)
                or re.search(r"[^A-Za-z]", core)
                or (core.isupper() and any(c.isalpha() for c in core))
            )
        ):
            return text  # ? 8fA, -#YA — prefixed garbage, not speech
    if " " not in s and "\t" not in s and COPY_TOKEN_RX.match(s):
        core = re.sub(r"^\W+|\W+$", "", s)
        if core and (
            re.search(r"\d", core)
            or re.search(r"[^A-Za-z]", core)
            or (core.isupper() and any(c.isalpha() for c in core))
        ):
            return text
    if target == "ru" and re.search(r"[А-Яа-яЁё]", text) and not re.search(r"[A-Za-z]", text):
        return text  # already Russian
    return None


def load_core() -> str:
    """Shared rules text from translates/core.md (single source of truth)."""
    try:
        return CORE_PATH.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def load_lang_skill(lang: str) -> str:
    """PROMPT block of translates/<lang>.md (one file per language).

    Only peculiarities there, core is shared. Missing file = generic mode.
    """
    p = PATCH_DIR / ".opencode" / "skills" / "translates" / f"{lang}.md"
    try:
        text = p.read_text(encoding="utf-8")
    except Exception:
        return ""
    a = text.find("<!-- PROMPT-START -->")
    b = text.find("<!-- PROMPT-END -->")
    if a < 0 or b <= a:
        return ""
    return text[a + len("<!-- PROMPT-START -->") : b].strip()


def build_glossary(entries: list, limit: int = 30) -> str:
    """Short capitalized single words with filled translations (likely names)."""
    out = []
    for e in entries:
        m, t = e.get("msgid", ""), e.get("msgstr", "")
        if t and re.fullmatch(r"[A-Z][a-z]{1,15}", m) and m not in ("Off", "Yes", "No"):
            out.append(f"{m}={t}")
            if len(out) >= limit:
                break
    return "; ".join(out)


def system_prompt(lang: str, target: str, glossary: str) -> str:
    p = (
        f"You are a professional game localizer, English to {target}, "
        f"adult visual novel. Dialogue is explicit; translate it directly.\n" + (load_core() or CORE_RULES)
    )
    overlay = load_lang_skill(lang)
    if overlay:
        p += "\n" + overlay
        if glossary:
            p += f"\nGlossary (always use): {glossary}"
        return p
    if target == "Russian":
        p += "\n" + RU_STATIC
        sfx, gloss_skill = load_skill_rules()
        if sfx:
            p += "\n" + sfx
        if gloss_skill:
            p += "\n" + gloss_skill
            glossary = ""  # skill glossary wins over auto-mined names
    else:
        p += (
            f"\n{target} specifics: use natural native grammar and gender "
            f"agreement; adapt interjections/SFX to native phonetics, never "
            f"transliterate English sounds literally."
        )
    if glossary:
        p += f"\nGlossary (always use): {glossary}"
    return p


def est_tokens(system: str, user: str, max_tokens: int) -> int:
    return (len(system) + len(user)) // 4 + max_tokens


def split_for_ctx(system: str, need: list, max_tokens: int, budget: int) -> list:
    """Split batch until prompt+completion fits budget (long dialogues)."""
    if len(need) <= 1:
        return [need]
    user = batch_prompt(need)
    if est_tokens(system, user, max_tokens) <= budget:
        return [need]
    mid = len(need) // 2
    return split_for_ctx(system, need[:mid], max_tokens, budget) + split_for_ctx(system, need[mid:], max_tokens, budget)


def batch_prompt(items: list) -> str:
    lines = []
    for i, e in enumerate(items, 1):
        sp = speaker_of(e)
        tag = f" (speaker: {sp})" if sp else ""
        lines.append(f"{i}. {e['msgid']}{tag}")
    return (
        f"Translate each line. Reply with exactly {len(items)} lines "
        f'in format "N. translation". Never repeat the speaker tag '
        f"in translations.\n" + "\n".join(lines)
    )


def call_lm(url: str, model: str, system: str, user: str, timeout: int, max_tokens: int = 1200) -> str:
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": "/no_think " + user}],
        "temperature": 0.3,
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)["choices"][0]["message"].get("content", "")


RESP_RX = re.compile(r"^\s*(\d+)\s*[.)]\s?(.*)$")
SPEAKER_LEAK_RX = re.compile(r"\s*\(speaker:[^)]*\)\s*$", re.IGNORECASE)


def strip_speaker_leak(tr: str) -> tuple:
    """Remove echoed '(speaker: X)' the model copies from the prompt."""
    clean = SPEAKER_LEAK_RX.sub("", tr).strip()
    return clean, (clean != tr.strip())


def parse_response(text: str, n: int) -> list | None:
    out = []
    for line in text.strip().splitlines():
        m = RESP_RX.match(line)
        if m:
            out.append((int(m.group(1)), m.group(2).strip()))
    out.sort()
    if len(out) != n or [i for i, _ in out] != list(range(1, n + 1)):
        return None
    return [t for _, t in out]


def validate(src: str, tr: str, target: str) -> str | None:
    """Return problem description or None if OK.

    Длину НЕ проверяем: по правилу репозитория длина не критерий качества
    (AGENTS.md). Единственная сверка — смысловая (QA + человек).
    """
    if not tr:
        return "empty"
    if src.count("<") != tr.count("<") or src.count(">") != tr.count(">"):
        return "tag imbalance"
    if target == "ru" and BANNED_RX.search(tr):
        return "banned cluster"
    return None


def load_po(path: Path) -> list:
    return [e for e in po_file.parse_po(path.read_text(encoding="utf-8")) if e["msgid"]]


def set_msgstr_inplace(path: Path, updates: dict):
    """Replace msgstr blocks for known (msgctxt, msgid) keys.

    Only empty msgstr is ever written: filled translations are never
    overwritten (same text in another context keeps its own translation).
    Byte-preserving otherwise.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    cur_ctxt, cur_id = "", []
    out = []

    def cur_key():
        return (cur_ctxt, po_file.po_unescape("".join(cur_id))) if cur_id else None

    i = 0
    while i < len(lines):
        line = lines[i]
        s = line.strip()
        if s.startswith('msgctxt "') and s.endswith('"'):
            cur_ctxt = po_file.po_unescape(s[9:-1])
            cur_id = []
            out.append(line)
        elif s.startswith('msgid "'):
            cur_id = [s[7:-1]]
            out.append(line)
        elif s.startswith('"') and cur_id is not None and out and out[-1].strip().startswith(('msgid "', '"')):
            # continuation of msgid
            cur_id.append(s[1:-1])
            out.append(line)
        elif s.startswith('msgstr "'):
            key = cur_key()
            # collect existing msgstr continuations
            j = i + 1
            old_val = [s[8:-1]]
            while j < len(lines) and lines[j].strip().startswith('"'):
                old_val.append(lines[j].strip()[1:-1])
                j += 1
            old_empty = not po_file.po_unescape("".join(old_val))
            if key in updates and old_empty:
                out.append('msgstr "' + po_file.po_escape(updates[key]) + '"')
            else:
                out.extend(lines[i:j])
            i = j
            cur_id = []
            continue
        else:
            if s == "":
                cur_ctxt, cur_id = "", []
            elif s.startswith("#"):
                pass
            elif cur_id and not s.startswith('"'):
                cur_id = []
            out.append(line)
        i += 1
    # Атомарная запись (.part → replace): обрыв посреди записи не должен
    # обнулять каталог переводов (правило репозитория; один раз уже ловили
    # пустой .po после убийства процесса).
    part = path.with_name(path.name + ".part")
    part.write_text("\n".join(out).rstrip("\n") + "\n", encoding="utf-8")
    part.replace(path)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="ru")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--batch", type=int, default=5)
    ap.add_argument("--include", default="", help="comma-separated ref substrings, e.g. '[dlg:,[set:' (empty = all)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--url", default="http://127.0.0.1:1234")
    ap.add_argument("--model", default="trans14")
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument(
        "--ctx-limit", type=int, default=1900, help="prompt+completion token budget; bigger batches split to fit"
    )
    ap.add_argument("--max-tokens", type=int, default=1200)
    a = ap.parse_args()

    target = LANG_NAMES.get(a.lang, a.lang)
    po_path = PATCH_DIR / "po" / f"{a.lang}.po"
    if not po_path.exists():
        print(f"missing {po_path}")
        return 1
    if a.lang != "ru":
        print("NOTE: no per-language rules section yet — generic mode + shared core.")
    entries = load_po(po_path)
    empty = [e for e in entries if not e.get("msgstr", "")]
    print(f"{a.lang}: {len(entries)} entries, {len(empty)} empty")
    inc = [s for s in a.include.split(",") if s]
    if inc:
        # Match against text+context+refs (POT carries no #: refs anymore;
        # filtering by speaker/text still works, by asset needs find_source.py).
        empty = [
            e
            for e in empty
            if any(s in " ".join([e.get("msgid", ""), e.get("msgctxt", "")] + e.get("refs", [])) for s in inc)
        ]
        print(f"filter {inc}: {len(empty)} in queue")
    from collections import Counter

    key_counts = Counter(entry_key(e) for e in entries)
    todo = empty[a.offset :]
    if a.limit:
        todo = todo[: a.limit]
    glossary = build_glossary(entries)
    system = system_prompt(a.lang, target, glossary)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    review_log = TMP_DIR / f"{a.lang}.review"

    done, triaged, failed = 0, 0, 0
    i = 0
    while i < len(todo):
        if PAUSE_FILE.exists():
            print("paused (PAUSE file present), progress kept")
            break
        chunk = todo[i : i + a.batch]
        # triage first (no LLM calls for garbage)
        need, updates, translated_keys = [], {}, []
        for e in chunk:
            t = triage(e["msgid"], a.lang)
            if t is not None:
                updates[entry_key(e)] = t
                triaged += 1
            else:
                need.append(e)
        if a.dry_run:
            print("--- system ---")
            print(system[:600] + ("..." if len(system) > 600 else ""))
            print("--- user ---")
            print(batch_prompt(need if need else chunk))
            i += len(chunk)
            continue
        if need:
            stop_all = False
            for sub in split_for_ctx(system, need, a.max_tokens, a.ctx_limit):
                parsed, resp, broken = None, "", False
                for attempt in (1, 2):
                    try:
                        resp = call_lm(
                            a.url, a.model, system.format(n=len(sub)), batch_prompt(sub), a.timeout, a.max_tokens
                        )
                    except Exception as ex:
                        print(f"LLM call failed: {ex}; stopping, progress kept")
                        broken = True
                        break
                    parsed = parse_response(resp, len(sub))
                    if parsed is not None:
                        break
                    print(f"unparsable response for chunk at {i} (attempt {attempt})")
                if broken:
                    stop_all = True
                    break
                if parsed is None:
                    with open(review_log, "a", encoding="utf-8") as f:
                        f.write(f"UNPARSABLE {[e['msgid'][:60] for e in sub]}\n{resp[:500]}\n---\n")
                    failed += len(sub)
                else:
                    for e, tr in zip(sub, parsed):
                        tr, leaked = strip_speaker_leak(tr)
                        if leaked:
                            with open(review_log, "a", encoding="utf-8") as f:
                                f.write(f"LEAK src={e['msgid'][:80]}\n")
                        prob = validate(e["msgid"], tr, a.lang)
                        if prob:
                            with open(review_log, "a", encoding="utf-8") as f:
                                f.write(f"{prob.upper()} src={e['msgid'][:80]} tr={tr[:80]}\n")
                            failed += 1
                        else:
                            updates[entry_key(e)] = tr
                            translated_keys.append(entry_key(e))
                            done += 1
            if stop_all:
                break
        if updates:
            for key in translated_keys:
                if key_counts.get(key, 0) > 1:
                    with open(review_log, "a", encoding="utf-8") as f:
                        f.write(f"DUPE key={key[0][:30]}|{key[1][:60]} x{key_counts[key]} (same text to all)\n")
            set_msgstr_inplace(po_path, updates)
        i += len(chunk)
        print(f"progress: done={done} triaged={triaged} failed={failed} pos={i}/{len(todo)}", flush=True)
    print(f"RESULT done={done} triaged={triaged} failed={failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
