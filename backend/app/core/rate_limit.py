"""In-process token-bucket rate limiter.

Single-instance deployments use this directly; the ``RateLimiter`` interface is
small enough to back with Redis for horizontally-scaled deployments.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass


@dataclass(slots=True)
class _Bucket:
    tokens: float
    updated: float


@dataclass(frozen=True, slots=True)
class RateDecision:
    allowed: bool
    retry_after: int  # seconds
    remaining: int


class RateLimiter:
    def __init__(self, *, max_keys: int = 100_000, clock=time.monotonic) -> None:
        self._buckets: dict[str, _Bucket] = {}
        self._max_keys = max_keys
        self._clock = clock

    def hit(self, key: str, per_minute: int, cost: float = 1.0) -> RateDecision:
        capacity = float(max(per_minute, 1))
        rate = capacity / 60.0  # tokens per second
        now = self._clock()
        bucket = self._buckets.get(key)
        if bucket is None:
            if len(self._buckets) >= self._max_keys:
                self._evict(now)
            bucket = _Bucket(tokens=capacity, updated=now)
            self._buckets[key] = bucket
        else:
            bucket.tokens = min(capacity, bucket.tokens + (now - bucket.updated) * rate)
            bucket.updated = now

        if bucket.tokens >= cost:
            bucket.tokens -= cost
            return RateDecision(True, 0, int(bucket.tokens))
        retry = math.ceil((cost - bucket.tokens) / rate)
        return RateDecision(False, max(retry, 1), 0)

    def _evict(self, now: float) -> None:
        # Drop the stalest half; full buckets idle > 60 s carry no state worth keeping.
        ordered = sorted(self._buckets.items(), key=lambda kv: kv[1].updated)
        for key, _ in ordered[: len(ordered) // 2]:
            del self._buckets[key]

    def reset(self) -> None:
        self._buckets.clear()
