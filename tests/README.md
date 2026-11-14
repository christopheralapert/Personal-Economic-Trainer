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
- `playwright.statement.config.ts`: invoked by the isolated Wise statement integration fixture.

List the default browser cases without starting servers:

```sh
npm run test:web -- --list
```

Pass test selections through the root command, for example `npm run test:web -- tests/browser/dashboard.spec.ts`. Standalone coach unit and browser tests stay under `frontend/coach`; run its unit suite with `npm test` and its browser suite with `npx playwright test --config frontend/coach/playwright.config.ts`.

## Wise statement browser regression

Build this checkout with `npm run build:web`, then run the opt-in fixture from the repository root:

```powershell
$env:MONEYLENS_TEST_DATABASE_URL = '<isolated PostgreSQL administrator connection>'
$env:MONEYLENS_STATEMENT_BROWSER_TEST = 'true'
.venv\Scripts\python.exe -m pytest -c backend/api/pyproject.toml tests/integration/test_wise_browser.py -s
```

The fixture creates and removes a unique database and restricted runtime/identity roles. Ports 33111 and 18030 must be free. It starts this checkout's production frontend and API, uses signed offline test-OIDC tokens with PKCE and nonce checks, and disables bank providers and hosted models. Only the issuer page is simulated in the browser; statement, ledger and Coach requests pass through the real frontend proxy to PostgreSQL. Screenshots and failure traces stay under ignored `test-results/statement/`. Use `MONEYLENS_NEXT_DIST` only when the build used that same directory.

Verified on 2026-11-14: native file selection, preview without creating an account, confirmation, reopening the page, reload, repeated confirmation, same-page and reopened-file repeats, saved Coach records, and two-user isolation. The two repeated-reference EUR rows remain separate; repeated imports do not add rows. Each user can independently import the same bytes. The file picker clears after a successful preview so the same file can be selected again.

A verified identity without an administrator-provisioned membership reaches `/access`; login does **not** automatically create a workspace. Provisioning creates the private tenant and user state. PDF does **not** reach saved transactions: the upload flow accepts Wise EUR CSV only; `statement_pdf.py` is an offline text extractor with separate unit tests. Coach verification uses local rules and owned server tools, without a hosted model.

The coach's `playwright.public.config.ts` checks speech and privacy controls against an already running main web build. Start `npm start -- --port 33110`, then run `npx playwright test --config frontend/coach/playwright.public.config.ts`. Set `MONEY_COACH_PUBLIC_ORIGIN` if the preview uses another local origin. Keep hosted services disabled: the suite mocks microphone input, speech output, and hosted voice responses and forces local-rule answers for mocked voice cases. It does not establish physical-device speech support or live provider availability.
