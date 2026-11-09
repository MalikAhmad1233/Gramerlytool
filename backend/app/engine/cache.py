"""In-memory TTL LRU cache for per-paragraph results.

Keys are SHA-256 digests; nothing is persisted to disk or shared across
processes. Set ``WRITEMIND_CACHE_TTL_SECONDS=0`` to disable entirely.
"""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from typing import Any


def cache_key(*parts: str) -> str:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part.encode("utf-8"))
        digest.update(b"\x1f")
    return digest.hexdigest()


class TTLCache:
    def __init__(self, max_entries: int, ttl_seconds: float, clock=time.monotonic) -> None:
        self._data: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._max = max_entries
        self._ttl = ttl_seconds
        self._clock = clock
        self.hits = 0
        self.misses = 0

    @property
    def enabled(self) -> bool:
        return self._ttl > 0 and self._max > 0

    def get(self, key: str) -> Any | None:
        if not self.enabled:
            return None
        item = self._data.get(key)
        if item is None:
            self.misses += 1
            return None
        expires, value = item
        if expires < self._clock():
            del self._data[key]
            self.misses += 1
            return None
        self._data.move_to_end(key)
        self.hits += 1
        return value

    def set(self, key: str, value: Any) -> None:
        if not self.enabled:
            return
        self._data[key] = (self._clock() + self._ttl, value)
        self._data.move_to_end(key)
        while len(self._data) > self._max:
            self._data.popitem(last=False)

    def clear(self) -> None:
        self._data.clear()

    def __len__(self) -> int:
        return len(self._data)
