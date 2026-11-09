"""Mask personal data before text is sent to an AI provider, and map offsets back.

E-mails, URLs, phone numbers, payment-card numbers (Luhn-validated) and IBANs
become placeholders such as ``[[EMAIL_1]]``. Edits that touch a placeholder are
discarded; everything else is translated back to original coordinates.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("EMAIL", re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")),
    ("URL", re.compile(r"\b(?:https?://|www\.)[^\s<>\"']+", re.I)),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b")),
    ("CARD", re.compile(r"\b(?:\d[ -]?){12,18}\d\b")),
    ("PHONE", re.compile(r"(?<![\w+])\+?\d[\d ().-]{7,}\d\b")),
]


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


@dataclass(frozen=True, slots=True)
class _Slot:
    orig_start: int
    orig_end: int
    masked_start: int
    masked_end: int
    token: str
    value: str


class Masked:
    def __init__(self, original: str, masked: str, slots: list[_Slot]) -> None:
        self.original = original
        self.text = masked
        self._slots = slots

    @property
    def placeholders(self) -> dict[str, str]:
        return {s.token: s.value for s in self._slots}

    def to_original(self, start: int, end: int) -> tuple[int, int] | None:
        """Map a masked-text span to original coordinates; None if it touches a placeholder."""
        delta = 0
        for slot in self._slots:
            if start < slot.masked_end and slot.masked_start < max(end, start + 1):
                return None
            if slot.masked_end <= start:
                delta = slot.orig_end - slot.masked_end
        return start + delta, end + delta

    def restore(self, text: str) -> str:
        for slot in self._slots:
            text = text.replace(slot.token, slot.value)
        return text


def mask(text: str) -> Masked:
    found: list[tuple[int, int, str]] = []
    for kind, pattern in _RULES:
        for m in pattern.finditer(text):
            if any(m.start() < e and s < m.end() for s, e, _ in found):
                continue
            value = m.group(0)
            if kind == "CARD" and not _luhn_ok(re.sub(r"\D", "", value)):
                continue
            if kind == "PHONE" and len(re.sub(r"\D", "", value)) < 8:
                continue
            found.append((m.start(), m.end(), kind))
    found.sort()

    counters: dict[str, int] = {}
    out: list[str] = []
    slots: list[_Slot] = []
    pos = 0
    masked_len = 0
    for start, end, kind in found:
        out.append(text[pos:start])
        masked_len += start - pos
        counters[kind] = counters.get(kind, 0) + 1
        token = f"[[{kind}_{counters[kind]}]]"
        slots.append(_Slot(start, end, masked_len, masked_len + len(token), token, text[start:end]))
        out.append(token)
        masked_len += len(token)
        pos = end
    out.append(text[pos:])
    return Masked(text, "".join(out), slots)
