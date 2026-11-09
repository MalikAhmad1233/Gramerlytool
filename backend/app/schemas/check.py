"""Check / rewrite contract. All offsets and lengths are UTF-16 code units."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.common import (
    SUPPORTED_LANGUAGES,
    Category,
    ClientKind,
    RewriteStyle,
    Severity,
    Source,
    Style,
)

Language = Literal[tuple(SUPPORTED_LANGUAGES)]  # type: ignore[valid-type]


class ClientContext(BaseModel):
    kind: ClientKind = ClientKind.api
    # Host app identifier, e.g. "gmail", "whatsapp", "linkedin", "word", "outlook", "notepad".
    app: str | None = Field(default=None, max_length=40, pattern=r"^[a-z0-9._-]+$")


class CheckRequest(BaseModel):
    text: str
    language: Language = "en-US"  # type: ignore[valid-type]
    style: Style = Style.neutral
    mode: Literal["fast", "full"] = "fast"
    client: ClientContext = Field(default_factory=ClientContext)
    categories: list[Category] | None = Field(default=None, max_length=10)
    # Guest-mode personal dictionary / disabled rules. Signed-in users' synced values are merged.
    dictionary: list[str] = Field(default_factory=list, max_length=2000)
    disabled_rules: list[str] = Field(default_factory=list, max_length=500)
    ai: bool = True


class Suggestion(BaseModel):
    id: str
    fingerprint: str = Field(description="Stable across re-checks; use to remember 'ignore'.")
    offset: int = Field(ge=0, description="UTF-16 code units")
    length: int = Field(ge=0, description="UTF-16 code units")
    original: str
    replacements: list[str]
    category: Category
    severity: Severity
    title: str
    message: str
    rule_id: str
    source: Source
    confidence: float = Field(ge=0, le=1)


class CheckStats(BaseModel):
    characters: int
    words: int
    sentences: int
    issues: dict[str, int]
    score: int = Field(ge=0, le=100)


class EngineInfo(BaseModel):
    languagetool: Literal["ok", "error"]
    ai: Literal["used", "skipped", "disabled", "unavailable", "error"]
    paragraphs_checked: int
    paragraphs_cached: int
    latency_ms: float


class CheckResponse(BaseModel):
    text_hash: str
    language: str
    style: Style
    mode: Literal["fast", "full"]
    suggestions: list[Suggestion]
    stats: CheckStats
    engine: EngineInfo


class RewriteRequest(BaseModel):
    text: str = Field(min_length=1)
    style: RewriteStyle = RewriteStyle.professional
    count: int = Field(default=3, ge=1, le=3)
    language: Language = "en-US"  # type: ignore[valid-type]
    client: ClientContext = Field(default_factory=ClientContext)
    ai: bool = True


class RewriteAlternative(BaseModel):
    text: str
    source: Literal["ai", "rules"]
    meaning_preserved: bool
    notes: list[str] = Field(default_factory=list)


class RewriteResponse(BaseModel):
    style: RewriteStyle
    alternatives: list[RewriteAlternative]
    engine: Literal["ai", "rules"]
    latency_ms: float
