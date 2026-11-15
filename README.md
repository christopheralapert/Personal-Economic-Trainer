# Personal Economic Trainer

A mobile-first finance coach with transaction exploration, three spending baskets, savings scenarios, and an installable demo. The project includes the web application, a standalone coach, a Python API, database migrations, and background workers.

## Repository layout

```text
frontend/
  web/          Main Next.js application and account screens
  coach/        Standalone coach, shared UI, and demo datasets
backend/
  api/          Python API and dependency definitions
  workers/      Scoped background job runner
  db/           Alembic configuration, database migrations, and SQL
packages/
  contracts/    Shared API schemas and generated TypeScript types
fixtures/       Public reference data and synthetic test inputs
tests/
  config/       Shared Playwright configuration and runner paths
  api/          Database-free API unit tests
  integration/  Opt-in database and service checks
  browser/      Main application browser checks
  finance-browser/  Isolated account and planning browser journey
  pwa/          Public service-worker tests
  web/          Web utility unit tests
  structure/    Workspace and configuration path checks
scripts/        Repository-level development and data utilities
deploy/         Dockerfiles and local infrastructure/preview Compose files
```

Run the commands below from the repository root. JavaScript workspaces share the root `package-lock.json`; Python uses the root `.venv`. App-local tests remain alongside their owning application in `frontend/coach`.

For PowerShell setup, environment-variable readers, and the local values needed for the synthetic demo, isolated database tests, or optional Auth0/Gemini, see the [local setup guide](deploy/local-setup.md).

Only repository-wide files stay at the top level: this README, npm manifests, `.env.example`, and Git/Docker ignore settings. Test configuration lives with tests, migration configuration lives with the database, and container configuration lives in `deploy/`.

## Run the web app

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000/demo for the synthetic demo. It works without a bank connection, database, or AI key. The account screens outside the demo require a configured API and sign-in provider.

### Challenge review

Start at `/demo`: **Try file import** opens the synthetic upload box; **Use sample file** previews the bundled `auto-taxis.csv` without a download or sign-in. Confirm it, then choose **View transactions** or **Ask Coach**. October 2026 taxis total **€30.97 across two transactions**. Personal statements belong in the separate authenticated `/import` workspace, not the public sample session.

**Try with sample data** opens `/demo?dataset=organizer1`. Its August 2026 taxi total is **€30.97**; the September dining baseline is **€797.88**, so a 20% historical reduction is **€159.58**. These are different datasets/periods despite the matching taxi amount. Overview, Coach, What if and Learn share the selected synthetic records; answers expose transaction evidence.

For verification, exact supported exports, local preview and remaining limitations, see [challenge readiness](tests/challenge-readiness-review.md). Real Gemini text and generated audio have passed opt-in local browser checks; physical-device audio and real Auth0 remain separate checks. The public HTTPS presentation is not automatically updated by local work.

Transaction search supports exact EUR minimum/maximum amounts combined with category, quoted merchant, period and selected accounts. For example, “Show last month's taxi rides over EUR 20.” uses a strict greater-than boundary of 2,001 cents, never floating-point rounding. Ambiguous ranges and unsupported currencies still ask for clarification. See [release checks](deploy/production-readiness.md) for safe configuration diagnostics, Auth0 setup, real-device/user trials and the backup/restore checklist; these are not a production certification.

For the standalone coach, run `npm run dev:coach` and open http://127.0.0.1:3001. Installation and offline behavior are available in production builds served over localhost or HTTPS. `npm run dev:complete` remains an alias.

### Speech and privacy

The coach supports editable microphone drafts and read-aloud responses in English, Finnish, and Estonian. Privacy mode defaults on; subsequent visits restore your saved choice. While enabled, it permits only browser-confirmed on-device speech support; when that is unavailable, the app keeps text input available instead of silently using a remote service. Microphone recording and playback require an explicit user action.

Optional hosted chat and voice routes remain disabled in `.env.example`. They require separate server opt-ins, a server-only key, absolute private usage-ledger paths and a shared finite allowance; adding a key alone enables nothing. Hosted chat also requires an exact allowed browser origin. Users must turn Privacy mode off before hosted processing is allowed. Gemini writes ordinary conversational replies; personal facts and charts come from validated server tools. Privacy stays local, and unavailable providers are labelled as a local fallback rather than a model success.

Interface labels and all six Learn topics use bundled English, Finnish and Estonian translations. Changing the interface language never calls an AI service. Coach replies are separate: supported conversation-language commands can change an answer's language without regenerating buttons, navigation or lessons. Unsupported interface languages leave the current interface unchanged and explain the available choices.

Set `MONEY_COACH_PUBLIC_AI_BUDGET_PATH` to an absolute ignored private file, `MONEY_COACH_PUBLIC_AI_MAX_REQUESTS` to a finite lifetime operation count, and optionally `MONEY_COACH_PUBLIC_AI_REQUESTS_PER_MINUTE` (default 6). Text, dictation and read-aloud share a single durable admission lock; one financial text operation can make two model calls. Optional `MONEY_COACH_PUBLIC_AI_BUDGET_MICRO_EUR` and `MONEY_COACH_PUBLIC_AI_RESERVATION_MICRO_EUR` bound operator-declared reservations, **not guaranteed provider charges or price quotes**. A provider-side billing limit is still needed for an actual monetary guarantee. Failed/cancelled attempts consume their reservation; restarting does not reset it. Privacy and rejected inputs make no hosted call. The local preview helper requires explicit Gemini opt-ins.

Model replies and audio are not cached or replayed. Bundled interface translations, saved transactions, user-confirmed classifications, preferences and the public static PWA shell are separate application data—not cached AI replies. Mocked tests do not establish live-provider availability, billing or physical microphone/speaker behavior.

Usage reservations are fail-closed. A forced process termination can leave a ledger lock requiring operator review; do not automatically delete locks or reset usage ledgers to bypass request limits.

## Run the API

Requires Python 3.12 or newer. On Windows:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend/api/requirements.txt
npm run dev:demo-api
```

The database-free synthetic API listens on http://127.0.0.1:8001. On macOS/Linux use `.venv/bin/python` to install dependencies. `npm run dev:api` starts the configured API on port 8000; it reads optional root `.env` settings. Secrets stay outside Git.

`npm run infra:up` starts local PostgreSQL and object storage using `deploy/compose.yaml`; `npm run infra:down` stops them without deleting volumes. Validate both Compose files with `npm run infra:check`. `deploy/compose.local.yaml` runs an isolated synthetic preview. See [deployment commands](deploy/README.md) for details. Real sign-in, bank access, and private storage require explicit service configuration and credentials; the demo enables none of these integrations.

Migration configuration is in `backend/db/alembic.ini`. To inspect the revision history without connecting to a database, run `.venv\Scripts\python.exe -m alembic -c backend/db/alembic.ini history` on Windows (use `.venv/bin/python` on macOS/Linux).

## Build and verify

```sh
npm run build
npm test
npm run test:web-money
npm run test:worker
npm run test:structure
```

Run API checks on Windows with `.venv\Scripts\python.exe -m pytest -c backend/api/pyproject.toml tests/api`. Browser checks use `npm run test:web`; they need an installed Chrome browser or Playwright Chromium. See the [test guide](tests/README.md) for suite commands and configuration locations. The `tests/integration` suite additionally requires isolated database and service configuration.

Builds generate PWA assets and exclude local secrets, caches, and agent working files. Public statistical fixtures retain their source and license metadata. Transactions and source observations retain their original dates for correct financial calculations.
