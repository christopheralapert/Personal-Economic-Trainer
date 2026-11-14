# Personal Economic Trainer

A mobile-first finance coach with transaction exploration, three spending baskets, savings scenarios, and an installable demo. The project includes the web application, a standalone coach, a Python API, database migrations, and background workers.

## Repository layout

```text
frontend/
  web/          Main Next.js application and account screens
  coach/        Standalone coach, shared UI, and demo datasets
  prototype/    Vite dashboard prototype
backend/
  api/          Python API and dependency definitions
  workers/      Scoped background job runner
  db/           Database migrations and SQL
packages/
  contracts/    Shared API schemas and generated TypeScript types
fixtures/       Public reference data and synthetic test inputs
tests/          API, integration, browser, PWA, and structure checks
scripts/        Repository-level development and data utilities
deploy/         Container images and isolated preview configuration
```

Run the commands below from the repository root. JavaScript workspaces share the root `package-lock.json`; Python uses the root `.venv`. App-local tests remain alongside their owning application in `frontend/coach`.

## Run the web app

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000/demo for the synthetic demo. It works without a bank connection, database, or AI key. The account screens outside the demo require a configured API and sign-in provider.

For the standalone coach, run `npm run dev:coach` and open http://127.0.0.1:3001. Installation and offline behavior are available in production builds served over localhost or HTTPS. `npm run dev:complete` remains an alias.

The Vite prototype is separate: use `npm run dev:prototype`, `npm run build:prototype`, or `npm run preview`. Its source, public assets, and build output live under `frontend/prototype`.

## Run the API

Requires Python 3.12 or newer. On Windows:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend/api/requirements.txt
npm run dev:demo-api
```

The database-free synthetic API listens on http://127.0.0.1:8001. On macOS/Linux use `.venv/bin/python` to install dependencies. `npm run dev:api` starts the configured API on port 8000; it reads optional root `.env` settings. Secrets stay outside Git.

`compose.yaml` provides local PostgreSQL and object storage. `deploy/compose.local.yaml` runs an isolated synthetic preview. Real sign-in, bank access, and private storage require explicit service configuration and credentials; the demo enables none of these integrations.

## Build and verify

```sh
npm run build
npm test
npm run test:web-money
npm run test:worker
npm run test:structure
```

Run API checks on Windows with `.venv\Scripts\python.exe -m pytest -c backend/api/pyproject.toml tests/api`. Browser checks use `npx playwright test`; they need an installed Chrome browser or Playwright Chromium. The `tests/integration` suite additionally requires isolated database and service configuration.

Builds generate PWA assets and exclude local secrets, caches, and agent working files. Public statistical fixtures retain their source and license metadata. Transactions and source observations retain their original dates for correct financial calculations.
