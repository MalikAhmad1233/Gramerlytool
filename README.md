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
| **Built-in checker** | Inside both apps — works with no server, no account, fully offline | Hunspell dictionaries + shared rules ([shared/offline](shared/offline/rules.json)) |
| **Optional server** | Full grammar engine and AI suggestions for both clients | Python · FastAPI · PostgreSQL · LanguageTool 6.8 · Claude (Anthropic SDK) |

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

## Getting started (no setup needed)

1. **Chrome:** unzip `writemind-extension-1.0.0-chrome.zip`, open `chrome://extensions`, turn on **Developer mode**,
   click **Load unpacked** and pick the unzipped folder. Start typing in Gmail, WhatsApp Web, LinkedIn or any text box.
2. **Windows:** run `WriteMind.exe` (Windows may ask you to confirm: **More info → Run anyway**).

Both apps work immediately with the **built-in checker** — no account, no server, and your text never leaves your
device. If a WriteMind server is reachable (default `http://localhost:8000`), they switch to it automatically for the
full LanguageTool engine and AI suggestions, and fall back to the built-in checker whenever it isn't.

## How it works

```
 typing ─► debounce ─► server reachable? ─ yes ─► /v1/check (LanguageTool + rules; + AI after a longer pause)
                                        └─ no ──► built-in checker (Hunspell + shared rules, on device)
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
| Built-in checker (no server) | **42/42** fixture errors and **25/25** held-out errors fixed, **0/60** false positives |
| Extension unit tests (vitest) | **211 passed** |
| Extension end-to-end (Playwright, real Chromium + extension) | **8 passed** — textarea, Gmail-style, Lexical-style editor, sensitive fields, rewrite, and two runs with no server |
| Windows Core (xUnit, incl. live API test) | **198 passed** — incl. 135 cases proving the Windows checker matches the extension exactly |
| Windows app (WPF) | Builds clean with warnings-as-errors; CI builds/tests/publishes on `windows-latest` |

The WPF app's UI Automation layer (reading Word/Outlook/Notepad and typing accepted corrections) can
only run on Windows, so it is compiled and packaged by CI but has not been exercised interactively here.

## Running the optional server / building from source

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

AI contextual corrections need an Anthropic API key (`ANTHROPIC_API_KEY`) on the server. Without one, the server runs
LanguageTool + WriteMind rules, and rewrites use the offline style engine. See [docs/SETUP.md](docs/SETUP.md).
The apps have no sign-in: settings and the personal dictionary are stored on each device.

## Repository

```
backend/     FastAPI service: auth, settings, dictionary, usage, and the intelligence engine
extension/   Chrome extension (WXT + React + MV3), unit + Playwright e2e tests
desktop/     WriteMind.Core (cross-platform) + WriteMind.Desktop (WPF) + xUnit tests
shared/      Built-in checker rules + dictionaries, OpenAPI contract, fixtures used by all test suites
infra/       LanguageTool (Maven), Dockerfiles, docker-compose
docs/        Architecture, API, privacy, setup
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, data flow, schema, milestones
- [API reference](docs/API.md) — endpoints with real request/response examples
- [Privacy & security](docs/PRIVACY.md) — data handling and threat model
- [Setup](docs/SETUP.md) — development, testing, packaging, deployment
