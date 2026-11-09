"""HTTP-level tests for /v1/check and /v1/rewrite (real LanguageTool, fake AI)."""

from __future__ import annotations

import logging

import httpx
import pytest

from tests.conftest import bearer, register
from tests.test_engine_lt import _lt_available

pytestmark = [
    pytest.mark.languagetool,
    pytest.mark.skipif(not _lt_available(), reason="LanguageTool server not reachable"),
]

SECRET_SENTENCE = "My confidential plan is to recieve the merger docs on teh 14th."


async def test_guest_check(client):
    res = await client.post(
        "/v1/check",
        json={"text": SECRET_SENTENCE, "client": {"kind": "chrome-extension", "app": "gmail"}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert res.headers["cache-control"] == "no-store"
    assert {s["original"] for s in body["suggestions"]} >= {"recieve", "teh"}
    assert body["engine"]["languagetool"] == "ok"
    assert body["engine"]["ai"] == "unavailable"
    assert len(body["text_hash"]) == 32
    suggestion = body["suggestions"][0]
    assert set(suggestion) == {
        "id",
        "fingerprint",
        "offset",
        "length",
        "original",
        "replacements",
        "category",
        "severity",
        "title",
        "message",
        "rule_id",
        "source",
        "confidence",
    }


async def test_text_is_never_logged(client, caplog):
    caplog.set_level(logging.DEBUG)
    await client.post("/v1/check", json={"text": SECRET_SENTENCE})
    await client.post("/v1/rewrite", json={"text": SECRET_SENTENCE, "style": "formal"})
    assert "confidential" not in caplog.text
    assert any(r.name == "writemind.access" for r in caplog.records)


async def test_signed_in_check_uses_synced_dictionary_and_counts_usage(client):
    auth = bearer(await register(client))
    text = "Ahmadzai recieved the files."
    first = (await client.post("/v1/check", headers=auth, json={"text": text})).json()
    assert "Ahmadzai" in {s["original"] for s in first["suggestions"]}

    await client.post("/v1/dictionary", headers=auth, json={"word": "Ahmadzai"})
    second = (await client.post("/v1/check", headers=auth, json={"text": text})).json()
    assert "Ahmadzai" not in {s["original"] for s in second["suggestions"]}  # cache invalidated

    await client.put(
        "/v1/settings", headers=auth, json={"disabled_rules": ["MORFOLOGIK_RULE_EN_US"]}
    )
    third = (await client.post("/v1/check", headers=auth, json={"text": text})).json()
    assert third["suggestions"] == []

    usage = (await client.get("/v1/usage/summary", headers=auth)).json()
    assert usage["totals"]["checks"] == 3
    assert usage["totals"]["characters"] == 3 * len(text)


async def test_guest_dictionary_in_request(client):
    res = await client.post(
        "/v1/check", json={"text": "Ahmadzai recieved it.", "dictionary": ["ahmadzai"]}
    )
    assert {s["original"] for s in res.json()["suggestions"]} == {"recieved"}


async def test_check_validation_and_limits(app_factory):
    app = await app_factory(max_check_chars=50, max_rewrite_chars=20)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        too_long = await c.post("/v1/check", json={"text": "x" * 51})
        assert too_long.status_code == 413
        assert too_long.json()["error"]["code"] == "text_too_long"
        bad_lang = await c.post("/v1/check", json={"text": "hi", "language": "xx"})
        assert bad_lang.status_code == 422
        bad_mode = await c.post("/v1/check", json={"text": "hi", "mode": "turbo"})
        assert bad_mode.status_code == 422
        rewrite_long = await c.post("/v1/rewrite", json={"text": "y" * 21})
        assert rewrite_long.status_code == 413
        empty = await c.post("/v1/rewrite", json={"text": "   "})
        assert empty.status_code == 422


async def test_check_rate_limit_for_guests(app_factory):
    app = await app_factory(rate_check_guest=2)
    transport = httpx.ASGITransport(app=app, client=("192.0.2.10", 1))
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        codes = [
            (await c.post("/v1/check", json={"text": "Hi there."})).status_code for _ in range(3)
        ]
        assert codes == [200, 200, 429]


async def test_rewrite_endpoint_offline(client):
    res = await client.post(
        "/v1/rewrite",
        json={"text": "hey can u send me the report asap", "style": "formal", "count": 2},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["engine"] == "rules"
    assert body["alternatives"][0]["text"].startswith("Hello, can you send me the report")
    assert "as soon as possible" in body["alternatives"][0]["text"]
