"""AnthropicProvider request shape and response handling (SDK call stubbed; no network)."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.core.config import Settings
from app.engine.ai.provider import (
    CORRECTION_SCHEMA,
    AIError,
    AnthropicProvider,
    NullProvider,
    build_provider,
)


def _response(text: str | None, stop_reason: str = "end_turn"):
    content = [SimpleNamespace(type="thinking", thinking="")]
    if text is not None:
        content.append(SimpleNamespace(type="text", text=text))
    return SimpleNamespace(stop_reason=stop_reason, content=content)


def _provider(monkeypatch, response, *, fallbacks=True):
    provider = AnthropicProvider("sk-test", model="claude-opus-5-5", refusal_fallbacks=fallbacks)
    calls: list[dict] = []

    async def fake_create(**kwargs):
        calls.append(kwargs)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(provider._client.beta.messages, "create", fake_create)
    return provider, calls


async def test_correction_request_shape_and_parsing(monkeypatch):
    payload = {
        "corrected": "She goes home.",
        "edits": [
            {
                "original": "go",
                "replacement": "goes",
                "category": "grammar",
                "explanation": "Agreement.",
            }
        ],
    }
    provider, calls = _provider(monkeypatch, _response(json.dumps(payload)))
    result = await provider.correct("She go home.", language="en-US", style="neutral")
    assert result.corrected == "She goes home."
    assert result.edits[0].replacement == "goes"

    kwargs = calls[0]
    assert kwargs["model"] == "claude-opus-5-5"
    assert kwargs["output_config"]["effort"] == "low"
    assert kwargs["output_config"]["format"] == {"type": "json_schema", "schema": CORRECTION_SCHEMA}
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert kwargs["betas"] == ["server-side-fallback-2026-07-01"]
    assert kwargs["fallbacks"] == "default"
    user = kwargs["messages"][0]["content"]
    assert "<text>\nShe go home.\n</text>" in user and "<register>neutral</register>" in user
    assert "thinking" not in kwargs and "temperature" not in kwargs


async def test_rewrite_parsing(monkeypatch):
    payload = {"alternatives": [{"text": " Hello there. "}, {"text": ""}, {"text": "Hi!"}]}
    provider, calls = _provider(monkeypatch, _response(json.dumps(payload)), fallbacks=False)
    out = await provider.rewrite("hey", language="en-US", style="formal", count=2)
    assert out == ["Hello there.", "Hi!"]
    assert "betas" not in calls[0] and "fallbacks" not in calls[0]
    assert "<count>2</count>" in calls[0]["messages"][0]["content"]


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (_response(None, "refusal"), "refused"),
        (_response('{"corrected": "x"', "max_tokens"), "truncated"),
        (_response("not json"), "invalid json"),
        (_response("[1, 2]"), "unexpected json shape"),
        (_response(None), "no text block"),
    ],
)
async def test_response_failures_raise_ai_error(monkeypatch, response, message):
    provider, _ = _provider(monkeypatch, response)
    with pytest.raises(AIError, match=message):
        await provider.correct("text here", language="en-US", style="neutral")


async def test_sdk_exceptions_map_to_ai_error(monkeypatch):
    import anthropic
    import httpx

    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    provider, _ = _provider(monkeypatch, anthropic.APIConnectionError(request=request))
    with pytest.raises(AIError, match="connection error"):
        await provider.correct("x y z", language="en-US", style="neutral")


def test_build_provider_selection(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert isinstance(build_provider(Settings(ai_provider="anthropic")), NullProvider)
    assert isinstance(
        build_provider(Settings(ai_provider="anthropic", anthropic_api_key="sk-x")),
        AnthropicProvider,
    )
    assert isinstance(
        build_provider(Settings(ai_provider="none", anthropic_api_key="sk-x")), NullProvider
    )
