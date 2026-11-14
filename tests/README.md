# Test suites

Run commands from the repository root after installing dependencies. Browser suites require a production web build and Chrome or Playwright Chromium.

| Folder | Purpose | Command |
| --- | --- | --- |
| `api/` | Database-free Python API tests | `.venv\Scripts\python.exe -m pytest -c backend/api/pyproject.toml tests/api` |
| `web/` | TypeScript web utilities | `npm run test:web-money` |
| `pwa/` | Public service-worker cache and privacy behavior | `npm run test:worker` |
| `structure/` | Workspace, migration, and browser config paths | `npm run test:structure` |
| `browser/` | Main web application | `npm run test:web` |
| `integration/` | Opt-in isolated database and service tests | `.venv\Scripts\python.exe -m pytest -c backend/api/pyproject.toml tests/integration` |
| `finance-browser/` | Database-backed financial journey | Started by the opt-in Python integration fixture |

On macOS/Linux replace `.venv\Scripts\python.exe` with `.venv/bin/python`. Integration tests require an explicitly configured isolated test database; do not point them at development or production data.

## Browser configuration

All main-app Playwright configurations live in `tests/config/`. They resolve test directories and server working directories independently of where the config file is stored. Browser artifacts are ignored under root `test-results/`.

- `playwright.config.ts`: default synthetic/API-backed application checks.
- `playwright.legal.config.ts`: isolated legal-page configuration; run `npm run test:web:legal`.
- `playwright.container.config.ts`: foundation checks against an already running container preview; run `npm run test:web:container`.
- `playwright.finance.config.ts`: invoked by the isolated finance integration fixture; its opt-in guard remains enabled.
- `playwright.first-login.config.ts`: invoked by the isolated identity integration fixture.

List the default browser cases without starting servers:

```sh
npm run test:web -- --list
```

Pass test selections through the root command, for example `npm run test:web -- tests/browser/dashboard.spec.ts`. Standalone coach unit and browser tests stay under `frontend/coach`; run its unit suite with `npm test` and its browser suite with `npx playwright test --config frontend/coach/playwright.config.ts`.

The coach's `playwright.public.config.ts` checks speech and privacy controls against an already running main web build. Start `npm start -- --port 33110`, then run `npx playwright test --config frontend/coach/playwright.public.config.ts`. Set `MONEY_COACH_PUBLIC_ORIGIN` if the preview uses another local origin. Keep hosted services disabled: the suite mocks microphone input, speech output, and hosted voice responses and forces local-rule answers for mocked voice cases. It does not establish physical-device speech support or live provider availability.
