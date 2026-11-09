from __future__ import annotations

import pytest

from app.core.config import Settings
from app.core.rate_limit import RateLimiter


async def test_health_and_meta(client):
    assert (await client.get("/health")).json() == {"status": "ok"}
    meta = (await client.get("/v1/meta")).json()
    assert meta["offsets"] == "utf-16"
    assert "professional" in meta["styles"]
    assert {"code": "en-GB", "name": "English (UK)"} in meta["languages"]
    assert meta["ai_available"] is False


async def test_request_id_and_security_headers(client):
    res = await client.get("/health", headers={"X-Request-ID": "abc123"})
    assert res.headers["x-request-id"] == "abc123"
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["referrer-policy"] == "no-referrer"
    generated = await client.get("/health")
    assert len(generated.headers["x-request-id"]) == 16


async def test_sensitive_routes_are_not_cacheable(client):
    res = await client.post("/v1/auth/login", json={"email": "a@example.com", "password": "x"})
    assert res.headers["cache-control"] == "no-store"


async def test_error_envelope_for_unknown_route(client):
    res = await client.get("/v1/nope")
    assert res.status_code == 404
    err = res.json()["error"]
    assert err["code"] == "not_found"
    assert err["request_id"] == res.headers["x-request-id"]


async def test_body_size_limit(app_factory):
    import httpx

    app = await app_factory(max_body_bytes=1000)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        res = await c.post(
            "/v1/auth/login", content=b"x" * 5000, headers={"content-type": "application/json"}
        )
        assert res.status_code == 413
        assert res.json()["error"]["code"] == "payload_too_large"


async def test_cors_allows_chrome_extension_origin(client):
    origin = "chrome-extension://" + "a" * 32
    res = await client.options(
        "/v1/meta",
        headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
    )
    assert res.headers.get("access-control-allow-origin") == origin
    evil = await client.options(
        "/v1/meta",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert "access-control-allow-origin" not in evil.headers


def test_rate_limiter_refills_over_time():
    now = [0.0]
    limiter = RateLimiter(clock=lambda: now[0])
    assert all(limiter.hit("k", per_minute=2).allowed for _ in range(2))
    denied = limiter.hit("k", per_minute=2)
    assert not denied.allowed and denied.retry_after == 30
    now[0] += 30
    assert limiter.hit("k", per_minute=2).allowed
    assert limiter.hit("other", per_minute=2).allowed  # keys are independent


def test_rate_limiter_evicts_when_full():
    limiter = RateLimiter(max_keys=4, clock=lambda: 0.0)
    for i in range(10):
        limiter.hit(f"k{i}", per_minute=5)
    assert len(limiter._buckets) <= 4


def test_production_requires_strong_jwt_secret():
    with pytest.raises(ValueError, match="JWT_SECRET"):
        Settings(environment="production")
    Settings(environment="production", jwt_secret="x" * 40)


def test_ai_key_is_never_borrowed_implicitly(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "ambient-token")
    assert Settings(ai_provider="anthropic").ai_configured is False
    assert Settings(ai_provider="anthropic", anthropic_api_key="sk-test").ai_configured is True
    assert Settings(ai_provider="none", anthropic_api_key="sk-test").ai_configured is False
