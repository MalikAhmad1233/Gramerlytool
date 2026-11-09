from __future__ import annotations

from datetime import UTC, datetime, timedelta

import jwt
from sqlalchemy import select

from app.models import RefreshToken, User
from tests.conftest import bearer, register


async def test_register_returns_tokens_and_user(client):
    tokens = await register(client, email="  Ada@Example.COM ")
    assert tokens["token_type"] == "bearer"
    assert tokens["expires_in"] == 15 * 60
    assert tokens["user"]["email"] == "ada@example.com"  # normalised
    assert tokens["user"]["plan"] == "free"
    me = await client.get("/v1/me", headers=bearer(tokens))
    assert me.status_code == 200
    assert me.json()["display_name"] == "Ada"


async def test_password_is_hashed_with_argon2_and_refresh_token_only_hashed(client, app):
    tokens = await register(client)
    async with app.state.db.sessionmaker() as s:
        user = await s.scalar(select(User))
        assert user.password_hash.startswith("$argon2id$")
        token = await s.scalar(select(RefreshToken))
        assert token.token_hash != tokens["refresh_token"]
        assert len(token.token_hash) == 64


async def test_duplicate_email_conflict(client):
    await register(client)
    res = await client.post(
        "/v1/auth/register", json={"email": "ADA@example.com", "password": "Another#Pass1"}
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "email_taken"


async def test_weak_password_rejected_without_echoing_it(client):
    res = await client.post(
        "/v1/auth/register", json={"email": "bob@example.com", "password": "alllowercase"}
    )
    assert res.status_code == 422
    body = res.json()
    assert body["error"]["code"] == "validation_error"
    assert "alllowercase" not in res.text


async def test_login_success_and_failure(client):
    await register(client)
    ok = await client.post(
        "/v1/auth/login", json={"email": "ada@example.com", "password": "Lovelace#1843"}
    )
    assert ok.status_code == 200
    bad = await client.post(
        "/v1/auth/login", json={"email": "ada@example.com", "password": "wrong-password"}
    )
    assert bad.status_code == 401
    assert bad.json()["error"]["code"] == "invalid_credentials"
    unknown = await client.post(
        "/v1/auth/login", json={"email": "nobody@example.com", "password": "Whatever#1"}
    )
    assert unknown.status_code == 401
    assert unknown.json()["error"]["code"] == "invalid_credentials"


async def test_refresh_rotates_and_reuse_revokes_family(client):
    first = await register(client)
    second = await client.post("/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert second.status_code == 200
    second = second.json()
    assert second["refresh_token"] != first["refresh_token"]

    # Replaying the rotated token is treated as theft: the whole family dies.
    replay = await client.post("/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert replay.status_code == 401
    after = await client.post("/v1/auth/refresh", json={"refresh_token": second["refresh_token"]})
    assert after.status_code == 401


async def test_logout_revokes_refresh_token(client):
    tokens = await register(client)
    out = await client.post("/v1/auth/logout", json={"refresh_token": tokens["refresh_token"]})
    assert out.status_code == 204
    res = await client.post("/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert res.status_code == 401


async def test_expired_refresh_token_rejected(client, app):
    tokens = await register(client)
    async with app.state.db.sessionmaker() as s:
        record = await s.scalar(select(RefreshToken))
        record.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await s.commit()
    res = await client.post("/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert res.status_code == 401


async def test_invalid_and_wrong_type_tokens(client, app):
    tokens = await register(client)
    assert (await client.get("/v1/me")).status_code == 401
    assert (await client.get("/v1/me", headers={"Authorization": "Bearer junk"})).status_code == 401
    assert (await client.get("/v1/me", headers={"Authorization": "Basic abc"})).status_code == 401

    secret = app.state.settings.jwt_secret.get_secret_value()
    claims = jwt.decode(tokens["access_token"], secret, algorithms=["HS256"], issuer="writemind-ai")
    claims["typ"] = "refresh"
    forged = jwt.encode(claims, secret, algorithm="HS256")
    res = await client.get("/v1/me", headers={"Authorization": f"Bearer {forged}"})
    assert res.status_code == 401

    claims["typ"] = "access"
    other_key = jwt.encode(claims, "not-the-secret-" * 4, algorithm="HS256")
    res = await client.get("/v1/me", headers={"Authorization": f"Bearer {other_key}"})
    assert res.status_code == 401
    assert res.headers["www-authenticate"] == "Bearer"


async def test_auth_rate_limit(app_factory):
    import httpx

    app = await app_factory(rate_auth=3)
    transport = httpx.ASGITransport(app=app, client=("198.51.100.1", 1234))
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        codes = [
            (
                await c.post("/v1/auth/login", json={"email": "x@example.com", "password": "nope"})
            ).status_code
            for _ in range(4)
        ]
        assert codes[:3] == [401, 401, 401]
        assert codes[3] == 429
        last = await c.post("/v1/auth/login", json={"email": "x@example.com", "password": "nope"})
        assert int(last.headers["retry-after"]) >= 1
