"""Aggregated usage counters (no content) and feedback persistence."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import SuggestionFeedback, UsageDaily
from app.schemas.account import FeedbackBatch, UsageDay, UsageSummary

log = logging.getLogger("writemind.usage")

_COUNTERS = ("checks", "characters", "suggestions_shown", "accepted", "ignored", "rewrites")


def today() -> date:
    return datetime.now(UTC).date()


async def increment_usage(session: AsyncSession, user_id: uuid.UUID, **counts: int) -> None:
    values = {k: int(counts.get(k, 0)) for k in _COUNTERS}
    if not any(values.values()):
        return
    stmt = pg_insert(UsageDaily).values(user_id=user_id, day=today(), **values)
    stmt = stmt.on_conflict_do_update(
        index_elements=[UsageDaily.user_id, UsageDaily.day],
        set_={k: getattr(UsageDaily, k) + stmt.excluded[k] for k in _COUNTERS if values[k]},
    )
    await session.execute(stmt)


async def record_usage_background(
    sessionmaker: async_sessionmaker[AsyncSession], user_id: uuid.UUID, **counts: int
) -> None:
    """Runs after the response is sent so counters never add request latency."""
    try:
        async with sessionmaker() as session:
            await increment_usage(session, user_id, **counts)
            await session.commit()
    except Exception:  # pragma: no cover - counters are best-effort
        log.warning("usage counter update failed", exc_info=True)


async def store_feedback(
    session: AsyncSession, user_id: uuid.UUID | None, batch: FeedbackBatch
) -> None:
    session.add_all(
        SuggestionFeedback(
            user_id=user_id,
            rule_id=e.rule_id,
            category=e.category.value,
            source=e.source.value,
            action=e.action,
            client=batch.client.value,
        )
        for e in batch.events
    )
    if user_id is not None:
        accepted = sum(1 for e in batch.events if e.action == "accepted")
        ignored = sum(1 for e in batch.events if e.action != "accepted")
        await increment_usage(session, user_id, accepted=accepted, ignored=ignored)


async def usage_summary(session: AsyncSession, user_id: uuid.UUID, days: int) -> UsageSummary:
    since = today() - timedelta(days=days - 1)
    rows = list(
        await session.scalars(
            select(UsageDaily)
            .where(UsageDaily.user_id == user_id, UsageDaily.day >= since)
            .order_by(UsageDaily.day)
        )
    )
    daily = [UsageDay(day=r.day, **{k: getattr(r, k) for k in _COUNTERS}) for r in rows]
    totals_row = await session.execute(
        select(*(func.coalesce(func.sum(getattr(UsageDaily, k)), 0) for k in _COUNTERS)).where(
            UsageDaily.user_id == user_id, UsageDaily.day >= since
        )
    )
    sums = dict(zip(_COUNTERS, (int(v) for v in totals_row.one()), strict=True))
    totals = UsageDay(day=today(), **sums) if rows else None
    decided = sums["accepted"] + sums["ignored"]
    rate = round(sums["accepted"] / decided, 3) if decided else None
    return UsageSummary(days=days, totals=totals, acceptance_rate=rate, daily=daily)
