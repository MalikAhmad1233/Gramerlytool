"""Spans that must never be "corrected": URLs, e-mails, mentions, hashtags, code, paths."""

from __future__ import annotations

import re

_PATTERNS = [
    re.compile(r"```.*?```", re.DOTALL),  # fenced code
    re.compile(r"`[^`\n]+`"),  # inline code
    re.compile(r"\b(?:https?://|ftp://|www\.)[^\s<>\"']+", re.IGNORECASE),
    re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"),  # e-mail
    re.compile(r"(?<![\w@])@[\w.]{2,}"),  # @mention
    re.compile(r"(?<![\w#&])#[A-Za-z][\w-]*"),  # #hashtag
    re.compile(r"\b[A-Za-z]:\\[^\s]+"),  # Windows path
    re.compile(r"(?<![\w/])(?:/[\w.-]+){2,}/?"),  # POSIX path
    re.compile(r":[a-z0-9_+-]{2,}:"),  # emoji shortcode
    re.compile(
        r"\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|co|uk|edu|gov|app)\b",
        re.IGNORECASE,
    ),
]


def protected_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for pattern in _PATTERNS:
        spans.extend((m.start(), m.end()) for m in pattern.finditer(text))
    return _merge(spans)


def _merge(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    spans.sort()
    merged: list[tuple[int, int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def overlaps_any(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    end = max(end, start + 1)
    return any(start < s_end and s_start < end for s_start, s_end in spans)
