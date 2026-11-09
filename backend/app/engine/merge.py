"""Combine issues from LanguageTool, WriteMind rules and AI into one non-overlapping set.

Policy:
* Identical spans merge: replacement lists are unioned (winner first) and
  agreement between independent sources raises confidence.
* Otherwise overlapping candidates are resolved greedily by priority so the
  editor never shows two underlines on the same characters.
"""

from __future__ import annotations

from app.engine.types import Issue
from app.schemas.common import Category, Source

_SOURCE_BONUS = {Source.languagetool: 0.02, Source.writemind: 0.01, Source.ai: 0.0}
_CATEGORY_RANK = {
    Category.spelling: 0.04,
    Category.grammar: 0.03,
    Category.punctuation: 0.02,
    Category.clarity: 0.0,
    Category.style: 0.0,
}


def _priority(issue: Issue) -> float:
    return issue.confidence + _SOURCE_BONUS[issue.source] + _CATEGORY_RANK[issue.category]


def merge_issues(candidates: list[Issue]) -> list[Issue]:
    ordered = sorted(candidates, key=lambda i: (-_priority(i), i.start, i.end))
    selected: list[Issue] = []
    for cand in ordered:
        twin = next((s for s in selected if s.start == cand.start and s.end == cand.end), None)
        if twin is not None:
            _absorb(twin, cand)
            continue
        if any(cand.overlaps(s) for s in selected):
            continue
        cand.agreed_by = cand.agreed_by | {cand.source.value}
        selected.append(cand)
    selected.sort(key=lambda i: (i.start, i.end))
    return selected


def _absorb(winner: Issue, other: Issue) -> None:
    common = next((r for r in other.replacements if r in winner.replacements), None)
    agreed = common is not None and other.source.value not in winner.agreed_by
    for replacement in other.replacements:
        if replacement not in winner.replacements:
            winner.replacements.append(replacement)
    if agreed:
        # Independent sources agree: promote that replacement and boost confidence.
        winner.replacements.remove(common)
        winner.replacements.insert(0, common)
        winner.confidence = min(0.99, max(winner.confidence, other.confidence) + 0.08)
    winner.agreed_by = winner.agreed_by | {other.source.value}
    del winner.replacements[5:]
