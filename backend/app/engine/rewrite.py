"""Deterministic style transformer — the offline fallback for /v1/rewrite.

When no AI provider is configured (or it fails), alternatives are produced by
meaning-preserving lexical transforms on top of LanguageTool's top fixes.
"""

from __future__ import annotations

import re

from app.engine.rules import CONTRACTIONS, INFORMAL
from app.schemas.common import RewriteStyle

_EXPAND = {k: v[0] for k, v in CONTRACTIONS.items()}

_CONTRACT: list[tuple[str, str]] = [
    ("do not", "don't"),
    ("does not", "doesn't"),
    ("did not", "didn't"),
    ("cannot", "can't"),
    ("can not", "can't"),
    ("could not", "couldn't"),
    ("will not", "won't"),
    ("would not", "wouldn't"),
    ("should not", "shouldn't"),
    ("is not", "isn't"),
    ("are not", "aren't"),
    ("was not", "wasn't"),
    ("were not", "weren't"),
    ("have not", "haven't"),
    ("has not", "hasn't"),
    ("I am", "I'm"),
    ("you are", "you're"),
    ("we are", "we're"),
    ("they are", "they're"),
    ("it is", "it's"),
    ("that is", "that's"),
    ("there is", "there's"),
    ("I have", "I've"),
    ("we have", "we've"),
    ("I will", "I'll"),
    ("we will", "we'll"),
    ("you will", "you'll"),
]

_FORMAL_PHRASES: list[tuple[str, str]] = [
    (r"\bhey\b", "Hello"),
    (r"\bhi\b(?=\s+\w)", "Hello"),
    (r"\bthanks a lot\b", "thank you very much"),
    (r"\bthanks\b", "thank you"),
    (r"\bkids\b", "children"),
    (r"\bget back to you\b", "respond to you"),
    (r"\bcheck out\b", "review"),
    (r"\bfigure out\b", "determine"),
    (r"\bfind out\b", "discover"),
    (r"\bstuff\b", "items"),
    (r"\ba bit\b", "slightly"),
]

_CASUAL_PHRASES: list[tuple[str, str]] = [
    (r"\bhello\b", "Hi"),
    (r"\bthank you very much\b", "thanks a lot"),
    (r"\bthank you\b", "thanks"),
    (r"\bI apologi[sz]e\b", "sorry"),
    (r"\bregarding\b", "about"),
    (r"\bassist\b", "help"),
    (r"\bpurchase\b", "buy"),
    (r"\brequire\b", "need"),
]

_CONCISE_PHRASES: list[tuple[str, str]] = [
    (r"\bin order to\b", "to"),
    (r"\bdue to the fact that\b", "because"),
    (r"\bowing to the fact that\b", "because"),
    (r"\bin spite of the fact that\b", "although"),
    (r"\bat this point in time\b", "now"),
    (r"\bat the present time\b", "now"),
    (r"\bin the event that\b", "if"),
    (r"\bfor the purpose of\b", "for"),
    (r"\bin the near future\b", "soon"),
    (r"\ba large number of\b", "many"),
    (r"\ba majority of\b", "most"),
    (r"\bis able to\b", "can"),
    (r"\bare able to\b", "can"),
    (r"\bmake a decision\b", "decide"),
    (r"\bcome to a conclusion\b", "conclude"),
    (r"\bthe reason why is that\b", "because"),
    (r"\bwith regard to\b", "about"),
    (r"\bin regard to\b", "about"),
    (r"\bin terms of\b", "in"),
    (r"\bit is important to note that\s*", ""),
    (r"\bplease note that\s*", ""),
    (r"\bI just wanted to\b", "I want to"),
    (r"\bI wanted to\b", "I want to"),
]

_FILLERS_PRO = re.compile(r"\s*\b(?:basically|literally|actually|totally)\b(?=\s)", re.IGNORECASE)
_FILLERS_CONCISE = re.compile(
    r"\s*\b(?:basically|literally|actually|totally|really|just|very|quite)\b(?=\s)", re.IGNORECASE
)


def _sub_preserving_case(pattern: str, replacement: str, text: str) -> str:
    def repl(m: re.Match[str]) -> str:
        found = m.group(0)
        if replacement and found[:1].isupper():
            return replacement[:1].upper() + replacement[1:]
        if replacement and found[:1].islower() and replacement[:1].isupper() and replacement != "I":
            # Only keep a capital when the phrase started a sentence.
            start = m.start()
            if not re.search(r"(^|[.!?]\s+)$", text[:start]):
                return replacement[:1].lower() + replacement[1:]
        return replacement

    return re.sub(pattern, repl, text, flags=re.IGNORECASE)


def expand_contractions(text: str) -> str:
    def repl(m: re.Match[str]) -> str:
        word = m.group(0)
        expanded = _EXPAND.get(word.lower().replace("’", "'"))
        if expanded is None:
            return word
        return expanded[:1].upper() + expanded[1:] if word[:1].isupper() else expanded

    return re.sub(r"(?<![\w'’])[A-Za-z]+['’][a-z]+(?![\w'’])", repl, text)


def contract(text: str) -> str:
    for full, short in _CONTRACT:
        text = _sub_preserving_case(r"\b" + re.escape(full) + r"\b", short, text)
    return text


def replace_informal(text: str, *, formal: bool) -> str:
    for word, replacements, formal_only in INFORMAL:
        if formal_only and not formal:
            continue
        choice = (
            replacements[-1]
            if formal and len(replacements) > 1 and word in {"thx", "thanx", "dunno"}
            else replacements[0]
        )
        pattern = r"(?<![\w'’@#])" + re.escape(word).replace("'", "['’]") + r"(?![\w'’])"
        text = _sub_preserving_case(pattern, choice, text)
    return text


_QUESTION_START = re.compile(
    r"^\s*(?:(?:hello|hi|hey),?\s+)?(?:can|could|would|will|do|does|did|is|are|was|were|should|"
    r"shall|may|might|have|has|what|when|where|why|how|who|which)\b",
    re.IGNORECASE,
)


def tidy(text: str) -> str:
    text = re.sub(r"(?<![\w'’])i(?![\w'’])", "I", text)
    text = re.sub(r"\bi(['’](?:m|ve|ll|d))\b", lambda m: "I" + m.group(1), text)
    text = re.sub(r"([!?])\1+", r"\1", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    # Comma after an opening greeting: "Hello I wanted" → "Hello, I wanted".
    text = re.sub(
        r"^(\s*(?i:hello|hi|hey|greetings|good (?:morning|afternoon|evening)))(?=\s+(?:I\b|[a-z]))",
        r"\1,",
        text,
    )
    # Capitalise sentence starts.
    text = re.sub(r"(^\s*|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), text)
    stripped = text.rstrip()
    if stripped and stripped[-1].isalnum():
        last_sentence = re.split(r"(?<=[.!?])\s+", stripped)[-1]
        mark = "?" if _QUESTION_START.match(last_sentence) else "."
        text = stripped + mark + text[len(stripped) :]
    return text


def transform(text: str, style: RewriteStyle) -> str:
    out = text
    if style in (RewriteStyle.professional, RewriteStyle.formal):
        out = replace_informal(out, formal=style is RewriteStyle.formal)
        out = _FILLERS_PRO.sub("", out)
        if style is RewriteStyle.formal:
            out = expand_contractions(out)
            for pattern, repl in _FORMAL_PHRASES:
                out = _sub_preserving_case(pattern, repl, out)
    elif style in (RewriteStyle.casual, RewriteStyle.friendly):
        out = contract(out)
        for pattern, repl in _CASUAL_PHRASES:
            out = _sub_preserving_case(pattern, repl, out)
        if style is RewriteStyle.friendly:
            out = replace_informal(out, formal=False)
    elif style is RewriteStyle.concise:
        for pattern, repl in _CONCISE_PHRASES:
            out = _sub_preserving_case(pattern, repl, out)
        out = _FILLERS_CONCISE.sub("", out)
        out = replace_informal(out, formal=False)
    return tidy(out)


def apply_fixes(text: str, fixes: list[tuple[int, int, str]]) -> str:
    """Apply non-overlapping (start, end, replacement) fixes, right to left."""
    for start, end, replacement in sorted(fixes, key=lambda f: f[0], reverse=True):
        text = text[:start] + replacement + text[end:]
    return text
