"""Async client for a self-hosted LanguageTool HTTP server (``/v2/check``)."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

import httpx

log = logging.getLogger("writemind.languagetool")


@dataclass(frozen=True, slots=True)
class LTMatch:
    offset: int  # UTF-16 code units, relative to the submitted text
    length: int
    message: str
    short_message: str
    replacements: list[str]
    rule_id: str
    rule_description: str
    issue_type: str
    category_id: str
    category_name: str


class LanguageToolError(Exception):
    pass


class LanguageToolClient:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 6.0,
        max_concurrency: int = 8,
        failure_threshold: int = 5,
        cooldown_seconds: float = 15.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=httpx.Timeout(timeout, connect=2.0),
            limits=httpx.Limits(
                max_connections=max_concurrency * 2, max_keepalive_connections=max_concurrency
            ),
            transport=transport,
        )
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._failures = 0
        self._failure_threshold = failure_threshold
        self._cooldown = cooldown_seconds
        self._open_until = 0.0

    async def close(self) -> None:
        await self._client.aclose()

    @property
    def circuit_open(self) -> bool:
        return time.monotonic() < self._open_until

    async def ping(self) -> bool:
        try:
            res = await self._client.get("/v2/languages", timeout=2.0)
            return res.status_code == 200
        except httpx.HTTPError:
            return False

    async def check(
        self,
        text: str,
        language: str,
        *,
        level: str = "default",
        disabled_rules: tuple[str, ...] = (),
        enabled_rules: tuple[str, ...] = (),
        disabled_categories: tuple[str, ...] = (),
    ) -> list[LTMatch]:
        if self.circuit_open:
            raise LanguageToolError("circuit open")
        form = {"text": text, "language": language, "level": level}
        if disabled_rules:
            form["disabledRules"] = ",".join(disabled_rules)
        if enabled_rules:
            form["enabledRules"] = ",".join(enabled_rules)
        if disabled_categories:
            form["disabledCategories"] = ",".join(disabled_categories)
        try:
            async with self._semaphore:
                res = await self._client.post("/v2/check", data=form)
            res.raise_for_status()
            payload = res.json()
        except (httpx.HTTPError, ValueError) as exc:
            self._record_failure()
            log.warning("languagetool request failed", extra={"error": type(exc).__name__})
            raise LanguageToolError(type(exc).__name__) from exc
        self._failures = 0
        return [_parse_match(m) for m in payload.get("matches", [])]

    def _record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self._failure_threshold:
            self._open_until = time.monotonic() + self._cooldown
            self._failures = 0
            log.error("languagetool circuit opened", extra={"cooldown_s": self._cooldown})


def _parse_match(m: dict) -> LTMatch:
    rule = m.get("rule", {})
    category = rule.get("category", {})
    return LTMatch(
        offset=int(m["offset"]),
        length=int(m["length"]),
        message=m.get("message", ""),
        short_message=m.get("shortMessage", "") or "",
        replacements=[r["value"] for r in m.get("replacements", [])[:5] if "value" in r],
        rule_id=rule.get("id", "UNKNOWN"),
        rule_description=rule.get("description", ""),
        issue_type=rule.get("issueType", ""),
        category_id=category.get("id", ""),
        category_name=category.get("name", ""),
    )
