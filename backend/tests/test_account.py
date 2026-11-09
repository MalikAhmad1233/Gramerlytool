from __future__ import annotations

from sqlalchemy import func, select

from app.models import DictionaryEntry, SuggestionFeedback, User
from tests.conftest import bearer, register


async def test_settings_defaults_and_partial_update(client):
    auth = bearer(await register(client))
    res = await client.get("/v1/settings", headers=auth)
    assert res.status_code == 200
    data = res.json()
    assert data["language"] == "en-US"
    assert data["default_style"] == "neutral"
    assert data["enabled_categories"] == ["grammar", "spelling", "punctuation", "style", "clarity"]

    res = await client.put(
        "/v1/settings",
        headers=auth,
        json={
            "default_style": "formal",
            "disabled_sites": ["Mail.Google.com", "mail.google.com", "*.bank.example"],
            "disabled_apps": ["KeePass.exe"],
        },
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["default_style"] == "formal"
    assert data["language"] == "en-US"  # untouched
    assert data["disabled_sites"] == ["mail.google.com", "*.bank.example"]
    assert data["disabled_apps"] == ["keepass.exe"]


async def test_settings_validation(client):
    auth = bearer(await register(client))
    for body in (
        {"language": "xx-XX"},
        {"default_style": "shouty"},
        {"disabled_sites": ["not a host"]},
        {"enabled_categories": ["vibes"]},
        {"disabled_rules": ["bad rule id!"]},
    ):
        res = await client.put("/v1/settings", headers=auth, json=body)
        assert res.status_code == 422, body


async def test_settings_require_auth(client):
    assert (await client.get("/v1/settings")).status_code == 401


async def test_dictionary_crud_is_case_insensitive(client):
    auth = bearer(await register(client))
    res = await client.post("/v1/dictionary", headers=auth, json={"word": "WriteMind"})
    assert res.status_code == 201
    res = await client.post("/v1/dictionary", headers=auth, json={"word": "writemind"})
    assert res.status_code == 200  # already present
    res = await client.post("/v1/dictionary", headers=auth, json={"word": "Kubernetes"})
    assert res.json()["words"] == ["Kubernetes", "WriteMind"]
    assert res.json()["count"] == 2

    bad = await client.post("/v1/dictionary", headers=auth, json={"word": "two words"})
    assert bad.status_code == 422

    assert (await client.delete("/v1/dictionary/WRITEMIND", headers=auth)).status_code == 204
    assert (await client.delete("/v1/dictionary/WRITEMIND", headers=auth)).status_code == 404
    res = await client.get("/v1/dictionary", headers=auth)
    assert res.json()["words"] == ["Kubernetes"]


async def test_dictionaries_are_isolated_between_users(client):
    a = bearer(await register(client, "a@example.com"))
    b = bearer(await register(client, "b@example.com"))
    await client.post("/v1/dictionary", headers=a, json={"word": "Zyxt"})
    assert (await client.get("/v1/dictionary", headers=b)).json()["words"] == []
    assert (await client.delete("/v1/dictionary/Zyxt", headers=b)).status_code == 404


async def test_feedback_guest_and_user_updates_usage(client, app):
    events = [
        {
            "rule_id": "MORFOLOGIK_RULE_EN_US",
            "category": "spelling",
            "source": "languagetool",
            "action": "accepted",
        },
        {"rule_id": "AI_GRAMMAR", "category": "grammar", "source": "ai", "action": "ignored"},
    ]
    guest = await client.post("/v1/feedback", json={"client": "chrome-extension", "events": events})
    assert guest.status_code == 202

    auth = bearer(await register(client))
    res = await client.post(
        "/v1/feedback", headers=auth, json={"client": "windows-desktop", "events": events}
    )
    assert res.status_code == 202
    summary = (await client.get("/v1/usage/summary?days=7", headers=auth)).json()
    assert summary["totals"]["accepted"] == 1
    assert summary["totals"]["ignored"] == 1
    assert summary["acceptance_rate"] == 0.5

    async with app.state.db.sessionmaker() as s:
        assert await s.scalar(select(func.count()).select_from(SuggestionFeedback)) == 4
        guests = await s.scalar(
            select(func.count())
            .select_from(SuggestionFeedback)
            .where(SuggestionFeedback.user_id.is_(None))
        )
        assert guests == 2

    bad = await client.post(
        "/v1/feedback",
        json={"client": "chrome-extension", "events": [{**events[0], "action": "launched"}]},
    )
    assert bad.status_code == 422


async def test_usage_summary_empty(client):
    auth = bearer(await register(client))
    summary = (await client.get("/v1/usage/summary", headers=auth)).json()
    assert summary == {"days": 7, "totals": None, "acceptance_rate": None, "daily": []}


async def test_export_contains_account_data_only(client):
    auth = bearer(await register(client))
    await client.post("/v1/dictionary", headers=auth, json={"word": "Gramerly"})
    res = await client.get("/v1/me/export", headers=auth)
    assert res.status_code == 200
    assert "attachment" in res.headers["content-disposition"]
    data = res.json()
    assert data["dictionary"] == ["Gramerly"]
    assert data["user"]["email"] == "ada@example.com"
    assert "password_hash" not in res.text


async def test_delete_account_requires_password_and_cascades(client, app):
    tokens = await register(client)
    auth = bearer(tokens)
    await client.post("/v1/dictionary", headers=auth, json={"word": "Gone"})
    await client.post(
        "/v1/feedback",
        headers=auth,
        json={
            "client": "web",
            "events": [
                {"rule_id": "R1", "category": "style", "source": "writemind", "action": "accepted"}
            ],
        },
    )
    wrong = await client.request("DELETE", "/v1/me", headers=auth, json={"password": "nope"})
    assert wrong.status_code == 403
    ok = await client.request("DELETE", "/v1/me", headers=auth, json={"password": "Lovelace#1843"})
    assert ok.status_code == 204

    async with app.state.db.sessionmaker() as s:
        assert await s.scalar(select(func.count()).select_from(User)) == 0
        assert await s.scalar(select(func.count()).select_from(DictionaryEntry)) == 0
        # Feedback survives only as anonymous rule statistics.
        remaining = list(await s.scalars(select(SuggestionFeedback.user_id)))
        assert remaining == [None]
    assert (await client.get("/v1/me", headers=auth)).status_code == 401
    refresh = await client.post("/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refresh.status_code == 401
