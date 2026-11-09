# Setup, testing and packaging

## Prerequisites

| Tool | Version | Used for |
|------|---------|----------|
| Python | 3.12+ | backend |
| PostgreSQL | 15+ | backend |
| Java + Maven | 17+ / 3.9+ | LanguageTool server (fetched from Maven Central) |
| Node.js + npm | 20+ | Chrome extension |
| .NET SDK | 10.0 | Windows app (builds on any OS, runs on Windows 10 1809+/11) |
| Chrome | 120+ | extension |

## 1. Grammar engine (LanguageTool)

```bash
./scripts/fetch-languagetool.sh
```

```bash
./scripts/run-languagetool.sh
```

The server listens on `http://localhost:8081` (`LT_PORT` and `LT_HEAP` override port and heap).
Check it with `curl -d "language=en-US&text=She go home" http://localhost:8081/v2/check`.

## 2. Database

```bash
sudo -u postgres psql -c "CREATE USER writemind WITH PASSWORD 'writemind' CREATEDB;"
```

```bash
sudo -u postgres createdb -O writemind writemind
```

```bash
sudo -u postgres createdb -O writemind writemind_test
```

## 3. Backend API

```bash
cd backend && python -m venv .venv && .venv/bin/pip install -e ".[dev]"
```

```bash
cd backend && cp .env.example .env && .venv/bin/alembic upgrade head
```

```bash
cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000
```

Optional AI: set `ANTHROPIC_API_KEY` in `backend/.env`. The model defaults to `claude-opus-5-5` at `low` effort
(`WRITEMIND_AI_MODEL`, `WRITEMIND_AI_EFFORT`) with server-side refusal fallbacks enabled. Without a key every
feature still works using LanguageTool, WriteMind rules and the offline rewrite engine; `/v1/meta` reports
`ai_available: false`.

Tests (needs PostgreSQL; LanguageTool-backed tests are skipped automatically if it isn't running):

```bash
cd backend && .venv/bin/pytest -q
```

Latency benchmark against a running API:

```bash
cd backend && .venv/bin/python scripts/bench_check.py http://127.0.0.1:8000 80
```

Regenerate the OpenAPI contract after changing schemas:

```bash
cd backend && .venv/bin/python scripts/export_openapi.py
```

### Docker

```bash
docker compose -f infra/docker-compose.yml up --build
```

Production checklist: set `WRITEMIND_ENVIRONMENT=production`, a random `WRITEMIND_JWT_SECRET` (32+ chars),
`WRITEMIND_CORS_ORIGIN_REGEX` pinned to your published extension ID, TLS termination in front of the API, and
`WRITEMIND_TRUST_PROXY_HEADERS=true` only behind a trusted proxy. Rate limits and the result cache are per
process; for several replicas put a shared limiter (e.g. Redis) behind `RateLimiter`.

## 4. Chrome extension

```bash
cd extension && npm install
```

```bash
cd extension && npm run dev
```

`npm run dev` opens Chrome with hot reload. For a production build:

```bash
cd extension && npm run build && npm run zip
```

Load `extension/.output/chrome-mv3` via `chrome://extensions` → Developer mode → **Load unpacked**, or upload
the zip to the Chrome Web Store. The API address is configurable in the extension's Settings page
(default `http://localhost:8000`; remote servers must use `https://`).

Tests:

```bash
cd extension && npm run compile && npm test
```

```bash
cd extension && npm run test:e2e
```

The e2e suite builds the extension, serves local test pages, and drives real Chromium against the API at
`http://localhost:8000` (start LanguageTool and the backend first, ideally with `WRITEMIND_RATE_LIMIT_ENABLED=false`).

## 5. Windows app

```bash
cd desktop && dotnet build WriteMind.slnx
```

```bash
cd desktop && dotnet test --solution WriteMind.slnx
```

```bash
cd desktop && dotnet run --project src/WriteMind.Desktop
```

Release build (single self-contained `WriteMind.exe`, ~75 MB):

```bash
cd desktop && dotnet publish src/WriteMind.Desktop/WriteMind.Desktop.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -o publish
```

`WriteMind.Core` and its tests are cross-platform. The live API test in `ApiClientTests.cs` runs when an API is
reachable at `WRITEMIND_API_URL` (default `http://localhost:8000`) and is skipped otherwise.

Using the app: it starts in the system tray (pass `--background` to skip opening the editor). Click into Word,
Outlook, Notepad or WhatsApp and type; hover an underline for the suggestion card, click the badge or press
**Ctrl+Alt+W** for the assistant (Suggestions + Rewrite). Settings → Apps controls where WriteMind helps.
Note that Windows blocks input into apps running as administrator unless WriteMind also runs elevated.

## 6. Continuous integration

`.github/workflows/ci.yml` runs three jobs: backend (PostgreSQL service + LanguageTool + pytest + ruff),
extension (typecheck, unit tests, build, zip artifact, Playwright e2e against a live backend), and desktop on
`windows-latest` (build, tests, single-file publish artifact).
