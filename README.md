# Personal Economic Trainer

A mobile-first finance coach with transaction exploration, three spending baskets, savings scenarios, and an installable demo. The project includes the web application, a standalone coach, a Python API, database migrations, and background workers.

## Run the web app

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000/demo for the synthetic demo. It works without a bank connection, database, or AI key. The account screens outside the demo require a configured API and sign-in provider.

For the standalone coach, run `npm run dev:complete` and open http://127.0.0.1:3001. Installation and offline behavior are available in production builds served over localhost or HTTPS.

## Run the API

Requires Python 3.12 or newer. On Windows:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r services/api/requirements.txt
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
```

Run API checks on Windows with `.venv\Scripts\python.exe -m pytest -c services/api/pyproject.toml tests/api`. Browser checks use `npx playwright test`; they need an installed Chrome browser or Playwright Chromium. The `tests/integration` suite additionally requires isolated database and service configuration.

Builds generate PWA assets and exclude local secrets, caches, and agent working files. Public statistical fixtures retain their source and license metadata. Transactions and source observations retain their original dates for correct financial calculations.
