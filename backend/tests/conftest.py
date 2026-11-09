from __future__ import annotations

import os
from collections.abc import AsyncIterator

import httpx
import pytest
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import command
from app.core.config import Settings
from app.main import create_app

TEST_DB_URL = os.environ.get(
    "WRITEMIND_TEST_DATABASE_URL",
    "postgresql+asyncpg://writemind:writemind@localhost:5432/writemind_test",
)
LT_URL = os.environ.get("WRITEMIND_LANGUAGETOOL_URL", "http://localhost:8081")
TABLES = [
    "suggestion_feedback",
    "usage_daily",
    "dictionary_entries",
    "user_settings",
    "refresh_tokens",
    "users",
]


def make_settings(**overrides) -> Settings:
    base = dict(
        environment="test",
        database_url=TEST_DB_URL,
        languagetool_url=LT_URL,
        ai_provider="none",
        log_level="WARNING",
        cache_ttl_seconds=600,
    )
    base.update(overrides)
    return Settings(**base)


def _alembic(connection, *steps: tuple[str, str]) -> None:
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    cfg.attributes["connection"] = connection
    for action, target in steps:
        getattr(command, action)(cfg, target)


@pytest.fixture(scope="session", autouse=True)
async def _database() -> AsyncIterator[None]:
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        # Exercise the migration both ways, then leave the schema at head.
        await conn.run_sync(
            _alembic, ("upgrade", "head"), ("downgrade", "base"), ("upgrade", "head")
        )
    await engine.dispose()
    yield


@pytest.fixture
async def app_factory():
    """Builds an app (with lifespan) for custom settings; cleans tables first."""
    contexts = []

    async def build(**overrides):
        app = create_app(make_settings(**overrides))
        ctx = app.router.lifespan_context(app)
        await ctx.__aenter__()
        contexts.append(ctx)
        async with app.state.db.engine.begin() as conn:
            await conn.execute(text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
        return app

    yield build
    for ctx in reversed(contexts):
        await ctx.__aexit__(None, None, None)


@pytest.fixture
async def app(app_factory):
    return await app_factory()


@pytest.fixture
async def client(app) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app, client=("203.0.113.7", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


async def register(
    client: httpx.AsyncClient, email: str = "ada@example.com", password: str = "Lovelace#1843"
) -> dict:
    res = await client.post(
        "/v1/auth/register",
        json={
            "email": email,
            "password": password,
            "display_name": "Ada",
            "client": "chrome-extension",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def bearer(tokens: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}
