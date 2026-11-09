"""Code-point ⇄ UTF-16 offset conversion.

Python indexes strings by code point; JavaScript, .NET and LanguageTool (Java)
index by UTF-16 code unit. The public API speaks UTF-16 exclusively.
"""

from __future__ import annotations

from bisect import bisect_right


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


class Utf16Index:
    """O(log n) conversions; O(1) when the text has no astral characters (the common case)."""

    __slots__ = ("_astral_cp", "_identity", "_text_len", "_u16_len")

    def __init__(self, text: str) -> None:
        self._text_len = len(text)
        # Code-point positions of characters outside the BMP (they take 2 UTF-16 units).
        self._astral_cp = [i for i, ch in enumerate(text) if ord(ch) > 0xFFFF]
        self._identity = not self._astral_cp
        self._u16_len = self._text_len + len(self._astral_cp)

    @property
    def utf16_length(self) -> int:
        return self._u16_len

    def to_utf16(self, cp: int) -> int:
        if self._identity:
            return cp
        # Each astral character strictly before `cp` adds one extra unit.
        return cp + bisect_right(self._astral_cp, cp - 1)

    def to_codepoint(self, u16: int) -> int:
        """Maps a UTF-16 offset to a code-point offset. Offsets that fall inside a
        surrogate pair are snapped to the start of that character."""
        if self._identity:
            return u16
        lo, hi = 0, self._text_len
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.to_utf16(mid) <= u16:
                lo = mid
            else:
                hi = mid - 1
        return lo
