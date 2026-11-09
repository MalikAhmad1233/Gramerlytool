# Privacy & Security

WriteMind AI sits next to everything a person types, so its design starts from
what it must *not* do. This document describes data handling and the threat
model, and points to the code and tests that enforce each property.

## What WriteMind never does

| Property | Enforcement | Tests |
|----------|-------------|-------|
| Changes text without an explicit click | Extension: `EditorAdapter.apply` is only called from `accept`/`applyRewrite`; Windows: `TextApplier.ApplyAsync` only from Accept/Replace handlers. Both re-verify the span (incl. word boundaries) and refuse on mismatch. | `extension/e2e` ("never edits on its own"), `adapters.test.ts`, `TextTests.cs` |
| Logs keystrokes | No keyboard hooks exist in either client. The extension listens to `input` events and reads the field value after a pause; Windows uses UI Automation focus events and reads the control's text. The one global shortcut uses `RegisterHotKey`, which delivers only that combination. | Code review: `NativeMethods.cs` has no `SetWindowsHookEx` |
| Reads sensitive fields | `extension/src/editors/sensitive.ts`, `WriteMind.Core/Privacy/SensitiveFieldPolicy.cs`, `AppCatalog.cs` — evaluated before any text is read. | `sensitive.test.ts`, e2e "sensitive and opted-out fields", `PolicyTests.cs` |
| Stores user text | No table holds prose (`backend/app/models`). Request bodies are never logged; validation errors never echo input. | `test_check_api.py::test_text_is_never_logged`, `test_auth.py` (no echo) |

## Data the service keeps

| Data | Why | Retention |
|------|-----|-----------|
| Account: e-mail, argon2id password hash, display name, plan | Sign-in and sync | Until the user deletes the account (`DELETE /v1/me`, cascades) |
| Settings and personal dictionary | Sync across clients (words the user explicitly added) | Until changed or account deleted |
| Refresh tokens (SHA-256 hashes only) | Session rotation with theft detection | Expire after 30 days; revoked on logout/reuse |
| Daily counters (checks, characters, accepted, ignored, rewrites) | Usage statistics shown to the user | Account lifetime |
| Feedback events (rule id, category, source, action) | Rule-quality metrics | Anonymised (user detached) on account deletion |

Users can export everything with `GET /v1/me/export`.

## Text in transit and in memory

- Clients send text over HTTPS (the extension refuses plain `http://` for non-localhost servers).
- The engine processes text in memory. An optional per-paragraph result cache (default 10 min TTL,
  in-process, keyed by SHA-256) speeds up re-checks; set `WRITEMIND_CACHE_TTL_SECONDS=0` to disable it.
- Responses carry `Cache-Control: no-store`.

## AI provider

When an Anthropic key is configured, paragraphs are sent to Claude for contextual correction and rewrites.
Before sending, `engine/ai/redaction.py` replaces e-mail addresses, URLs, phone numbers, Luhn-valid card
numbers and IBANs with placeholders such as `[[EMAIL_1]]`; edits touching placeholders are discarded and
placeholders are restored only in the final text shown to the user. The system prompt instructs the model to
treat the text as data, not instructions (prompt-injection resistance), and the meaning guard rejects
outputs that change numbers, negation, names, links or placeholders. Users can switch AI off entirely.

## Authentication & API hardening

- argon2id password hashing; constant-time behaviour for unknown e-mails.
- 15-minute HS256 access tokens; single-use refresh tokens stored hashed, rotation with family revocation on reuse.
- `WRITEMIND_JWT_SECRET` must be 32+ random characters in production (startup fails otherwise).
- Token-bucket rate limits on auth, check, rewrite, feedback and account routes.
- Request body cap (256 KB), text caps (20 000 chars per check, 2 000 per rewrite).
- Security headers (`nosniff`, `no-referrer`, `DENY` framing); strict CORS allow-list — pin your published
  extension ID with `WRITEMIND_CORS_ORIGIN_REGEX` in production.
- Containers run as non-root users.

## Client-side storage

- **Extension:** settings and tokens in `chrome.storage.local` (inaccessible to web pages). Minimal
  permissions: `storage` plus host access; no `tabs`, `scripting`, history or remote code. The in-page UI
  runs in a shadow root and never modifies the page's DOM for highlighting.
- **Windows:** settings in `%APPDATA%\WriteMind\settings.json`; the session is encrypted with DPAPI
  (CurrentUser scope). The app runs unelevated (`asInvoker`). If the target app runs elevated, Windows blocks
  input and WriteMind tells the user instead of attempting a workaround.

## Threat model (summary)

| Threat | Mitigation |
|--------|-----------|
| Malicious page reads WriteMind data | Content scripts run in an isolated world; no `externally_connectable`; tokens never enter page context. |
| Malicious text tries to steer the AI ("ignore previous instructions…") | Text is wrapped as data; structured JSON output; meaning guard; diff-derived offsets; every change still needs user approval. |
| Stolen refresh token | Single use; replay revokes the whole token family. |
| Corrupting text by applying a stale suggestion | Span + word-boundary verification before every write; editors' native input pipeline keeps undo history. |
| Over-collection | No prose persisted; counters only; export and deletion endpoints. |
