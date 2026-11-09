"""Settings, dictionary, feedback and usage schemas."""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import SUPPORTED_LANGUAGES, Category, ClientKind, Source, Style

_HOST_RE = re.compile(
    r"^(?=.{1,253}$)(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$"
)
_PROCESS_RE = re.compile(r"^[A-Za-z0-9._ -]{1,100}$")
_RULE_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,120}$")
WORD_RE = re.compile(r"^[^\s<>{}\[\]\\]{1,64}$")


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


class SettingsOut(BaseModel):
    language: str
    default_style: Style
    ai_enabled: bool
    enabled_categories: list[Category]
    disabled_rules: list[str]
    disabled_sites: list[str]
    disabled_apps: list[str]
    updated_at: datetime | None = None


class SettingsUpdate(BaseModel):
    """Partial update: omitted fields keep their current value."""

    language: str | None = None
    default_style: Style | None = None
    ai_enabled: bool | None = None
    enabled_categories: list[Category] | None = Field(default=None, max_length=10)
    disabled_rules: list[str] | None = Field(default=None, max_length=500)
    disabled_sites: list[str] | None = Field(default=None, max_length=500)
    disabled_apps: list[str] | None = Field(default=None, max_length=200)

    @field_validator("language")
    @classmethod
    def _language(cls, value: str | None) -> str | None:
        if value is not None and value not in SUPPORTED_LANGUAGES:
            raise ValueError(f"unsupported language '{value}'")
        return value

    @field_validator("disabled_sites")
    @classmethod
    def _sites(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        normalised = [v.strip().lower().rstrip(".") for v in values]
        for host in normalised:
            if not _HOST_RE.match(host):
                raise ValueError(f"invalid host '{host}'")
        return _unique(normalised)

    @field_validator("disabled_apps")
    @classmethod
    def _apps(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        normalised = [v.strip().lower() for v in values]
        for name in normalised:
            if not _PROCESS_RE.match(name):
                raise ValueError(f"invalid process name '{name}'")
        return _unique(normalised)

    @field_validator("disabled_rules")
    @classmethod
    def _rules(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        for rule in values:
            if not _RULE_RE.match(rule):
                raise ValueError(f"invalid rule id '{rule}'")
        return _unique(values)

    @field_validator("enabled_categories")
    @classmethod
    def _categories(cls, values: list[Category] | None) -> list[Category] | None:
        return None if values is None else _unique(values)  # type: ignore[arg-type]


class DictionaryWord(BaseModel):
    word: str = Field(min_length=1, max_length=64)

    @field_validator("word")
    @classmethod
    def _word(cls, value: str) -> str:
        value = value.strip()
        if not WORD_RE.match(value):
            raise ValueError("word must be 1-64 characters without spaces or brackets")
        return value


class DictionaryOut(BaseModel):
    words: list[str]
    count: int
    limit: int


FeedbackAction = Literal["accepted", "ignored", "rule_disabled", "added_to_dictionary"]


class FeedbackEvent(BaseModel):
    rule_id: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:\-]+$")
    category: Category
    source: Source
    action: FeedbackAction


class FeedbackBatch(BaseModel):
    client: ClientKind
    events: list[FeedbackEvent] = Field(min_length=1, max_length=50)


class UsageDay(BaseModel):
    day: date
    checks: int
    characters: int
    suggestions_shown: int
    accepted: int
    ignored: int
    rewrites: int


class UsageSummary(BaseModel):
    days: int
    totals: UsageDay | None
    acceptance_rate: float | None
    daily: list[UsageDay]
