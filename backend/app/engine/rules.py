"""WriteMind rules: precise, register-aware checks LanguageTool does not provide.

English only. Each rule returns issues in code points relative to ``text``.
"""

from __future__ import annotations

import re

from app.engine.profiles import Profile
from app.engine.types import Issue
from app.schemas.common import Category, Severity, Source

_APOS = "['’]"

# Unambiguous expansions first; ambiguous ones list alternatives (best guess first).
CONTRACTIONS: dict[str, list[str]] = {
    "don't": ["do not"],
    "doesn't": ["does not"],
    "didn't": ["did not"],
    "can't": ["cannot"],
    "couldn't": ["could not"],
    "won't": ["will not"],
    "wouldn't": ["would not"],
    "shouldn't": ["should not"],
    "isn't": ["is not"],
    "aren't": ["are not"],
    "wasn't": ["was not"],
    "weren't": ["were not"],
    "haven't": ["have not"],
    "hasn't": ["has not"],
    "hadn't": ["had not"],
    "mustn't": ["must not"],
    "needn't": ["need not"],
    "i'm": ["I am"],
    "you're": ["you are"],
    "we're": ["we are"],
    "they're": ["they are"],
    "that's": ["that is"],
    "there's": ["there is"],
    "what's": ["what is"],
    "who's": ["who is"],
    "let's": ["let us"],
    "i've": ["I have"],
    "you've": ["you have"],
    "we've": ["we have"],
    "they've": ["they have"],
    "i'll": ["I will"],
    "you'll": ["you will"],
    "we'll": ["we will"],
    "they'll": ["they will"],
    "he'll": ["he will"],
    "she'll": ["she will"],
    "it'll": ["it will"],
    "it's": ["it is", "it has"],
    "he's": ["he is", "he has"],
    "she's": ["she is", "she has"],
    "i'd": ["I would", "I had"],
    "you'd": ["you would", "you had"],
    "we'd": ["we would", "we had"],
    "they'd": ["they would", "they had"],
}
_PERFECT_HINT = re.compile(r"^\s+(been|got|gotten|had|become)\b", re.I)

# (pattern, replacement(s), formal_only)
INFORMAL: list[tuple[str, list[str], bool]] = [
    ("gonna", ["going to"], False),
    ("wanna", ["want to"], False),
    ("gotta", ["have to", "got to"], False),
    ("kinda", ["kind of", "somewhat"], False),
    ("sorta", ["sort of", "somewhat"], False),
    ("dunno", ["don't know", "do not know"], False),
    ("gimme", ["give me"], False),
    ("lemme", ["let me"], False),
    ("ya", ["you"], False),
    ("yeah", ["yes"], False),
    ("yep", ["yes"], False),
    ("nope", ["no"], False),
    ("cuz", ["because"], False),
    ("coz", ["because"], False),
    ("tho", ["though"], False),
    ("thru", ["through"], False),
    ("pls", ["please"], False),
    ("plz", ["please"], False),
    ("thx", ["thanks", "thank you"], False),
    ("thanx", ["thanks", "thank you"], False),
    ("u", ["you"], False),
    ("ur", ["your", "you're"], False),
    ("b4", ["before"], False),
    ("btw", ["by the way"], False),
    ("imo", ["in my opinion"], False),
    ("y'all", ["you all"], False),
    ("asap", ["as soon as possible"], True),
    ("fyi", ["for your information"], True),
    ("info", ["information"], True),
]

_CONTRACTION_RE = re.compile(
    r"(?<![\w'’])("
    + "|".join(re.escape(k).replace("'", _APOS) for k in CONTRACTIONS)
    + r")(?![\w'’])",
    re.IGNORECASE,
)
_INFORMAL_RE = {
    word: re.compile(
        r"(?<![\w'’@#])" + re.escape(word).replace("'", _APOS) + r"(?![\w'’])", re.IGNORECASE
    )
    for word, _, _ in INFORMAL
}
_MULTI_PUNCT = re.compile(r"([!?])\1+|\?!(?:[?!])+|!\?(?:[?!])+")


def _match_case(source: str, replacement: str) -> str:
    if source[:1].isupper() and not replacement[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement


def _issue(start, end, original, replacements, category, severity, title, message, rule_id, conf):
    return Issue(
        start=start,
        end=end,
        original=original,
        replacements=replacements,
        category=category,
        severity=severity,
        title=title,
        message=message,
        rule_id=rule_id,
        source=Source.writemind,
        confidence=conf,
    )


def check_contractions(text: str, profile: Profile) -> list[Issue]:
    if not profile.flag_contractions:
        return []
    issues = []
    for m in _CONTRACTION_RE.finditer(text):
        word = m.group(1)
        key = word.lower().replace("’", "'")
        options = list(CONTRACTIONS[key])
        if len(options) > 1 and _PERFECT_HINT.match(text[m.end() :]):
            options.reverse()
        options = [_match_case(word, o) for o in options]
        issues.append(
            _issue(
                m.start(1),
                m.end(1),
                word,
                options,
                Category.style,
                profile.style_severity,
                "Contraction in formal writing",
                f"Formal writing usually avoids contractions. Consider “{options[0]}”.",
                "WM_FORMAL_CONTRACTION",
                0.75,
            )
        )
    return issues


def check_informal(text: str, profile: Profile, *, formal: bool) -> list[Issue]:
    if not profile.flag_informal:
        return []
    issues = []
    for word, replacements, formal_only in INFORMAL:
        if formal_only and not formal:
            continue
        for m in _INFORMAL_RE[word].finditer(text):
            found = m.group(0)
            # Skip ALL-CAPS acronyms such as "UR" or "INFO".
            if word in {"u", "ur", "ya", "info"} and found.isupper() and len(found) > 1:
                continue
            options = [_match_case(found, r) for r in replacements]
            issues.append(
                _issue(
                    m.start(),
                    m.end(),
                    found,
                    options,
                    Category.style,
                    profile.style_severity,
                    "Informal language",
                    f"“{found}” is informal. Consider “{options[0]}” for a more polished tone.",
                    "WM_INFORMAL_WORD",
                    0.8,
                )
            )
    return issues


def check_multiple_punctuation(text: str, profile: Profile) -> list[Issue]:
    if not profile.flag_informal:
        return []
    issues = []
    for m in _MULTI_PUNCT.finditer(text):
        found = m.group(0)
        replacement = (
            "?" if "?" in found and "!" not in found else ("!" if "?" not in found else "?")
        )
        issues.append(
            _issue(
                m.start(),
                m.end(),
                found,
                [replacement],
                Category.punctuation,
                Severity.suggestion,
                "Repeated punctuation",
                "Repeated punctuation marks can read as unprofessional. Use a single mark.",
                "WM_MULTIPLE_PUNCTUATION",
                0.85,
            )
        )
    return issues


_SENT_START = r"(?:^|(?<=[.!?]\s)|(?<=\n))\s*"
_INDEF_SUBJECT_VERB = {
    "have": "has",
    "are": "is",
    "were": "was",
    "do": "does",
    "don't": "doesn't",
    "want": "wants",
    "need": "needs",
    "know": "knows",
    "like": "likes",
    "think": "thinks",
}
# (regex, group to replace, replacement builder, message) — all register-independent.
_CONFUSED: list[tuple[re.Pattern[str], str, str]] = [
    (
        re.compile(r"\b(your)(\s+welcome)\b(?=\s*(?:[.!,]|to\b|$))", re.IGNORECASE),
        "you're",
        "Use “you're” (you are) here: “you're welcome”.",
    ),
    (
        re.compile(r"\b(their)(\s+going\s+to)\b", re.IGNORECASE),
        "they're",
        "Use “they're” (they are) before “going to”.",
    ),
    (
        re.compile(
            _SENT_START + r"(their)(\s+(?:coming|doing|trying|getting|making|taking|leaving)\b)",
            re.IGNORECASE,
        ),
        "they're",
        "Use “they're” (they are) when it means “they are ...”.",
    ),
]
_INDEF_RE = re.compile(
    r"\b(everyone|everybody|nobody|someone|somebody)\s+("
    + "|".join(re.escape(v).replace("'", _APOS) for v in _INDEF_SUBJECT_VERB)
    + r")\b",
    re.IGNORECASE,
)


_BASE_FORM_TRIGGER = re.compile(
    r"\b(?:do|does|did|don't|doesn't|didn't|will|would|can|could|should|shall|may|might|must|"
    r"let|lets|make|makes|made|help|helps|helped|have|has|had|see|watch|hear|to)\s+$",
    re.IGNORECASE,
)


_POSSESSIVE_NOUNS = (
    "feedback|help|support|reply|response|message|email|e-mail|thoughts|input|comments|answer|"
    "opinion|time|patience|order|account|request|question|application|availability|team|work|"
    "report|cooperation|understanding|assistance|consideration|attention|kindness|advice|"
    "suggestions|proposal|invoice|payment|details|address|number|name|reply"
)
_POSSESSIVE_YOU = re.compile(
    r"\b(?:me|us|him|her|them|for|of|about|with|from|in|know|appreciate|received|read)\s+"
    r"(you)\s+(" + _POSSESSIVE_NOUNS + r")\b",
    re.IGNORECASE,
)


def check_confused_words(text: str) -> list[Issue]:
    issues: list[Issue] = []
    for pattern, replacement, message in _CONFUSED:
        for m in pattern.finditer(text):
            word = m.group(1)
            issues.append(
                _issue(
                    m.start(1),
                    m.end(1),
                    word,
                    [_match_case(word, replacement)],
                    Category.grammar,
                    Severity.error,
                    "Commonly confused words",
                    message,
                    "WM_CONFUSED_WORDS",
                    0.88,
                )
            )
    for m in _POSSESSIVE_YOU.finditer(text):
        issue = _issue(
            m.start(1),
            m.end(1),
            m.group(1),
            [_match_case(m.group(1), "your")],
            Category.grammar,
            Severity.error,
            "Possessive pronoun",
            f"Use the possessive “your” before “{m.group(2)}”.",
            "WM_POSSESSIVE_YOUR",
            0.88,
        )
        issue.suppresses = ((m.start(2), m.end(2)),)
        issues.append(issue)
    for m in _INDEF_RE.finditer(text):
        # "Does everyone have", "let everyone know", "to help somebody need" → base form is right.
        if _BASE_FORM_TRIGGER.search(text[: m.start()]):
            continue
        verb = m.group(2)
        fixed = _INDEF_SUBJECT_VERB[verb.lower().replace("’", "'")]
        issues.append(
            _issue(
                m.start(2),
                m.end(2),
                verb,
                [fixed],
                Category.grammar,
                Severity.error,
                "Subject-verb agreement",
                f"“{m.group(1)}” is singular, so the verb should be “{fixed}”.",
                "WM_INDEFINITE_PRONOUN_AGREEMENT",
                0.85,
            )
        )
    return issues


def run_rules(text: str, profile: Profile, *, formal: bool, language: str) -> list[Issue]:
    if not language.startswith("en"):
        return []
    return (
        check_confused_words(text)
        + check_contractions(text, profile)
        + check_informal(text, profile, formal=formal)
        + check_multiple_punctuation(text, profile)
    )
