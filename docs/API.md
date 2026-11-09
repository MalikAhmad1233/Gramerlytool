# WriteMind API reference

Base URL: `http://localhost:8000` in development. Machine-readable contract: [`shared/openapi.json`](../shared/openapi.json)
(interactive docs at `/docs` outside production).

**Conventions**

- JSON in, JSON out. Errors use one envelope: `{"error": {"code", "message", "request_id", "details"?}}`.
- **All offsets and lengths are UTF-16 code units** (what JavaScript and .NET strings index by).
- Authentication: `Authorization: Bearer <access_token>`. Endpoints marked *optional* work for guests.
- Every response carries `X-Request-ID`; text endpoints are `Cache-Control: no-store`.
- `429` responses include `Retry-After` (seconds).

## Text intelligence

### `POST /v1/check` — auth optional

Checks text. `mode: "fast"` runs LanguageTool + WriteMind rules (tens of milliseconds); `mode: "full"` adds AI
contextual corrections. Clients typically send `fast` ~350 ms after typing pauses and `full` after ~1.5 s.

| Field | Type | Notes |
|-------|------|-------|
| `text` | string | ≤ 20 000 characters (413 `text_too_long` above) |
| `language` | string | `en-US`, `en-GB`, `en-CA`, `en-AU`, `en-NZ`, `en-ZA`; beta: `de-DE`, `fr`, `es`, `it`, `nl`, `pt-PT`, `pt-BR` |
| `style` | string | `neutral` · `professional` · `casual` · `formal` |
| `mode` | string | `fast` · `full` |
| `client` | object | `{"kind": "chrome-extension" \| "windows-desktop" \| "web" \| "api", "app": "gmail" \| "whatsapp" \| "word" \| …}` — chat apps get chat-friendly rules |
| `categories` | string[]? | subset of `grammar`, `spelling`, `punctuation`, `style`, `clarity` |
| `dictionary` | string[] | extra words to accept (merged with the signed-in user's dictionary) |
| `disabled_rules` | string[] | rule ids to skip |
| `ai` | bool | `false` disables AI for this request |

Request:

```json
{
  "text": "Hi 👋 She go to school and I recieved teh files.\n\nPlease send me you feedback.",
  "language": "en-US",
  "style": "neutral",
  "mode": "fast",
  "client": {
    "kind": "chrome-extension",
    "app": "gmail"
  },
  "dictionary": [
    "WriteMind"
  ],
  "disabled_rules": [],
  "ai": true
}
```

Response (real output, trimmed to two suggestions):

```json
{
  "text_hash": "f636dd08af08bfda001c7e76a8493381",
  "language": "en-US",
  "style": "neutral",
  "mode": "fast",
  "suggestions": [
    {
      "id": "s_2bf795069f52",
      "fingerprint": "cfbec3731543ac04",
      "offset": 10,
      "length": 2,
      "original": "go",
      "replacements": [
        "goes",
        "went"
      ],
      "category": "grammar",
      "severity": "error",
      "title": "Agreement error",
      "message": "The pronoun ‘She’ is usually used with a third-person or a past tense verb.",
      "rule_id": "HE_VERB_AGR",
      "source": "languagetool",
      "confidence": 0.85
    },
    {
      "id": "s_12f79e1e9c28",
      "fingerprint": "adecc9046c2a5107",
      "offset": 29,
      "length": 8,
      "original": "recieved",
      "replacements": [
        "received",
        "relieved"
      ],
      "category": "spelling",
      "severity": "error",
      "title": "Spelling mistake",
      "message": "Possible spelling mistake found.",
      "rule_id": "MORFOLOGIK_RULE_EN_US",
      "source": "languagetool",
      "confidence": 0.9
    }
  ],
  "stats": {
    "characters": 77,
    "words": 15,
    "sentences": 2,
    "issues": {
      "grammar": 2,
      "spelling": 2,
      "punctuation": 0,
      "style": 0,
      "clarity": 0
    },
    "score": 34
  },
  "engine": {
    "languagetool": "ok",
    "ai": "unavailable",
    "paragraphs_checked": 2,
    "paragraphs_cached": 0,
    "latency_ms": 42.0
  }
}
```

`engine.ai` is one of `used`, `skipped` (fast mode / nothing eligible), `disabled` (user or request turned it off),
`unavailable` (no provider configured) or `error` (provider failed — LanguageTool results are still returned).
`fingerprint` is stable across re-checks; clients use it to remember "Ignore".

### `POST /v1/rewrite` — auth optional

Returns up to `count` (1–3) alternatives in a target style: `professional`, `formal`, `casual`, `friendly`,
`concise`. Text ≤ 2 000 characters. Every alternative passed the meaning guard. With no AI provider, the
deterministic style engine (contractions, informal vocabulary, filler, wordiness, punctuation) plus
LanguageTool corrections are used, and `engine` is `"rules"`.

```json
{
  "text": "hey can u send me the report asap",
  "style": "formal",
  "count": 2
}
```

```json
{
  "style": "formal",
  "alternatives": [
    {
      "text": "Hello, can you send me the report as soon as possible?",
      "source": "rules",
      "meaning_preserved": true,
      "notes": [
        "1 correction(s) applied",
        "Adjusted for a formal tone"
      ]
    }
  ],
  "engine": "rules",
  "latency_ms": 12.0
}
```

## Accounts

| Method | Path | Body | Result |
|--------|------|------|--------|
| POST | `/v1/auth/register` | `{"email", "password", "display_name"?, "client"?}` | `201` token pair |
| POST | `/v1/auth/login` | `{"email", "password", "client"?}` | token pair · `401 invalid_credentials` |
| POST | `/v1/auth/refresh` | `{"refresh_token"}` | new token pair (old token is now invalid; replaying it revokes the session) |
| POST | `/v1/auth/logout` | `{"refresh_token"}` | `204` |
| GET | `/v1/me` | – | user |
| DELETE | `/v1/me` | `{"password"}` | `204`, deletes account and all synced data |
| GET | `/v1/me/export` | – | JSON download of account data |

Token pair: `{"access_token", "refresh_token", "token_type": "bearer", "expires_in": 900, "user": {…}}`.
Passwords: 8–128 characters mixing at least two of lower/upper/digits/symbols.

## Preferences & personal data

| Method | Path | Notes |
|--------|------|-------|
| GET / PUT | `/v1/settings` | `language`, `default_style`, `ai_enabled`, `enabled_categories`, `disabled_rules`, `disabled_sites`, `disabled_apps`. PUT is a partial update. |
| GET / POST | `/v1/dictionary` | POST `{"word"}` → `201` if added, `200` if it already existed (case-insensitive); limit 5 000 |
| DELETE | `/v1/dictionary/{word}` | `204` · `404` |
| POST | `/v1/feedback` | `{"client", "events": [{"rule_id", "category", "source", "action"}]}` — no text; `action` ∈ `accepted`, `ignored`, `rule_disabled`, `added_to_dictionary` |
| GET | `/v1/usage/summary?days=7` | aggregated counters and acceptance rate |

## Service

| Method | Path | Notes |
|--------|------|-------|
| GET | `/health` | liveness |
| GET | `/health/ready` | database + LanguageTool status (`503` when degraded) |
| GET | `/v1/meta` | languages, styles, categories, limits, `ai_available` |

## Error codes

`validation_error` (422), `text_too_long` / `payload_too_large` (413), `unauthorized` / `invalid_token` /
`invalid_credentials` / `invalid_refresh_token` (401), `invalid_password` (403), `email_taken` /
`dictionary_full` (409), `not_found` (404), `rate_limited` (429), `internal_error` (500).
