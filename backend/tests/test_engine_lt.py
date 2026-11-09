"""Engine integration tests against a real LanguageTool server."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.engine.ai.provider import AIEdit, NullProvider
from app.engine.languagetool import LanguageToolClient
from app.engine.offsets import Utf16Index
from app.engine.pipeline import Engine
from app.engine.types import UserContext
from app.schemas.check import CheckRequest, RewriteRequest
from app.schemas.common import Category, Source
from tests.conftest import LT_URL, make_settings
from tests.fakes import FakeProvider

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "shared" / "fixtures" / "accuracy-en.json").read_text("utf-8")
)


def _lt_available() -> bool:
    try:
        return httpx.get(f"{LT_URL}/v2/languages", timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = [
    pytest.mark.languagetool,
    pytest.mark.skipif(not _lt_available(), reason="LanguageTool server not reachable"),
]


@pytest.fixture
async def engine_factory():
    clients: list[LanguageToolClient] = []

    def build(provider=None, **overrides) -> Engine:
        settings = make_settings(**overrides)
        lt = LanguageToolClient(settings.languagetool_url)
        clients.append(lt)
        return Engine(settings, lt, provider or NullProvider())

    yield build
    for client in clients:
        await client.close()


@pytest.mark.parametrize("case", FIXTURE["errors"], ids=lambda c: c["text"][:40])
async def test_accuracy_fixture_errors_detected(engine_factory, case):
    engine = engine_factory(cache_ttl_seconds=0)
    result = await engine.check(CheckRequest(text=case["text"]), UserContext())
    found = [(s.original, s.replacements) for s in result.suggestions]
    assert any(o == case["original"] and case["replacement"] in r for o, r in found), found


@pytest.mark.parametrize("text", FIXTURE["clean"], ids=lambda t: t[:40])
async def test_accuracy_fixture_clean_text_has_no_suggestions(engine_factory, text):
    engine = engine_factory(cache_ttl_seconds=0)
    result = await engine.check(CheckRequest(text=text), UserContext())
    assert [(s.original, s.rule_id) for s in result.suggestions] == []
    assert result.stats.score == 100


async def test_offsets_are_utf16_and_slice_correctly(engine_factory):
    text = "Great news 😀🎉 — I recieved teh files.\n\nNext paragrpah has 👍🏽 an eror."
    result = await engine_factory().check(CheckRequest(text=text), UserContext())
    index = Utf16Index(text)
    utf16 = text.encode("utf-16-le")
    originals = []
    for s in result.suggestions:
        # Slicing the UTF-16 encoding with the API offsets yields exactly `original`.
        assert utf16[s.offset * 2 : (s.offset + s.length) * 2].decode("utf-16-le") == s.original
        cp = index.to_codepoint(s.offset)
        assert text[cp : cp + len(s.original)] == s.original
        originals.append(s.original)
    assert {"recieved", "teh", "paragrpah", "eror"} <= set(originals)


async def test_paragraph_cache_rechecks_only_edited_paragraph(engine_factory):
    engine = engine_factory()
    first = "She go to school.\n\nI recieved it."
    r1 = await engine.check(CheckRequest(text=first), UserContext())
    assert (r1.engine.paragraphs_checked, r1.engine.paragraphs_cached) == (2, 0)
    edited = "She go to school.\n\nI recieved it yesterday."
    r2 = await engine.check(CheckRequest(text=edited), UserContext())
    assert (r2.engine.paragraphs_checked, r2.engine.paragraphs_cached) == (1, 1)
    # Cached suggestions keep correct absolute offsets.
    assert [s.original for s in r2.suggestions] == ["go", "recieved"]
    assert r2.suggestions[1].offset == edited.index("recieved")


async def test_personal_dictionary_disabled_rules_and_categories(engine_factory):
    engine = engine_factory()
    text = "Ahmadzai recieved the files and she go home."
    base = await engine.check(CheckRequest(text=text), UserContext())
    assert {"Ahmadzai", "recieved", "go"} <= {s.original for s in base.suggestions}

    ctx = UserContext(dictionary=frozenset({"ahmadzai"}), disabled_rules=frozenset({"HE_VERB_AGR"}))
    filtered = await engine.check(CheckRequest(text=text), ctx)
    assert {s.original for s in filtered.suggestions} == {"recieved"}

    spelling_off = UserContext(categories=frozenset(set(Category) - {Category.spelling}))
    result = await engine.check(CheckRequest(text=text), spelling_off)
    assert all(s.category is not Category.spelling for s in result.suggestions)


async def test_identifiers_are_not_spelling_errors(engine_factory):
    text = "Deploy the WriteMind API to AWS with kubectl v2 and the user_id field."
    result = await engine_factory().check(CheckRequest(text=text), UserContext())
    flagged = {s.original for s in result.suggestions if s.category is Category.spelling}
    assert not flagged & {"WriteMind", "API", "AWS", "v2", "user_id"}


async def test_style_profiles(engine_factory):
    engine = engine_factory()
    text = "Hey, I'm gonna send u the report asap!!!"
    neutral = await engine.check(CheckRequest(text=text, style="neutral"), UserContext())
    formal = await engine.check(CheckRequest(text=text, style="formal"), UserContext())
    casual = await engine.check(CheckRequest(text=text, style="casual"), UserContext())
    formal_rules = {s.rule_id for s in formal.suggestions}
    assert {"WM_FORMAL_CONTRACTION", "WM_INFORMAL_WORD", "WM_MULTIPLE_PUNCTUATION"} <= formal_rules
    assert not {s.rule_id for s in neutral.suggestions} & {
        "WM_FORMAL_CONTRACTION",
        "WM_INFORMAL_WORD",
    }
    assert not {s.rule_id for s in casual.suggestions} & formal_rules


async def test_chat_app_relaxes_capitalisation(engine_factory):
    engine = engine_factory()
    text = "hey are you coming tonight"
    gmail = await engine.check(CheckRequest(text=text, client={"app": "gmail"}), UserContext())
    whatsapp = await engine.check(
        CheckRequest(text=text, client={"app": "whatsapp"}), UserContext()
    )
    assert any(s.rule_id == "UPPERCASE_SENTENCE_START" for s in gmail.suggestions)
    assert not any(s.rule_id == "UPPERCASE_SENTENCE_START" for s in whatsapp.suggestions)


async def test_full_mode_merges_ai_with_languagetool(engine_factory):
    text = "The weather are nice and she go to school."
    provider = FakeProvider(
        corrections={text: "The weather is nice and she goes to school."},
        edits={text: [AIEdit("are", "is", "grammar", "“Weather” is singular, so use “is”.")]},
    )
    engine = engine_factory(provider)
    fast = await engine.check(CheckRequest(text=text, mode="fast"), UserContext())
    assert fast.engine.ai == "skipped" and provider.correct_calls == []
    assert {s.original for s in fast.suggestions} == {"go"}

    full = await engine.check(CheckRequest(text=text, mode="full"), UserContext())
    assert full.engine.ai == "used"
    by_original = {s.original: s for s in full.suggestions}
    assert by_original["are"].source is Source.ai
    assert by_original["are"].message == "“Weather” is singular, so use “is”."
    # LanguageTool and AI agree on "goes": merged into one suggestion with boosted confidence.
    go = by_original["go"]
    assert go.replacements[0] == "goes" and go.confidence > 0.9
    assert len(full.suggestions) == 2

    again = await engine.check(CheckRequest(text=text, mode="full"), UserContext())
    assert len(provider.correct_calls) == 1  # AI result cached per paragraph
    assert again.suggestions == full.suggestions


async def test_ai_never_receives_personal_data(engine_factory):
    text = "Email anna.k@corp.example or call +1 415 555 0134 about teh contract."
    masked_text = "Email [[EMAIL_1]] or call [[PHONE_1]] about teh contract."
    provider = FakeProvider(corrections={masked_text: masked_text.replace("teh", "the")})
    result = await engine_factory(provider).check(
        CheckRequest(text=text, mode="full"), UserContext()
    )
    assert provider.correct_calls == [masked_text]
    assert all("anna.k" not in call and "555" not in call for call in provider.correct_calls)
    teh = [s for s in result.suggestions if s.original == "teh"]
    assert len(teh) == 1 and teh[0].offset == text.index("teh")


async def test_ai_failures_degrade_gracefully(engine_factory):
    text = "She go to school every day."
    failing = await engine_factory(FakeProvider(fail=True)).check(
        CheckRequest(text=text, mode="full"), UserContext()
    )
    assert failing.engine.ai == "error" and [s.original for s in failing.suggestions] == ["go"]

    slow = await engine_factory(FakeProvider(delay=5), ai_timeout_seconds=0.2).check(
        CheckRequest(text=text, mode="full"), UserContext()
    )
    assert slow.engine.ai == "error" and slow.engine.latency_ms < 3000

    off = await engine_factory(FakeProvider()).check(
        CheckRequest(text=text, mode="full", ai=False), UserContext()
    )
    assert off.engine.ai == "disabled"
    unavailable = await engine_factory().check(CheckRequest(text=text, mode="full"), UserContext())
    assert unavailable.engine.ai == "unavailable"


async def test_languagetool_outage_still_returns_rule_results(engine_factory):
    engine = engine_factory(languagetool_url="http://127.0.0.1:9", cache_ttl_seconds=0)
    result = await engine.check(
        CheckRequest(text="Your welcome, everyone have fun!", style="neutral"), UserContext()
    )
    assert result.engine.languagetool == "error"
    assert {s.rule_id for s in result.suggestions} == {
        "WM_CONFUSED_WORDS",
        "WM_INDEFINITE_PRONOUN_AGREEMENT",
    }


async def test_empty_and_whitespace_text(engine_factory):
    result = await engine_factory().check(CheckRequest(text="   \n\n  "), UserContext())
    assert result.suggestions == [] and result.stats.words == 0 and result.stats.score == 100


async def test_rewrite_offline_rules(engine_factory):
    engine = engine_factory()
    text = "hey i just wanted to let u know that i cant make it due to the fact that im sick"
    formal = await engine.rewrite(RewriteRequest(text=text, style="formal", count=2), UserContext())
    assert formal.engine == "rules"
    best = formal.alternatives[0].text
    assert best.startswith("Hello, I") and "cannot" in best and "you" in best and best.endswith(".")
    concise = await engine.rewrite(RewriteRequest(text=text, style="concise"), UserContext())
    assert "because" in concise.alternatives[0].text
    assert all(a.meaning_preserved for a in formal.alternatives + concise.alternatives)


async def test_rewrite_with_ai_guards_meaning_and_restores_pii(engine_factory):
    text = "pls send the 3 files to mia@corp.example by friday"
    masked = "pls send the 3 files to [[EMAIL_1]] by friday"
    provider = FakeProvider(
        rewrites={
            masked: [
                "Please send the 3 files to [[EMAIL_1]] by Friday.",
                "Please send the 5 files to [[EMAIL_1]] by Friday.",  # number changed → rejected
                "Kindly forward the three files by Friday.",  # e-mail + number lost → rejected
                "Could you send the 3 files to [[EMAIL_1]] by Friday?",
            ]
        }
    )
    result = await engine_factory(provider).rewrite(
        RewriteRequest(text=text, style="professional", count=3), UserContext()
    )
    assert result.engine == "ai"
    texts = [a.text for a in result.alternatives]
    assert texts[:2] == [
        "Please send the 3 files to mia@corp.example by Friday.",
        "Could you send the 3 files to mia@corp.example by Friday?",
    ]
    assert all("5 files" not in t and "three" not in t for t in texts)
    assert provider.rewrite_calls == [masked]
