"""Deterministic AI provider used by tests (the real one needs an API key)."""

from __future__ import annotations

import asyncio

from app.engine.ai.provider import AICorrection, AIEdit, AIError


class FakeProvider:
    name = "fake"

    def __init__(
        self,
        corrections: dict[str, str] | None = None,
        rewrites: dict[str, list[str]] | None = None,
        *,
        edits: dict[str, list[AIEdit]] | None = None,
        fail: bool = False,
        delay: float = 0.0,
    ) -> None:
        self.corrections = corrections or {}
        self.rewrites = rewrites or {}
        self.edits = edits or {}
        self.fail = fail
        self.delay = delay
        self.correct_calls: list[str] = []
        self.rewrite_calls: list[str] = []

    @property
    def available(self) -> bool:
        return True

    async def correct(self, text: str, *, language: str, style: str) -> AICorrection:
        self.correct_calls.append(text)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise AIError("boom")
        corrected = self.corrections.get(text, text)
        return AICorrection(corrected=corrected, edits=self.edits.get(text, []))

    async def rewrite(self, text: str, *, language: str, style: str, count: int) -> list[str]:
        self.rewrite_calls.append(text)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise AIError("boom")
        return self.rewrites.get(text, [])[:count]

    async def aclose(self) -> None:
        return None
