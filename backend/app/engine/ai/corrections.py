"""Turn an AI-corrected paragraph into precise, reviewable suggestions.

LLMs are unreliable at reporting character offsets, so offsets are never taken
from the model. Instead the corrected text is token-diffed against the original
and each hunk becomes one suggestion. The model's edit list is used only to
attach categories and explanations. Every hunk passes the meaning guard.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from app.engine.ai.meaning_guard import compare, token_change_ratio
from app.engine.ai.provider import AICorrection, AIEdit
from app.engine.ai.redaction import Masked
from app.engine.types import Issue
from app.schemas.common import Category, Severity, Source

_TOKEN = re.compile(r"\w+(?:['’]\w+)*|\s+|[^\w\s]")
MAX_PARAGRAPH_CHANGE = 0.5  # beyond this the model rewrote instead of corrected


@dataclass(slots=True)
class Hunk:
    start: int
    end: int
    replacement: str


@dataclass(frozen=True, slots=True)
class _Tok:
    text: str
    start: int
    end: int


def _tokens(text: str) -> list[_Tok]:
    return [_Tok(m.group(0), m.start(), m.end()) for m in _TOKEN.finditer(text)]


def diff_hunks(original: str, corrected: str) -> list[Hunk]:
    a, b = _tokens(original), _tokens(corrected)
    matcher = SequenceMatcher(a=[t.text for t in a], b=[t.text for t in b], autojunk=False)
    hunks: list[Hunk] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        start = a[i1].start if i1 < len(a) else len(original)
        end = a[i2 - 1].end if i2 > i1 else start
        replacement = corrected[b[j1].start : b[j2 - 1].end] if j2 > j1 else ""
        hunks.append(Hunk(start, end, replacement))
    return _anchor(original, corrected, _merge_adjacent(original, hunks))


def _merge_adjacent(original: str, hunks: list[Hunk]) -> list[Hunk]:
    """Join hunks separated by a single space: "has went" → "have gone" is one fix."""
    merged: list[Hunk] = []
    for hunk in hunks:
        if merged:
            prev = merged[-1]
            gap = original[prev.end : hunk.start]
            if gap in (" ", "") and prev.end != prev.start and hunk.end != hunk.start:
                merged[-1] = Hunk(prev.start, hunk.end, prev.replacement + gap + hunk.replacement)
                continue
        merged.append(hunk)
    return merged


_PREV_TOKEN = re.compile(r"(?:\w+(?:['’]\w+)*|[^\w\s])$")
_NEXT_TOKEN = re.compile(r"\w+(?:['’]\w+)*|[^\w\s]")


def _anchor(original: str, corrected: str, hunks: list[Hunk]) -> list[Hunk]:
    """Give pure insertions a visible span by attaching them to a neighbouring token, and
    present deletions as "word + following space" rather than "space + word"."""
    out: list[Hunk] = []
    for h in hunks:
        if h.start != h.end:
            if not h.replacement:
                span = original[h.start : h.end]
                lead = len(span) - len(span.lstrip())
                if lead and original[h.end : h.end + lead] == span[:lead]:
                    h = Hunk(h.start + lead, h.end + lead, "")
            out.append(h)
            continue
        before = original[: h.start]
        prev = _PREV_TOKEN.search(before)
        if prev:
            out.append(Hunk(prev.start(), h.end, prev.group(0) + h.replacement))
            continue
        nxt = _NEXT_TOKEN.match(original, h.start)
        if nxt:
            out.append(Hunk(h.start, nxt.end(), h.replacement + nxt.group(0)))
    return out


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def _match_edit(
    original: str, replacement: str, edits: list[AIEdit], used: set[int]
) -> AIEdit | None:
    o, r = _norm(original), _norm(replacement)
    for idx, edit in enumerate(edits):
        if idx in used:
            continue
        eo, er = _norm(edit.original), _norm(edit.replacement)
        if (eo and (eo in o or o in eo)) and (er in r or r in er):
            used.add(idx)
            return edit
    return None


def _infer_category(original: str, replacement: str) -> Category:
    def alnum(s: str) -> str:
        return re.sub(r"[\W_]", "", s)

    if alnum(original) == alnum(replacement):
        return Category.punctuation
    if alnum(original).lower() == alnum(replacement).lower():
        return Category.grammar  # capitalisation
    words_o, words_r = original.split(), replacement.split()
    if len(words_o) == 1 and len(words_r) == 1:
        o, r = words_o[0].lower(), words_r[0].lower()
        # Inflections (go → goes, day → days) are grammar; small edits elsewhere are typos.
        inflection = r.startswith(o[: max(1, len(o) - 1)]) or o.startswith(r[: max(1, len(r) - 1)])
        if not inflection and len(o) >= 3 and _osa_distance(o, r) <= 2:
            return Category.spelling
    return Category.grammar


def _osa_distance(a: str, b: str) -> int:
    """Optimal-string-alignment (Damerau-Levenshtein) distance; transpositions cost 1."""
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        d[i][0] = i
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[len(a)][len(b)]


_DEFAULT_MESSAGES = {
    Category.grammar: "Suggested grammar correction based on context.",
    Category.spelling: "This word looks misspelled in this context.",
    Category.punctuation: "Punctuation correction based on context.",
    Category.style: "Suggested improvement based on context.",
    Category.clarity: "Suggested clarity improvement based on context.",
}
_TITLES = {
    Category.grammar: "Grammar",
    Category.spelling: "Spelling",
    Category.punctuation: "Punctuation",
    Category.style: "Style",
    Category.clarity: "Clarity",
}


def issues_from_correction(masked: Masked, result: AICorrection) -> list[Issue]:
    """Convert a model correction of ``masked.text`` into issues on ``masked.original``."""
    source_text = masked.text
    corrected = result.corrected
    if not corrected.strip() or corrected == source_text:
        return []
    if token_change_ratio(source_text, corrected) > MAX_PARAGRAPH_CHANGE:
        return []

    issues: list[Issue] = []
    used: set[int] = set()
    for hunk in diff_hunks(source_text, corrected):
        span_text = source_text[hunk.start : hunk.end]
        if "[[" in hunk.replacement or "]]" in hunk.replacement:
            continue
        mapped = masked.to_original(hunk.start, hunk.end)
        if mapped is None:
            continue
        if not compare(span_text, hunk.replacement, max_length_ratio=4.0).ok:
            continue
        if len(span_text.split()) > 8:  # a correction, not a rewrite
            continue
        edit = _match_edit(span_text, hunk.replacement, result.edits, used)
        try:
            category = (
                Category(edit.category) if edit else _infer_category(span_text, hunk.replacement)
            )
        except ValueError:
            category = _infer_category(span_text, hunk.replacement)
        message = (edit.explanation.strip() if edit and edit.explanation.strip() else "") or (
            _DEFAULT_MESSAGES[category]
        )
        start, end = mapped
        severity = (
            Severity.error
            if category in (Category.grammar, Category.spelling)
            else Severity.warning
            if category is Category.punctuation
            else Severity.suggestion
        )
        issues.append(
            Issue(
                start=start,
                end=end,
                original=masked.original[start:end],
                replacements=[hunk.replacement],
                category=category,
                severity=severity,
                title=_TITLES[category],
                message=message,
                rule_id=f"AI_{category.value.upper()}",
                source=Source.ai,
                confidence=0.8 if len(span_text.split()) <= 3 else 0.7,
            )
        )
    return issues
