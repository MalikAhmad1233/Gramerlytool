"""Paragraph segmentation used for incremental checking and caching.

Boundaries:
* one or more blank lines (LF or CRLF),
* a bare ``\\r`` not followed by ``\\n`` (Word / RichEdit paragraph mark),
* U+2029 PARAGRAPH SEPARATOR.

Single line breaks stay inside a paragraph so wrapped lines are not mistaken for
sentence starts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_BOUNDARY = re.compile(r"\r?\n(?:[ \t\f\v]*\r?\n)+|\r(?!\n)|\u2029")


@dataclass(frozen=True, slots=True)
class Segment:
    start: int  # code-point offset in the full text
    text: str

    @property
    def end(self) -> int:
        return self.start + len(self.text)


def split_paragraphs(text: str) -> list[Segment]:
    segments: list[Segment] = []
    pos = 0
    for match in _BOUNDARY.finditer(text):
        _append(segments, text, pos, match.start())
        pos = match.end()
    _append(segments, text, pos, len(text))
    return segments


def _append(segments: list[Segment], text: str, start: int, end: int) -> None:
    chunk = text[start:end]
    if chunk.strip():
        segments.append(Segment(start=start, text=chunk))
