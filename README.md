<p align="center"><img src="extension/public/icon/128.png" width="88" alt="WriteMind AI"></p>

<h1 align="center">WriteMind AI</h1>
<p align="center"><b>Detect Instantly. Suggest Intelligently. Let Users Decide.</b></p>

WriteMind AI is a privacy-first writing assistant. It checks grammar, spelling,
punctuation and style as you type, explains each issue, offers alternative
phrasings in Professional, Formal, Casual, Friendly or Concise styles, and
**never changes your text until you approve a specific suggestion**.

| Client | Where it works | Stack |
|--------|----------------|-------|
| **Chrome extension** | Gmail, WhatsApp Web, LinkedIn, Outlook on the web, Slack, and any textarea or rich-text editor | TypeScript · React 19 · WXT · Manifest V3 |
| **Windows app** | Microsoft Word, Outlook, Notepad, WhatsApp Desktop, WordPad, OneNote, Teams, plus a built-in editor | C# · .NET 10 · WPF · UI Automation |
| **Shared engine** | One API serving both clients | Python · FastAPI · PostgreSQL · LanguageTool 6.8 · Claude (Anthropic SDK) |

## Product rules (enforced in code and tests)

1. **No automatic edits.** The only write path is an explicit *Accept* or *Replace* click. Before writing,
   the client re-verifies that the exact span (and its word boundaries) is unchanged; otherwise it refuses.
2. **No keystroke logging.** The extension reads a field's value after you pause; the Windows app reads the
   focused control through UI Automation. Neither installs keyboard hooks.
3. **Sensitive fields are skipped** — passwords, payment, one-time codes, fields named like secrets/tokens,
   `data-gramm="false"`/`data-writemind="off"` opt-outs, password managers, terminals and remote desktops.
4. **Your text is not stored.** No database table holds prose; logs record sizes and timings only; e-mails,
   phone and card numbers and links are masked before text reaches the AI model.
5. **Meaning is preserved.** AI edits that change numbers, negation, names, links or placeholders are rejected.

## How it works

```
 typing ─► debounce ─► /v1/check (fast: LanguageTool + WriteMind rules, ~50 ms)
                    └► /v1/check (full: + AI contextual correction, after a longer pause)
 response ─► offsets rebased onto the current text ─► underlines in an overlay
 user clicks a suggestion ─► Accept / Ignore / Add to dictionary / Turn off rule
```

The engine splits text into paragraphs and caches each one, so an edit re-checks only the changed
paragraph. All offsets are UTF-16 code units, matching JavaScript and .NET strings.
Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quality & test status

| Suite | Result |
|-------|--------|
| Backend (pytest, real PostgreSQL + LanguageTool) | **175 passed** |
| Grammar accuracy fixture ([shared/fixtures/accuracy-en.json](shared/fixtures/accuracy-en.json)) | **42/42** errors detected, **0/23** false positives (LanguageTool-only, no AI) |
| `/v1/check` latency (HTTP, fast mode, typing simulation) | p50 **52 ms**, p95 **60 ms** |
| Extension unit tests (vitest) | **59 passed** |
| Extension end-to-end (Playwright, real Chromium + extension + API) | **7 passed** — textarea, Gmail-style, Lexical-style editor, sensitive fields, rewrite, account sync |
| Windows Core (xUnit, incl. live API test) | **51 passed** |
| Windows app (WPF) | Builds clean with warnings-as-errors; CI builds/tests/publishes on `windows-latest` |

The WPF app's UI Automation layer (reading Word/Outlook/Notepad and typing accepted corrections) can
only run on Windows, so it is compiled and packaged by CI but has not been exercised interactively here.

## Quick start

Prerequisites: Python 3.12+, PostgreSQL 15+, Java 17+ and Maven (for LanguageTool), Node 20+, .NET 10 SDK.

```bash
./scripts/fetch-languagetool.sh
```

```bash
./scripts/run-languagetool.sh
```

```bash
cd backend && python -m venv .venv && .venv/bin/pip install -e ".[dev]" && .venv/bin/alembic upgrade head && .venv/bin/uvicorn app.main:app --port 8000
```

```bash
cd extension && npm install && npm run build
```

Then open `chrome://extensions`, enable Developer mode, **Load unpacked** → `extension/.output/chrome-mv3`.

```bash
cd desktop && dotnet run --project src/WriteMind.Desktop
```

Or run the whole backend with Docker: `docker compose -f infra/docker-compose.yml up --build`.

AI contextual corrections need an Anthropic API key (`ANTHROPIC_API_KEY`). Without one, WriteMind runs on
LanguageTool + WriteMind rules, and rewrites use the offline style engine. See [docs/SETUP.md](docs/SETUP.md).

## Repository

```
backend/     FastAPI service: auth, settings, dictionary, usage, and the intelligence engine
extension/   Chrome extension (WXT + React + MV3), unit + Playwright e2e tests
desktop/     WriteMind.Core (cross-platform) + WriteMind.Desktop (WPF) + xUnit tests
shared/      OpenAPI contract and fixtures used by all three test suites
infra/       LanguageTool (Maven), Dockerfiles, docker-compose
docs/        Architecture, API, privacy, setup
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, data flow, schema, milestones
- [API reference](docs/API.md) — endpoints with real request/response examples
- [Privacy & security](docs/PRIVACY.md) — data handling and threat model
- [Setup](docs/SETUP.md) — development, testing, packaging, deployment
