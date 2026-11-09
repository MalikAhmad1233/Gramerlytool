"""Meaning-preservation checks for AI corrections and rewrites (product rule R5).

A change is rejected if it alters facts the user wrote: numbers, negation,
named entities, links/e-mails/mentions, or redaction placeholders — or if it
rewrites far more than a correction should.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

_NUMBER = re.compile(r"\d+(?:[.,:/]\d+)*")
_NEGATION = re.compile(
    r"\b(?:not|no|never|none|nobody|nothing|nowhere|neither|nor|cannot|without|hardly|barely|"
    r"scarcely|(?:ca|do|does|did|is|are|was|were|have|has|had|could|should|would|wo|must|need)nt)\b"
    r"|n['’]t\b",
    re.IGNORECASE,
)
_PLACEHOLDER = re.compile(r"\[\[[A-Z]+_\d+\]\]")
_LINKISH = re.compile(
    r"(?:https?://|www\.)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<!\w)[@#][\w.]{2,}", re.I
)
_WORD = re.compile(r"[A-Za-z][A-Za-z'’-]*")
_SENTENCE_START = re.compile(r"(?:^|[.!?]\s+|\n\s*)$")


@dataclass(slots=True)
class GuardResult:
    ok: bool
    reasons: list[str] = field(default_factory=list)


def _numbers(text: str) -> Counter[str]:
    return Counter(re.sub(r"[.,](?=\d{3}\b)", "", n) for n in _NUMBER.findall(text))


def _negations(text: str) -> int:
    return len(_NEGATION.findall(text))


def _entities(text: str) -> set[str]:
    """Capitalised words that are not sentence-initial and not the pronoun I."""
    found: set[str] = set()
    for m in _WORD.finditer(text):
        word = m.group(0)
        if not word[0].isupper() or word in {"I", "I'm", "I've", "I'll", "I'd"}:
            continue
        if _SENTENCE_START.search(text[: m.start()]):
            continue
        found.add(re.sub(r"['’]s$", "", word.lower()))
    return found


def compare(original: str, candidate: str, *, max_length_ratio: float = 2.5) -> GuardResult:
    reasons: list[str] = []
    if _numbers(original) != _numbers(candidate):
        reasons.append("numbers changed")
    if _negations(original) != _negations(candidate):
        reasons.append("negation changed")
    if Counter(_PLACEHOLDER.findall(original)) != Counter(_PLACEHOLDER.findall(candidate)):
        reasons.append("protected token changed")
    if Counter(x.lower() for x in _LINKISH.findall(original)) != Counter(
        x.lower() for x in _LINKISH.findall(candidate)
    ):
        reasons.append("link, e-mail or mention changed")
    lowered = candidate.lower()
    missing = [e for e in _entities(original) if e not in lowered]
    if missing:
        reasons.append("name or entity removed")
    if original.strip():
        ratio = max(len(candidate), 1) / max(len(original), 1)
        if ratio > max_length_ratio or ratio < 1 / max_length_ratio:
            reasons.append("length changed too much")
    return GuardResult(ok=not reasons, reasons=reasons)


def token_change_ratio(original: str, candidate: str) -> float:
    """Share of word tokens that differ (0 = identical, 1 = fully rewritten)."""
    from difflib import SequenceMatcher

    a = re.findall(r"\w+|[^\w\s]", original.lower())
    b = re.findall(r"\w+|[^\w\s]", candidate.lower())
    if not a and not b:
        return 0.0
    matcher = SequenceMatcher(a=a, b=b, autojunk=False)
    same = sum(block.size for block in matcher.get_matching_blocks())
    return 1.0 - (2.0 * same) / (len(a) + len(b))
