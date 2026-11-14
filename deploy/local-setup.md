# Local setup (PowerShell)

Run from the repository root with Node.js 22+; cases 2 and Auth0 also need Python 3.12+ and Docker Desktop. All credentials below are placeholders. Keep real values in ignored local files; process environment variables take precedence over `.env`. Use a fresh PowerShell window when switching cases.

## 1. Public synthetic demo

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
npm ci
npm run dev
```

Open <http://127.0.0.1:3000/demo?dataset=organizer1>. No database, Auth0, Gemini key or Python API is required. Keep the example's hosted-service flags `false` and keys empty. If `.env` already exists, copying is skipped: check those flags before starting.

The standalone coach uses port 3001; `dev:complete` is an alias for `dev:coach`. Its workspace launcher does not load the root `.env`; explicitly load it if needed:

```powershell
node --env-file=.env --run dev:coach
```

For the separate synthetic Python API, install the Python dependencies below and run `npm run dev:demo-api` in another terminal (port 8001). That launcher does not load `.env`, removes inherited `MONEYLENS_*` settings and forces synthetic defaults. `MONEYLENS_DEMO_API_URL` tells the web proxy where to find it; `/demo` itself needs no API.

## 2. Isolated database test

Install Python dependencies once (also used by Auth0):

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend/api/requirements.txt
```

Use a dedicated PostgreSQL instance on port 55432, separate from development on 5432. The following creates a new test container; choose a different name/port if already occupied:

```powershell
docker run --name moneylens-test-db --detach --publish 127.0.0.1:55432:5432 --env POSTGRES_DB=postgres --env POSTGRES_USER=moneylens_test_admin --env POSTGRES_PASSWORD=synthetic_test_only postgres:17.6-alpine
docker exec moneylens-test-db pg_isready -U moneylens_test_admin -d postgres
# Continue only after pg_isready reports accepting connections; repeat if needed.
$env:MONEYLENS_TEST_DATABASE_URL = 'postgresql://moneylens_test_admin:synthetic_test_only@127.0.0.1:55432/postgres'
try {
    .venv\Scripts\python.exe -m pytest -c backend/api/pyproject.toml tests/integration/test_database.py
} finally {
    Remove-Item Env:MONEYLENS_TEST_DATABASE_URL -ErrorAction SilentlyContinue
}
docker stop moneylens-test-db
```

`tests/integration/conftest.py` reads this variable from the pytest process, not directly from `.env`. It creates a unique database, applies migrations, creates separate restricted runtime/identity logins and removes its resources afterwards. The supplied administrator needs database/role creation rights and migration privileges (the dedicated container's administrator suffices). No manual migration, application database URL or real provider is needed for this test. A complete integration run additionally has optional browser/storage checks; see [the test guide](../tests/README.md).

## 3. Optional real Auth0 / Gemini

These are independent integrations. Auth0 serves private account screens through the Python API; public Gemini chat serves the synthetic main-web `/demo` through Next.js. The optional private Gemini interpreter below uses the Python API and is configured separately.

**Auth0, local database bootstrap.** After cases 1 and 2's dependency installation, run:

```powershell
docker compose -f deploy/compose.yaml up -d --wait postgres
.venv\Scripts\python.exe scripts/setup_local_identity.py
```

This first-time local helper migrates only the loopback `moneylens` database, seeds synthetic users and writes generated `MONEYLENS_DATABASE_URL`, `MONEYLENS_AUTH_DATABASE_URL` and `MONEYLENS_SESSION_SECRET` into `.env`. The two database logins are distinct, restricted `NOINHERIT` logins granted only `moneylens_runtime` or `moneylens_auth` respectively. Preserve those generated values. The helper also sets demo authentication on; after it finishes, edit the existing keys and add the following to `.env` (replace all provider placeholders):

```dotenv
MONEYLENS_ENVIRONMENT=development
MONEYLENS_APP_ORIGIN=http://127.0.0.1:3000
MONEYLENS_AUTH_ENABLED=true
MONEYLENS_ALLOW_DEMO=false
MONEYLENS_OIDC_ISSUER=https://tenant.example/
MONEYLENS_OIDC_CLIENT_ID=example-client-id
MONEYLENS_OIDC_CLIENT_SECRET=example-client-secret
MONEYLENS_OIDC_AUTHORIZATION_URL=https://tenant.example/authorize
MONEYLENS_OIDC_TOKEN_URL=https://tenant.example/oauth/token
MONEYLENS_OIDC_JWKS_URL=https://tenant.example/.well-known/jwks.json
```

Supply all six OIDC values together, using the exact issuer including its trailing slash and the actual tenant endpoints. The API expects RS256 ID tokens and authorization-code flow with PKCE; token exchange uses HTTP Basic client authentication. Register `http://127.0.0.1:3000/api/v1/auth/callback` as the Auth0 application's callback. Keep the browser origin consistent (`localhost` and `127.0.0.1` are different origins).

A verified Auth0 identity also needs an administrator-provisioned membership. Put only `MONEYLENS_MIGRATION_DATABASE_URL=postgresql://moneylens:moneylens_local@127.0.0.1:5432/moneylens` in ignored `.cache/admin-invitations.env` (create `.cache` first), then substitute the verified Auth0 User ID and configured issuer:

```powershell
.venv\Scripts\python.exe scripts/provision_oidc_member.py --issuer 'https://tenant.example/' --user-id 'auth0|example-user-id'
```

That tool reads the separate administrator file and the pinned issuer from `.env`; login alone does not create membership and otherwise leads to `/access`. Keep administrator credentials out of the shared application `.env`. For later explicit migrations, Alembic reads `MONEYLENS_MIGRATION_DATABASE_URL` from its process (and can load root `.env`); pass it only to a separate administrator terminal running `.venv\Scripts\python.exe -m alembic -c backend/db/alembic.ini upgrade head`, then remove it from that terminal.

Start `npm run dev:api` and `npm run dev` in separate terminals; open <http://127.0.0.1:3000/api/v1/auth/login>. The API listens on 8000 by default (`MONEYLENS_API_PORT` changes its listener; `MONEYLENS_API_URL` must match on the web side). Keep imports, live banking and `MONEYLENS_MODEL_ENABLED` disabled for this setup.

**Gemini, public synthetic chat.** Edit these existing `.env` keys; the ledger path must be absolute and writable by Next.js:

```dotenv
GEMINI_API_KEY=example-gemini-key
MONEY_COACH_PUBLIC_GEMINI_ENABLED=true
MONEY_COACH_PUBLIC_AI_ORIGINS=http://127.0.0.1:3000
MONEY_COACH_MODEL_USAGE_PATH=C:/example/checkout/.cache/model-usage.json
```

Use this checkout's actual absolute `.cache` path; the server creates the ledger. Restart `npm run dev`, open `/demo?dataset=organizer1` and turn Privacy mode off before hosted chat. A key alone enables nothing. `MONEYLENS_MODEL_ENABLED` and `MONEYLENS_MODEL_BILLING_POLICY` configure the authenticated Python interpreter, not this public Gemini path. Public Gemini chat records usage but has no request or monetary cap; `free_only` does not constrain it.

**Private Gemini Coach.** After the authenticated database setup above, enable `MONEYLENS_STATEMENT_IMPORTS_ENABLED=true` for bounded CSV previews and publication. To use the existing root `GEMINI_API_KEY` with the private interpreter, set `MONEYLENS_MODEL_PROVIDER=gemini`, `MONEYLENS_MODEL_NAME=gemini-3.5-flash`, `MONEYLENS_MODEL_ENABLED=true` and `MONEYLENS_MODEL_BILLING_POLICY=paid_allowed`. A changed model also requires explicit operator-reviewed `MONEYLENS_MODEL_INPUT_MICROUSD_PER_TOKEN` and `MONEYLENS_MODEL_OUTPUT_MICROUSD_PER_TOKEN`; these admission assumptions are not provider price quotes. Retain the existing technical, rate, token and turn-budget limits. Restart the API using `npm run dev:api`, which loads this same root `.env`; restart the main web if its upstream/origin changed.

Open `/banks` with a verified membership, preview and confirm a supported EUR CSV, then choose **View transactions** or **Ask Coach**. Imported payment purposes are initially unreviewed; review them before treating outgoing cash as category spending. The private Coach defaults to Privacy mode and local EN/FI/ET interpretation. Only disabling Privacy mode opts a question into the configured model. Synthetic demo identities still do not get private hosted interpretation. The API sends only the question and validated non-authority selectors to Gemini, never uploaded files, ledger rows or account IDs; existing authenticated server tools calculate the result. A successful hosted interpretation reports `source=model`, `provider=gemini-direct`. The separate `/demo` switch remains unchanged by this setup. Usage is recorded through the existing private audit path, not the public demo's file ledger.

Optional hosted voice needs `MONEY_COACH_GEMINI_VOICE_ENABLED=true` and a separate absolute `MONEY_COACH_VOICE_LEDGER_PATH` such as `C:/example/checkout/.cache/voice-usage.json`. Keep `MONEY_COACH_VOICE_REQUEST_POLICY=bounded` and `MONEY_COACH_VOICE_MAX_REQUESTS=20` (valid range 1–100); this is a persistent attempt limit, not a currency budget. Keep existing ledgers when restarting. Privacy must be off for hosted voice too.

For a production build, explicitly load root `.env` at build time as well: `node --env-file=.env --run build:web`, then `npm start`. Ordinary `npm run build:web` / `npm run build:coach` do not themselves load root `.env`; `build:complete` is an alias for `build:coach`. Workspace `dev`/`start` commands also need an explicit wrapper to load root `.env`. Next.js can load app-local env files under `frontend/web` or `frontend/coach`; avoid conflicting copies. The standalone coach's `/api/chat` uses a separate local evaluation executor: the public Gemini flags above apply to the main web application.

## Readers and coordinator handoff

All current `.env.example` keys match code readers and synthetic defaults; no example changes are needed. The following accounts for every key in it, plus the values required above. Paths are relative to the repository root.

| Variables | Reading process / code |
| --- | --- |
| `MONEYLENS_ENVIRONMENT`, `MONEYLENS_AUTH_ENABLED`, `MONEYLENS_IMPORTS_ENABLED`, `MONEYLENS_LIVE_BANKING_ENABLED`, `MONEYLENS_MODEL_ENABLED`, `MONEYLENS_MODEL_BILLING_POLICY` | Python API, `backend/api/app/settings.py`; billing policy is also read by the standalone Next.js evaluation executor and AI evaluation scripts. |
| `MONEYLENS_APP_ORIGIN` | Python API (cookies, OIDC callback, request origin); Next.js also reads it for optional signed banking proxy context. |
| `MONEYLENS_API_URL`, `MONEYLENS_DEMO_API_URL` | Main Next.js server, `frontend/web/app/api/private-proxy.ts` and `frontend/web/app/api/demo/[...path]/route.ts`; these are upstream URLs, not API listener settings. |
| `MONEYLENS_ALLOW_DEMO` | Python API; main Next.js private-page UI also reads it. |
| `GEMINI_API_KEY` | Next.js hosted chat/voice and standalone Gemini evaluation; not the Python API. Main `/demo` also reads it to expose the online-chat option. |
| `MONEY_COACH_PUBLIC_GEMINI_ENABLED`, `MONEY_COACH_PUBLIC_AI_ORIGINS`, `MONEY_COACH_MODEL_USAGE_PATH` | Main Next.js `/api/chat`, shared `frontend/coach/src/coach/public-executor.ts`; the enable flag is also read by `/demo`. |
| `MONEY_COACH_GEMINI_VOICE_ENABLED`, `MONEY_COACH_VOICE_LEDGER_PATH`, `MONEY_COACH_VOICE_MAX_REQUESTS`, `MONEY_COACH_VOICE_REQUEST_POLICY` | Both Next.js apps' voice routes, shared `frontend/coach/src/voice/routes.ts`. |
| `MONEYLENS_DATABASE_URL`, `MONEYLENS_AUTH_DATABASE_URL`, `MONEYLENS_SESSION_SECRET`, all six `MONEYLENS_OIDC_*` keys above | Python API, settings / pools / identity / OIDC. Next.js private-page UI also reads the issuer. Workers load root `.env` for the runtime URL and (synthetic bank modes) session secret. |
| `MONEYLENS_API_PORT` | Node API launcher, `scripts/run_api.mjs`. |
| `MONEYLENS_TEST_DATABASE_URL` | Pytest fixture, `tests/integration/conftest.py`. |
| `MONEYLENS_MIGRATION_DATABASE_URL` | Alembic; local identity bootstrap; administrator provisioning CLI. Never use it as either application login. |

Values the coordinator must obtain locally:

- **Synthetic demo:** none; copy the example and retain disabled hosted-service flags.
- **Database test:** only `MONEYLENS_TEST_DATABASE_URL`; the dedicated container example supplies it without real credentials. Do not substitute a development/production instance.
- **Auth0:** the six exact OIDC values listed above, plus the verified Auth0 User ID for `--user-id`. Register the callback above. Local bootstrap generates both restricted database URLs and a session secret of at least 32 characters; with an existing database, its administrator must supply these three instead and apply migrations. `MONEYLENS_MIGRATION_DATABASE_URL` belongs only in the separate administrator file/process. Set the authentication flags and app origin as shown.
- **Gemini chat:** `GEMINI_API_KEY`, `MONEY_COACH_MODEL_USAGE_PATH` and the exact browser origin in `MONEY_COACH_PUBLIC_AI_ORIGINS`; explicitly enable `MONEY_COACH_PUBLIC_GEMINI_ENABLED`. **Voice, if wanted:** additionally supply `MONEY_COACH_VOICE_LEDGER_PATH` and enable `MONEY_COACH_GEMINI_VOICE_ENABLED`; retain the example's bounded policy/20-attempt limit.

`.gitignore` excludes `.env`, `.env.*` except `.env.example`, and `.cache/`. Confirm with `git check-ignore -v -- .env .cache/admin-invitations.env .cache/model-usage.json`; stage only the intended documentation/example files, never local secrets.
