# Test suites

Latest working-tree acceptance and blockers: [challenge readiness](challenge-readiness-review.md). This supersedes older preview URLs, migration-head and unlimited-public-chat statements; earlier reports retain their historical build context. `playwright.challenge.config.ts` runs the EN/FI/ET organizer and anonymous sample-import journey in installed Chrome and emulated WebKit at 390 × 844 and 1280 × 900. `playwright.planning-review.config.ts` checks the reviewed planner with mocked session/API fixtures; the independent PostgreSQL planning suites verify actual calculations, authorization and persistence. Neither is a real-phone or Auth0 test.

`playwright.amount-search.config.ts` verifies exact EUR transaction bounds through the real demo composer. Its private case requires `MONEYLENS_AMOUNT_SEARCH_PRIVATE=true` and a fresh isolated test-OIDC/PostgreSQL rehearsal; it imports two accounts, checks exact row scopes, a native Gemini mock response and local Privacy, and opens transaction evidence. Set `MONEYLENS_AMOUNT_SEARCH_ORIGIN` to the dedicated loopback build. `tests/api/test_amount_search.py` and `tests/integration/test_amount_search_flow.py` cover parser parity, invalid/changed model arguments, signed-cursor bounds, refunds and owner isolation. Shared vectors are in `fixtures/synthetic/amount-search.v1.json`. The older amount-guard cases now retain unsupported-currency/negative-bound protection, rather than rejecting supported EUR limits.

For historical signup + redesigned UI/Learn + six-format/private-Gemini evidence, see [the earlier release handoff](signup-statements-review.md#final-integrated-release--14-november-2026). Its preview and build are not the current working-tree preview. The earlier [700-row timing comparison](import-coach-review.md#current-integrated-follow-up-from-f70f933--14-november-2026) also retains its own source/build context.

The [release-branch amount-limit guard follow-up](signup-statements-review.md#amount-limit-guard-integrated-into-the-release-branch) records the independent fix, zero-model-call ET/EN/FI checks, preserved regular taxi evidence and the production preview on 33129. `tests/config/playwright.amount-guard.config.ts` attaches to the explicitly isolated signed test-OIDC/PostgreSQL fixture with native Gemini **mock transport only**, not live inference.

Run commands from the repository root after installing dependencies. Browser suites require Chrome or Playwright Chromium. Most also require a production web build; the voice suite starts its own development server.

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
- `playwright.demo.config.ts`: phone presentation and public entry checks; run `npm run build:web` then `npm run test:demo`. No Python API, database, identity provider, bank or hosted AI is needed.
- `playwright.container.config.ts`: foundation checks against an already running container preview; run `npm run test:web:container`.
- `playwright.finance.config.ts`: invoked by the isolated finance integration fixture; its opt-in guard remains enabled.
- `playwright.first-login.config.ts`: invoked by the isolated identity integration fixture.
- `playwright.statement.config.ts`: invoked by the isolated Wise statement integration fixture.
- `playwright.signup-statements.config.ts`: fresh local self-signup + two-owner import/Coach rehearsal, with real Gemini only when explicitly opted in; see [the combined report](signup-statements-review.md).
- `playwright.release.config.ts`: attached loopback production rehearsal, recovery/concurrent confirmation, same-tab owner isolation, exact account scopes and Chromium/WebKit mobile/desktop journeys. Requires `MONEYLENS_RELEASE_ORIGIN` and fresh signed test identities. The real-Gemini project additionally requires `MONEYLENS_RELEASE_LIVE_GEMINI=true` and the signup fixture's saved/reviewed rows; otherwise it skips. See the integrated handoff for setup and exact synthetic variants.
- `playwright.voice.config.ts`: run `npm run test:web:voice` for Finnish, Estonian, and English dictation and read-aloud checks on `/demo?dataset=organizer1`. The runner starts the main Next.js application on an automatically selected free loopback port and stops it afterwards; no production build, database, microphone, or provider key is required. It uses local Chrome (Playwright Chromium in CI). Speech recognition, synthesis, microphone capture, and hosted voice replies are mocked. Hosted chat stays disabled; real local-rule answers supply the visible sentences. Reports stay in `test-results/voice`. Phone screenshots cover 360/390 px in light/dark appearance under `.cache/voice-review/`. See [the voice review](voice-review.md) for verified results, mock boundaries and physical phone steps.

Use [challenge readiness](challenge-readiness-review.md) for the current local build, startup commands and live-provider blockers. The [voice review](voice-review.md) retains physical-phone trial instructions; mocked browser speech is not a device check. Public HTTPS deployment and ngrok are managed separately and are not updated by these tests.

List the default browser cases without starting servers:

```sh
npm run test:web -- --list
```

Pass test selections through the root command, for example `npm run test:web -- tests/browser/dashboard.spec.ts`. Standalone coach unit and browser tests stay under `frontend/coach`; run its unit suite with `npm test` and its browser suite with `npx playwright test --config frontend/coach/playwright.config.ts`.

The demo suite starts the production web build on port 31361. It checks Finnish taxi answers and transaction details at 390px and 360px, the three classified baskets (with unreviewed payments shown separately), and September 2026 dining reductions of 20% yielding 159,58 €. Chat uses the real local-rule stream through test transport; private session checks and the bank directory are mocked, hosted voice is disabled, and external browser requests are blocked. Screenshots and failure traces stay under ignored `test-results/demo/`.

To test an already running local production web build, set `MONEYLENS_DEMO_TEST_ORIGIN` to its HTTP origin, including the port, before running `npm run test:demo`. Only loopback origins are accepted. The supplied server stays running after the suite finishes; the test transport still forces local-rule chat and intercepts private APIs.

Keyboard regression: on `/demo?dataset=organizer1`, press Tab to focus “Skip to content”, then Enter. Focus must move to the single `main#main[tabindex="-1"]`, not merely add `#main` to the URL. `demo-keyboard.spec.ts` tests this at 360px and 1280px, with the demo loaded and with JavaScript held back during initial loading. Focus must survive hydration and the dataset planning provider's remount without overriding a later user focus choice. The root layout's native anchor remains usable before JavaScript runs; its client enhancement restores focus only when a focused landmark is removed.

## Wise statement browser regression

Synthetic-only timing is a separate opt-in, not part of normal CI or a live-model test. Start an isolated production rehearsal with a fresh database and the explicitly labelled offline test issuer, provisioning unused `large-cold` and `large-warm` subjects. Restart API/web first for the cold condition, then run:

```powershell
$env:MONEYLENS_PERFORMANCE_REHEARSAL = 'true'
node scripts/measure_statement_imports.mjs http://127.0.0.1:33120
Remove-Item Env:MONEYLENS_PERFORMANCE_REHEARSAL
```

It imports the fixed 700-row/28,639-byte synthetic Wise CSV, measures visible UI outcomes, keeps Privacy mode on, and verifies all saved rows afterward. It refuses non-loopback origins and missing opt-in; it does not provision an issuer/database or establish that a previously used process is cold. Run only against the disposable synthetic rehearsal, never an ordinary user's workspace. Results are ignored under `test-results/statement-performance/`; fixture/guard checks run with `npm run test:structure`.

Build this checkout with `npm run build:web`, then run the opt-in fixture from the repository root:

```powershell
$env:MONEYLENS_TEST_DATABASE_URL = '<isolated PostgreSQL administrator connection>'
$env:MONEYLENS_STATEMENT_BROWSER_TEST = 'true'
.venv\Scripts\python.exe -m pytest -c backend/api/pyproject.toml tests/integration/test_wise_browser.py -s
```

For a disposable local PostgreSQL instance, run `docker run --rm -d --name moneylens-wise-test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55439:5432 postgres:17.6-alpine` and set `MONEYLENS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/postgres`. This instance accepts connections only on loopback and contains test data only. Stop it afterwards with `docker stop moneylens-wise-test`. An explicitly enabled statement browser run fails when the database URL is missing; it must not silently skip the requested verification.

The fixture creates and removes a unique database and restricted runtime/identity roles. Ports 33111 and 18030 must be free. It starts this checkout's production frontend and API, uses signed offline test-OIDC tokens with PKCE and nonce checks, and disables bank providers and hosted models. Only the issuer page is simulated in the browser; statement, ledger and Coach requests pass through the real frontend proxy to PostgreSQL. Screenshots and failure traces stay under ignored `test-results/statement/`. Use `MONEYLENS_NEXT_DIST` only when the build used that same directory.

The suite generates synthetic CSV, text PDF, XLSX, CAMT.053 v10 XML, MT940 and QIF files with `scripts/generate_wise_fixtures.py`. Seven browser cases cover each format through preview, atomic publication, saved history and Coach, plus a mixed batch with invalid PDFs, cross-format repeats, multiple account filters and two-user isolation. No real statement fixture is needed. With self-service signup disabled, a verified identity without administrator-provisioned membership reaches `/access`. See [identity self-service signup](identity-signup.md) for the opt-in creation path, concurrency checks and migration requirements.

The import picker accepts up to ten files, 2 MiB each. Missing account/currency/date-order information requires an explicit user choice. Exact-byte repeats and complete cross-format statement matches do not append rows; uncertain partial overlap needs a separate-purchase confirmation or removal. Repeated Wise references are never treated as unique transaction IDs. Existing legacy CSV commands remain supported.

See [the statement verification report](wise-statement-review.md) for exact tested export variants, commands, results, matching boundaries and sample requirements for additional layouts. Extra database checks: `python -m pytest -c backend/api/pyproject.toml tests/integration/test_statement_formats_flow.py tests/integration/test_wise_flow.py tests/integration/test_statement_staging.py`.

The coach's `playwright.public.config.ts` checks speech and privacy controls against an already running main web build. Start `npm start -- --port 33110`, then run `npx playwright test --config frontend/coach/playwright.public.config.ts`. Set `MONEY_COACH_PUBLIC_ORIGIN` if the preview uses another local origin. Keep hosted services disabled: the suite mocks microphone input, speech output, and hosted voice responses and forces local-rule answers for mocked voice cases. It does not establish physical-device speech support or live provider availability.

Run `npm run test:web-coach` for the main `/demo?dataset=organizer1` Coach in English, Estonian and Finnish. This suite starts its own web development server on an OS-selected free loopback port, with a separate `.next/coach-chat` directory and hosted services disabled. It checks the visible August 2026 taxi answer (30,97 €), transaction details, selector-only follow-ups and session restoration. `frontend/coach/src/coach/public-chat-route.test.ts` separately exercises the main web `/api/chat` export through the native Gemini adapter using an injected test transport and the real AI SDK stream decoder; it makes no live model calls.

## Saved imports and private Gemini

See [the import/Coach verification record](import-coach-review.md) for supported CSV schemas, source/ownership boundaries, browser proof and timing methodology. Hosted inference is opt-in; use the existing root key and the separate private configuration in [local setup](../deploy/local-setup.md). Privacy mode defaults to local answers.

With `MONEYLENS_TEST_DATABASE_URL` pointing to a disposable isolated administrator database, run:

```powershell
.venv\Scripts\python.exe -m pytest -c backend/api/pyproject.toml tests/api -p no:cacheprovider
.venv\Scripts\python.exe -m pytest -c backend/api/pyproject.toml tests/integration/test_statement_publication.py tests/integration/test_statement_migration.py tests/integration/test_coach_languages.py tests/integration/test_private_gemini.py -p no:cacheprovider
```

The private Gemini tests inject Google's native HTTP response shape, but execute actual authenticated server tools against PostgreSQL. They do not contact Google. The language matrix separately verifies search, category totals, month comparison, follow-ups, a 20% reduction, missing-data spending/saving requests, empty results, and another user's isolation. Source-equivalence tests preserve the distinction between equal amounts and unequal history coverage; newly imported unknown flows must be explicitly reviewed before becoming spending.

## Automatic statement classification

The multi-format preview classifies once, before publication. Flow evidence is required before a merchant category can become spending. Source categories, the shared bank MCC map, exact service names and explicitly saved private merchant rules are local. Conflicting evidence and bare multi-service names such as BOLT stay in review. Confirmation stores the selected classification; History, Overview and Coach read those saved values. Exact statement repeats preserve earlier corrections; uncertain partial overlaps still require explicit review.

Cloud suggestions require `MONEYLENS_STATEMENT_CLOUD_CLASSIFICATION_ENABLED=true`, the existing private Gemini configuration, Privacy mode off, and explicit consent plus a button press in the preview. Only whole-label matches to approved public-brand aliases are sent, once per batch, with temporary matching codes. Unknown businesses, personal names and labels containing memo/account information stay local. Suggestions cannot set flow or baskets. Privacy/consent withdrawal discards late suggestions; manual edits take precedence. No cloud service is needed to preview or confirm locally.

Create synthetic CSV/PDF/XLSX/XML/MT940/QIF samples and a dedicated production rehearsal (loopback PostgreSQL administrator required; never use a real-data database):

```powershell
.venv\Scripts\python.exe -m scripts.generate_classification_fixtures
node scripts/local_classification_preview.mjs build
# Set MONEYLENS_TEST_DATABASE_URL for your isolated PostgreSQL administrator if
# not using this machine's existing synthetic test service on port 55440.
node scripts/local_classification_preview.mjs start --live-classification
```

`--live-classification` reads only `GEMINI_API_KEY` from the root ignored `.env` into the classification server. Omit the flag to use native Gemini test transport with no hosted calls. This test-only launcher creates its own disposable database, verified signed test-OIDC identities and ports **33132/18052**. Private Coach interpretation is mocked; Privacy-mode Coach uses real local tools against saved PostgreSQL rows. Hosted demo chat/audio remain off in this rehearsal. Ordinary production authentication does not include this test identity chooser.

Open `http://127.0.0.1:33132/api/v1/auth/login`, choose **auto-main**, then `/banks`. Import `.cache/auto-classification-fixtures/auto-taxis.csv` or `.xlsx`, choose a new account, and confirm the proposed taxi categories without editing. The two October 2026 purchases total **30.97 EUR**. **fresh-preview** is an empty private workspace. `auto-mixed.csv` includes ambiguous merchants, transfers, a refund and two public-brand aliases for optional cloud classification; coffee totals **6.00 EUR** after its two suggestions. Generated files/screenshots stay ignored.

Run the mobile (390 × 844) suite against a freshly started rehearsal:

```powershell
# Optional paid synthetic classification case; otherwise it is explicitly skipped.
$env:MONEYLENS_CLASSIFICATION_REAL = 'true'
npx playwright test --config tests/config/playwright.auto-classification.config.ts
Remove-Item Env:MONEYLENS_CLASSIFICATION_REAL
```

The suite consumes distinct fresh identities, so reset only this rehearsal before repeating it. It tests CSV/XLSX publication → History reload → Overview → Coach/evidence, 700-row bounded rendering, remembered corrections, exact repeats, owner isolation, zero new calls in Privacy mode and a held late suggestion. It explicitly switches test transport for mock cases; the opted-in live case verifies one genuine Gemini call separately. Unit and database checks are `tests/api/test_automatic_classification.py` and `tests/integration/test_auto_classification_flow.py`. The existing six-format browser fixture above remains the format regression.
