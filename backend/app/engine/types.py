"""Internal engine types. Offsets here are Python code-point offsets."""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from app.schemas.common import Category, Severity, Source


@dataclass(slots=True)
class Issue:
    start: int  # code points, relative to the segment being processed
    end: int
    original: str
    replacements: list[str]
    category: Category
    severity: Severity
    title: str
    message: str
    rule_id: str
    source: Source
    confidence: float
    agreed_by: set[str] = field(default_factory=set)
    # Spans (same coordinates) where contradictory LanguageTool hits should be dropped.
    suppresses: tuple[tuple[int, int], ...] = ()

    @property
    def length(self) -> int:
        return self.end - self.start

    def shifted(self, delta: int) -> Issue:
        return replace(self, start=self.start + delta, end=self.end + delta)

    def overlaps(self, other: Issue) -> bool:
        if self.start == self.end or other.start == other.end:
            return self.start == other.start
        return self.start < other.end and other.start < self.end


@dataclass(frozen=True, slots=True)
class UserContext:
    """Per-request personalisation, merged from synced settings and request fields."""

    dictionary: frozenset[str] = frozenset()  # lower-cased
    disabled_rules: frozenset[str] = frozenset()
    categories: frozenset[Category] = frozenset(Category)
    ai_enabled: bool = True
