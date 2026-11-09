"""Latency benchmark for /v1/check against a running API.

Usage: python scripts/bench_check.py [base_url] [iterations]
Simulates typing: each request appends a few words to the previous text, so the
paragraph cache behaves as it does in real editors.
"""

from __future__ import annotations

import statistics
import sys
import time

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
ITERATIONS = int(sys.argv[2]) if len(sys.argv) > 2 else 60

PARAGRAPHS = [
    "Hi team, I wanted to give you a quick update on the project. We was able to finish the "
    "first milestone on time, and the client seem happy with the results.",
    "Next week we will focus on teh reporting module. Please send me you feedback before "
    "Thursday so I can update the plan.",
    "Thanks for all the hard work everyone have put in. Let me know if their are any blockers.",
]


def main() -> None:
    words = " ".join(PARAGRAPHS).split(" ")
    timings: list[float] = []
    server: list[float] = []
    with httpx.Client(base_url=BASE, timeout=10) as client:
        client.post("/v1/check", json={"text": "warm up the engine."})
        for i in range(ITERATIONS):
            n = 4 + (i * len(words)) // ITERATIONS
            text = " ".join(words[:n])
            started = time.perf_counter()
            res = client.post("/v1/check", json={"text": text, "mode": "fast"})
            timings.append((time.perf_counter() - started) * 1000)
            res.raise_for_status()
            server.append(res.json()["engine"]["latency_ms"])
    timings.sort()
    p = lambda q: timings[min(len(timings) - 1, int(q * len(timings)))]  # noqa: E731
    print(
        f"requests={len(timings)}  p50={p(0.5):.0f}ms  p95={p(0.95):.0f}ms  max={timings[-1]:.0f}ms"
    )
    print(f"server engine latency: median={statistics.median(server):.0f}ms")


if __name__ == "__main__":
    main()
