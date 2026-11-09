from __future__ import annotations

import pytest

from app.engine.ai.corrections import diff_hunks, issues_from_correction
from app.engine.ai.meaning_guard import compare, token_change_ratio
from app.engine.ai.provider import AICorrection, AIEdit
from app.engine.ai.redaction import mask
from app.engine.cache import TTLCache, cache_key
from app.engine.merge import merge_issues
from app.engine.offsets import Utf16Index, utf16_len
from app.engine.profiles import map_category, profile_for
from app.engine.protect import overlaps_any, protected_spans
from app.engine.rewrite import apply_fixes, contract, expand_contractions, transform
from app.engine.rules import run_rules
from app.engine.segment import split_paragraphs
from app.engine.types import Issue
from app.schemas.common import Category, RewriteStyle, Severity, Source, Style

# --------------------------------------------------------------------- offsets


def test_utf16_index_handles_astral_characters():
    text = "I love 😀 it alot 👍🏽 ok"
    index = Utf16Index(text)
    cp = text.index("alot")
    assert index.to_utf16(cp) == cp + 1  # one emoji (2 units) before it
    assert index.to_codepoint(index.to_utf16(cp)) == cp
    assert index.utf16_length == utf16_len(text) == len(text.encode("utf-16-le")) // 2
    ok = text.index("ok")
    assert index.to_utf16(ok) == ok + 3  # 😀, 👍 are astral; the skin-tone modifier is too
    # An offset inside a surrogate pair snaps to the start of the character.
    assert index.to_codepoint(index.to_utf16(text.index("😀")) + 1) == text.index("😀")


def test_utf16_identity_fast_path():
    index = Utf16Index("plain ascii and é ü")
    assert index.to_utf16(10) == 10 and index.to_codepoint(10) == 10


# ----------------------------------------------------------------- segmentation


def test_split_paragraphs_on_blank_lines_and_word_paragraph_marks():
    text = "First line\nstill first.\n\n  \nSecond para.\rThird (Word).\u2029Fourth."
    segs = split_paragraphs(text)
    assert [s.text for s in segs] == [
        "First line\nstill first.",
        "Second para.",
        "Third (Word).",
        "Fourth.",
    ]
    for seg in segs:
        assert text[seg.start : seg.end] == seg.text


def test_split_paragraphs_keeps_crlf_lines_together():
    segs = split_paragraphs("Line one\r\nline two\r\n\r\nNext")
    assert [s.text for s in segs] == ["Line one\r\nline two", "Next"]


# ------------------------------------------------------------------- protection


@pytest.mark.parametrize(
    "snippet",
    [
        "https://exmaple.com/teh",
        "www.teh-site.org",
        "jon.doe@exmaple.com",
        "@johnsmyth",
        "#throwbackthursday",
        "`npm instal`",
        "C:\\Users\\teh\\file.txt",
        "/usr/lcoal/bin",
        ":thumbsup:",
        "writemind.ai",
    ],
)
def test_protected_spans_cover_technical_tokens(snippet):
    text = f"See {snippet} now"
    spans = protected_spans(text)
    start = text.index(snippet)
    assert overlaps_any(start, start + len(snippet), spans)
    assert not overlaps_any(0, 3, spans)


# ------------------------------------------------------------------------ cache


def test_ttl_cache_expiry_and_lru():
    now = [0.0]
    cache = TTLCache(max_entries=2, ttl_seconds=10, clock=lambda: now[0])
    cache.set("a", 1)
    cache.set("b", 2)
    assert cache.get("a") == 1
    cache.set("c", 3)  # evicts least recently used ("b")
    assert cache.get("b") is None and cache.get("c") == 3
    now[0] = 11
    assert cache.get("a") is None
    disabled = TTLCache(max_entries=10, ttl_seconds=0)
    disabled.set("x", 1)
    assert disabled.get("x") is None
    assert cache_key("a", "b") != cache_key("ab", "")


# ------------------------------------------------------------------------ rules


def _rules(text: str, style: Style) -> list[Issue]:
    return run_rules(text, profile_for(style, None), formal=style is Style.formal, language="en-US")


def test_formal_contractions_with_case_and_ambiguity():
    issues = _rules("Don't worry, it's been fine and it’s done.", Style.formal)
    by_original = {i.original: i.replacements for i in issues}
    assert by_original["Don't"] == ["Do not"]
    assert by_original["it’s"] == ["it is", "it has"]
    first_its = next(i for i in issues if i.original == "it's")
    assert first_its.replacements[0] == "it has"  # "it's been" → perfect tense
    assert all(i.source is Source.writemind and i.category is Category.style for i in issues)


def test_contractions_not_flagged_outside_formal():
    assert _rules("Don't worry, it's fine.", Style.professional) == []
    assert _rules("Don't worry, it's fine.", Style.neutral) == []


def test_informal_words_by_register():
    pro = {
        i.original: i.replacements
        for i in _rules("U gonna send the info ASAP? thx", Style.professional)
    }
    assert pro == {"U": ["You"], "gonna": ["going to"], "thx": ["thanks", "thank you"]}
    formal = {i.original for i in _rules("Send the info asap", Style.formal)}
    assert formal == {"info", "asap"}
    assert _rules("u gonna come?", Style.casual) == []
    # Words that merely contain the pattern are left alone.
    assert _rules("Your umbrella, yeast and thunder.", Style.professional) == []


def test_repeated_punctuation_rule():
    issues = _rules("Really?! Amazing!!! Why??", Style.professional)
    assert [(i.original, i.replacements[0]) for i in issues] == [("!!!", "!"), ("??", "?")]


def test_rules_only_for_english():
    issues = run_rules("gonna", profile_for(Style.formal, None), formal=True, language="de-DE")
    assert issues == []


def test_category_mapping():
    assert map_category("TYPOS", "misspelling", "MORFOLOGIK_RULE_EN_US") is Category.spelling
    assert map_category("TYPOS", "misspelling", "IT_IS") is Category.grammar
    assert map_category("PUNCTUATION", "typographical", "COMMA") is Category.punctuation
    assert map_category("REDUNDANCY", "style", "X") is Category.clarity
    assert map_category("UNKNOWN", "other", "X") is Category.grammar


def test_chat_apps_use_casual_profile():
    assert profile_for(Style.neutral, "whatsapp").level == "default"
    assert "UPPERCASE_SENTENCE_START" in profile_for(Style.neutral, "whatsapp").disabled_rules
    assert "UPPERCASE_SENTENCE_START" not in profile_for(Style.neutral, "gmail").disabled_rules
    assert profile_for(Style.formal, "whatsapp").level == "picky"  # explicit style wins


# ---------------------------------------------------------------- meaning guard


@pytest.mark.parametrize(
    ("original", "candidate", "reason"),
    [
        ("Pay $1,200 by Friday.", "Pay $1,300 by Friday.", "numbers changed"),
        ("I can attend.", "I can't attend.", "negation changed"),
        ("I cant attend.", "I can attend.", "negation changed"),
        ("Ask Priya about it.", "Ask her about it.", "name or entity removed"),
        ("Mail [[EMAIL_1]] today.", "Mail them today.", "protected token changed"),
        ("See https://a.io/x now", "See the link now", "link, e-mail or mention changed"),
        (
            "Ok.",
            "Okay, that sounds absolutely wonderful to me, thank you so much!",
            "length changed too much",
        ),
    ],
)
def test_meaning_guard_rejects(original, candidate, reason):
    result = compare(original, candidate)
    assert not result.ok and reason in result.reasons


@pytest.mark.parametrize(
    ("original", "candidate"),
    [
        ("i cant come", "I can't come."),
        ("I do not agree", "I don't agree"),
        ("send 1200 units to London", "Send 1,200 units to London."),
        ("meet with john tomorrow", "Meet with John tomorrow."),
        ("She go to school.", "She goes to school."),
    ],
)
def test_meaning_guard_accepts_corrections(original, candidate):
    assert compare(original, candidate).ok, compare(original, candidate).reasons


def test_token_change_ratio():
    assert token_change_ratio("a b c", "a b c") == 0
    assert token_change_ratio("one two three four", "five six seven eight") == 1
    assert 0 < token_change_ratio("She go home", "She goes home") < 0.5


# -------------------------------------------------------------------- redaction


def test_mask_and_map_back():
    text = "Mail me at ana@corp.io or call +44 20 7946 0958, card 4111 1111 1111 1111. Thx"
    masked = mask(text)
    assert "ana@corp.io" not in masked.text and "[[EMAIL_1]]" in masked.text
    assert "[[PHONE_1]]" in masked.text and "[[CARD_1]]" in masked.text
    assert masked.restore(masked.text) == text
    thx = masked.text.index("Thx")
    assert masked.to_original(thx, thx + 3) == (text.index("Thx"), text.index("Thx") + 3)
    email = masked.text.index("[[EMAIL_1]]")
    assert masked.to_original(email, email + 4) is None
    assert masked.placeholders["[[EMAIL_1]]"] == "ana@corp.io"


def test_mask_skips_non_luhn_numbers_and_short_numbers():
    masked = mask("Order 1234 5678 9012 3456 shipped in 2024")
    assert "CARD" not in masked.text  # fails Luhn → treated as normal text (phone at most)
    assert "2024" in masked.text


# ------------------------------------------------------------------------ diffing


def _apply(original: str, hunks) -> str:
    return apply_fixes(original, [(h.start, h.end, h.replacement) for h in hunks])


@pytest.mark.parametrize(
    ("original", "corrected", "expected"),
    [
        ("She go to school.", "She goes to school.", [("go", "goes")]),
        ("I has went home.", "I have gone home.", [("has went", "have gone")]),
        ("However the plan works.", "However, the plan works.", [("However", "However,")]),
        ("I went store.", "I went to the store.", [("store", "to the store")]),
        ("It is is fine.", "It is fine.", [("is ", "")]),
        ("Tehre is a cat", "There is a cat.", [("Tehre", "There"), ("cat", "cat.")]),
        ("the weather are nice", "the weather is nice", [("are", "is")]),
    ],
)
def test_diff_hunks(original, corrected, expected):
    hunks = diff_hunks(original, corrected)
    assert [(original[h.start : h.end], h.replacement) for h in hunks] == expected
    assert _apply(original, hunks) == corrected


def test_issues_from_correction_uses_model_explanations_and_guards():
    text = "Tell Maria the weather are nice and send 3 copies to [[EMAIL_1]]."
    masked = mask("Tell Maria the weather are nice and send 3 copies to bob@x.io.")
    assert masked.text == text
    result = AICorrection(
        corrected="Tell Maria the weather is nice and send 4 copies to [[EMAIL_2]].",
        edits=[AIEdit("are", "is", "grammar", "Use 'is' with the singular noun 'weather'.")],
    )
    issues = issues_from_correction(masked, result)
    # The number change and placeholder change are rejected; the agreement fix survives.
    assert [(i.original, i.replacements, i.message) for i in issues] == [
        ("are", ["is"], "Use 'is' with the singular noun 'weather'.")
    ]
    assert issues[0].source is Source.ai and issues[0].rule_id == "AI_GRAMMAR"


def test_issues_from_correction_rejects_rewrites():
    masked = mask("The meeting went well yesterday.")
    rewrite = AICorrection(corrected="Yesterday's session was a resounding success.")
    assert issues_from_correction(masked, rewrite) == []
    unchanged = AICorrection(corrected="The meeting went well yesterday.")
    assert issues_from_correction(masked, unchanged) == []


def test_issues_from_correction_maps_offsets_after_placeholders():
    original = "Email a@b.io about teh plan."
    masked = mask(original)
    corrected = masked.text.replace("teh", "the")
    issues = issues_from_correction(masked, AICorrection(corrected=corrected))
    assert len(issues) == 1
    issue = issues[0]
    assert original[issue.start : issue.end] == "teh"
    assert issue.category is Category.spelling  # inferred without a model edit


# ------------------------------------------------------------------------- merge


def _issue(start, end, repl, source, conf=0.85, category=Category.grammar):
    return Issue(
        start=start,
        end=end,
        original="x" * (end - start),
        replacements=list(repl),
        category=category,
        severity=Severity.error,
        title="t",
        message="m",
        rule_id=f"{source.value}_R",
        source=source,
        confidence=conf,
    )


def test_merge_agreement_boosts_and_promotes_replacement():
    lt = _issue(4, 6, ["went", "goes"], Source.languagetool)
    ai = _issue(4, 6, ["goes"], Source.ai, conf=0.8)
    merged = merge_issues([ai, lt])
    assert len(merged) == 1
    assert merged[0].replacements == ["goes", "went"]
    assert merged[0].confidence == pytest.approx(0.93)
    assert merged[0].agreed_by == {"languagetool", "ai"}


def test_merge_resolves_overlaps_without_double_underlines():
    spelling = _issue(0, 4, ["the"], Source.languagetool, 0.9, Category.spelling)
    ai_wide = _issue(0, 10, ["the cats"], Source.ai, 0.7)
    separate = _issue(12, 15, ["is"], Source.ai, 0.8)
    merged = merge_issues([ai_wide, spelling, separate])
    assert [(m.start, m.end) for m in merged] == [(0, 4), (12, 15)]


# ----------------------------------------------------------------------- rewrite


def test_style_transforms():
    assert (
        expand_contractions("I'm sure it's fine, don't worry")
        == "I am sure it is fine, do not worry"
    )
    assert (
        contract("I am sure that it is fine; do not worry")
        == "I'm sure that it's fine; don't worry"
    )
    assert transform("hey i just wanted to say thanks", RewriteStyle.formal) == (
        "Hello, I just wanted to say thank you."
    )
    assert transform("In order to make a decision, we are able to meet", RewriteStyle.concise) == (
        "To decide, we can meet."
    )
    assert (
        transform("I am sure we will assist you", RewriteStyle.casual) == "I'm sure we'll help you."
    )
    assert transform("Hi John, thanks", RewriteStyle.formal) == "Hello John, thank you."


def test_apply_fixes_right_to_left():
    assert apply_fixes("a b c", [(0, 1, "x"), (4, 5, "zz")]) == "x b zz"
