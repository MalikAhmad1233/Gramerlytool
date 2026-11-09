"""Style profiles: how each writing register tunes LanguageTool and severities.

Category mapping turns LanguageTool's ~20 categories into WriteMind's five
user-facing ones. Rule lists were chosen to cut the noisiest false positives
seen in chat and e-mail editors while keeping correctness rules intact.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.schemas.common import Category, Severity, Style

# Typographic niceties that are noise in everyday editors.
_ALWAYS_DISABLED = (
    "EN_QUOTES",  # straight → curly quotes
    "DASH_RULE",  # hyphen → en/em dash
    "EN_DIACRITICS_REPLACE",  # cafe → café
    "ARROWS",
    "MULTIPLICATION_SIGN",
    "EN_UNPAIRED_QUOTES",
)

# Chat-style relaxations for casual writing and messaging apps.
_CASUAL_DISABLED = (
    "PUNCTUATION_PARAGRAPH_END",
    "UPPERCASE_SENTENCE_START",
    "PROFANITY",
    "EN_REPEATEDWORDS_GOOD",
    "ENGLISH_WORD_REPEAT_BEGINNING_RULE",
    "SENT_START_CONJUNCTIVE_LINKING_ADVERB_COMMA",
)

CHAT_APPS = frozenset({"whatsapp", "messenger", "telegram", "slack", "teams", "discord"})


@dataclass(frozen=True, slots=True)
class Profile:
    level: str
    disabled_rules: tuple[str, ...]
    disabled_categories: tuple[str, ...]
    style_severity: Severity
    flag_contractions: bool
    flag_informal: bool


def profile_for(style: Style, app: str | None) -> Profile:
    chat = (app or "") in CHAT_APPS
    if style is Style.formal:
        return Profile("picky", _ALWAYS_DISABLED, (), Severity.warning, True, True)
    if style is Style.professional:
        return Profile("picky", _ALWAYS_DISABLED, (), Severity.suggestion, False, True)
    if style is Style.casual or chat:
        return Profile(
            "default",
            _ALWAYS_DISABLED + _CASUAL_DISABLED,
            ("STYLE", "PLAIN_ENGLISH", "REDUNDANCY", "TYPOGRAPHY", "WIKIPEDIA"),
            Severity.suggestion,
            False,
            False,
        )
    return Profile("default", _ALWAYS_DISABLED, ("WIKIPEDIA",), Severity.suggestion, False, False)


_CATEGORY_MAP: dict[str, Category] = {
    "TYPOS": Category.spelling,
    "COMPOUNDING": Category.spelling,
    "CASING": Category.grammar,
    "GRAMMAR": Category.grammar,
    "CONFUSED_WORDS": Category.grammar,
    "COLLOCATIONS": Category.grammar,
    "NONSTANDARD_PHRASES": Category.grammar,
    "SEMANTICS": Category.grammar,
    "REPETITIONS": Category.grammar,
    "MISC": Category.grammar,
    "PUNCTUATION": Category.punctuation,
    "TYPOGRAPHY": Category.punctuation,
    "STYLE": Category.style,
    "REPETITIONS_STYLE": Category.style,
    "GENDER_NEUTRALITY": Category.style,
    "CREATIVE_WRITING": Category.style,
    "REDUNDANCY": Category.clarity,
    "PLAIN_ENGLISH": Category.clarity,
    "WIKIPEDIA": Category.clarity,
    "TEXT_ANALYSIS": Category.clarity,
}

_TITLES: dict[Category, str] = {
    Category.spelling: "Spelling",
    Category.grammar: "Grammar",
    Category.punctuation: "Punctuation",
    Category.style: "Style",
    Category.clarity: "Clarity",
}


_SPELLER_RULE = re.compile(r"MORFOLOGIK|HUNSPELL|SPELLING|SPELLER", re.IGNORECASE)


def map_category(category_id: str, issue_type: str, rule_id: str = "") -> Category:
    if issue_type == "misspelling":
        # Dictionary misses are spelling; other "typo" rules (its/it's, i → I) are grammar.
        return (
            Category.spelling if _SPELLER_RULE.search(rule_id) or not rule_id else Category.grammar
        )
    if issue_type == "whitespace" or issue_type == "typographical":
        return _CATEGORY_MAP.get(category_id, Category.punctuation)
    if issue_type == "style" or issue_type == "register":
        return _CATEGORY_MAP.get(category_id, Category.style)
    return _CATEGORY_MAP.get(category_id, Category.grammar)


def default_title(category: Category) -> str:
    return _TITLES[category]


def severity_for(category: Category, profile: Profile) -> Severity:
    if category in (Category.spelling, Category.grammar):
        return Severity.error
    if category is Category.punctuation:
        return Severity.warning
    return profile.style_severity


def base_confidence(category: Category) -> float:
    return {
        Category.spelling: 0.9,
        Category.grammar: 0.85,
        Category.punctuation: 0.8,
        Category.style: 0.6,
        Category.clarity: 0.65,
    }[category]
