from __future__ import annotations

from enum import StrEnum


class Style(StrEnum):
    """Writing register used to tune checking."""

    neutral = "neutral"
    professional = "professional"
    casual = "casual"
    formal = "formal"


class RewriteStyle(StrEnum):
    professional = "professional"
    casual = "casual"
    formal = "formal"
    friendly = "friendly"
    concise = "concise"


class Category(StrEnum):
    grammar = "grammar"
    spelling = "spelling"
    punctuation = "punctuation"
    style = "style"
    clarity = "clarity"


class Severity(StrEnum):
    error = "error"
    warning = "warning"
    suggestion = "suggestion"


class Source(StrEnum):
    languagetool = "languagetool"
    ai = "ai"
    writemind = "writemind"


class ClientKind(StrEnum):
    chrome_extension = "chrome-extension"
    windows_desktop = "windows-desktop"
    web = "web"
    api = "api"


SUPPORTED_LANGUAGES: dict[str, str] = {
    "en-US": "English (US)",
    "en-GB": "English (UK)",
    "en-CA": "English (Canada)",
    "en-AU": "English (Australia)",
    "en-NZ": "English (New Zealand)",
    "en-ZA": "English (South Africa)",
    "de-DE": "German (beta)",
    "fr": "French (beta)",
    "es": "Spanish (beta)",
    "it": "Italian (beta)",
    "nl": "Dutch (beta)",
    "pt-PT": "Portuguese (beta)",
    "pt-BR": "Portuguese, Brazil (beta)",
}
