"""Per-user personalisation (dictionary, disabled rules, categories) with a short TTL cache.

Checks run on every pause in typing; reading settings + dictionary from
PostgreSQL each time would add latency, so they are cached in-process and
invalidated whenever the user changes them.
"""

from __future__ import annotations

import time
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.engine.types import UserContext
from app.models import User
from app.schemas.check import CheckRequest
from app.schemas.common import Category
from app.services import accounts


class UserContextCache:
    def __init__(self, ttl_seconds: float = 60.0, max_entries: int = 10_000) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        self._data: dict[uuid.UUID, tuple[float, UserContext]] = {}

    def invalidate(self, user_id: uuid.UUID) -> None:
        self._data.pop(user_id, None)

    async def get(self, session: AsyncSession, user: User) -> UserContext:
        now = time.monotonic()
        item = self._data.get(user.id)
        if item and item[0] > now:
            return item[1]
        record = await accounts.get_settings_record(session, user.id)
        words = await accounts.list_words(session, user.id)
        ctx = UserContext(
            dictionary=frozenset(w.lower() for w in words),
            disabled_rules=frozenset(record.disabled_rules),
            categories=frozenset(Category(c) for c in record.enabled_categories),
            ai_enabled=record.ai_enabled,
        )
        if len(self._data) >= self._max:
            self._data.clear()
        self._data[user.id] = (now + self._ttl, ctx)
        return ctx


def merge_request(
    base: UserContext | None,
    req_dictionary: list[str],
    req_rules: list[str],
    req_categories: list[Category] | None,
    req_ai: bool,
) -> UserContext:
    base = base or UserContext()
    categories = frozenset(req_categories) if req_categories else base.categories
    return UserContext(
        dictionary=base.dictionary | {w.strip().lower() for w in req_dictionary if w.strip()},
        disabled_rules=base.disabled_rules | frozenset(req_rules),
        categories=categories,
        ai_enabled=base.ai_enabled and req_ai,
    )


def context_for_check(base: UserContext | None, req: CheckRequest) -> UserContext:
    return merge_request(base, req.dictionary, req.disabled_rules, req.categories, req.ai)
