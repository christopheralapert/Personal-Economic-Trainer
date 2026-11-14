# Self-service signup and six-format import integration

## Source and identity boundary

`integration/signup-wise-next` starts at the requested `1db8ae1`, without bringing in later UI changes or rewriting the source branch. The signup worktree's uncommitted files remain untouched. Registration is opt-in with `MONEYLENS_OIDC_SELF_SIGNUP_ENABLED=true`; the default remains invitation-only.

Only the callback's server-verified, exactly pinned OIDC issuer and subject can create a workspace. Email, browser owner fields and profile names cannot select one. A narrow security-definer function runs under the restricted identity role, serializing with membership writers; creation and session insertion share one database transaction. Repeated/concurrent login reuses the same tenant/member/state. Disabled, synthetic, duplicate or incomplete mappings fail closed, and existing membership fences/RLS remain in force.

## Actual migration graph and PostgreSQL checks

The IDs are distinct despite repeated filename prefixes. `0025_statement_provenance` and `0025_statement_formats` merge at `0026_merge_statement_branches`, followed by `0027_statement_file_provenance`. Signup's `0025_identity_self_signup` branches from `0024_statement_staging`. The new pure merge **`0028_merge_identity_statements`** has parents **`0027_statement_file_provenance` + `0025_identity_self_signup`** and is the single head. Existing migrations are not renamed or rewritten.

Temporary PostgreSQL checks cover an empty database and forward upgrades from 0024, either statement 0025, 0027 and signup's 0025. A populated 0027 database is created through the normal CSV publication API; upgrading twice retains row IDs, exact cents, receipt links and data version. The legacy populated-0024 replay regression also passes. Only uniquely created test databases/roles are removed; no development or presentation database was upgraded.

Combined `tests/api` plus identity/signup/membership, migration, statement and Coach integration selections: **1081 passed**. The migration CLI reports `0028_merge_identity_statements (head)`. The injected-write-failure assertions were adapted to the integrated API's existing generic error middleware; both whole-workspace/session rollback cases pass without leaking PostgreSQL errors. Existing dependency/intentional-forged-value warnings did not fail assertions.

## File selection → preview → confirmation → history → Coach

Additional checks: the reusable two-account fixture regression passed separately (1 test); workspace typechecks, strict new browser/config TypeScript, published-v1 contract compatibility, Coach 169 unit + 15 AI/PWA tests, main-worker 54 tests and 9 structure checks passed. `scripts.generate_wise_fixtures.write_signup_bundle(directory)` generates the exact three synthetic taxi/overlap files expected by the signup browser case.

The existing opt-in `tests/integration/test_wise_browser.py` ran its **seven browser cases** against this production frontend, signed offline test OIDC, real API and temporary PostgreSQL. Each format below completed the entire UI journey separately, including a repeat:

| Format | Precisely exercised synthetic export variant |
| --- | --- |
| PDF | English Wise EUR statement; selectable text, period/timezone labels, IBAN, recognized incoming/outgoing/amount heading, amount + running balance and transaction-reference detail lines; no OCR |
| XLSX | One OOXML sheet with Wise CSV columns and inline-string cells/text dates |
| CSV | UTF-8 Wise `TransferWise ID,Date,Amount,Currency,Description`, day-month-year dates and signed EUR decimal amounts |
| CAMT.053 XML | `camt.053.001.10`, one EUR statement, booked entries, one transaction detail per entry, CRDT/DBIT and remittance/reference |
| MT940 | One EUR statement with `20`, `25`, `28C`, `60F`, `61`/`86`, `62F` and bank references |
| QIF | `!Type:Bank`, D/T/P records, explicit day-first slash dates, explicit destination account and EUR currency |

The mixed-file browser case covers native multi-selection, exact CSV→PDF/XLSX whole-statement matching, two accounts, second-owner isolation, and rejected scanned/unknown/broken PDFs. Two distinct same-reference, same-amount purchases remain two rows. All adapters publish through the existing normalized exact-cent ledger path; History and Coach read those stored rows.

The separate signup journey also submits a partially overlapping CSV to the same account: confirmation returns 409, the UI offers removal or explicit separate purchases, and removing the file leaves the three saved rows unchanged. Partial overlaps are **not** automatically merged by guessing transaction identity.

These are bounded variants, not universal bank-export support. Additional samples are still required for other-language/changed PDF layouts (scans need CSV, not OCR), XLSX title rows/multiple sheets/1904 dates/formulas, aggregated or multi-statement CAMT/different namespaces, wrapped/paged MT940 or alternative tag-86 conventions, and QIF account headers/splits/other date conventions. See [the detailed variant boundaries](wise-statement-review.md#variant-boundaries-and-samples-for-expansion).

## Two fresh identities and real Gemini regression

On a fresh local database with **zero pre-provisioned members**, two 390 × 844 Chrome contexts sign in as `model-review` and `other-owner` through a clearly labelled offline test issuer. Server-side RSA signature, pinned issuer/audience, nonce, PKCE, browser-bound one-use state, opaque cookies and CSRF run normally. This is **test OIDC, not real Auth0**. Each first login starts with empty accounts/ledger and creates a distinct private workspace; signing in again returns to the same workspace with its saved accounts.

Owner A selects a two-row synthetic Wise CSV and one-row CAMT XML together, binds two accounts, confirms, opens saved History, reviews taxi/everyday classification, and repeats the CSV with **zero rows added**. The saved amounts are −1500, −1597 cents on A and −700 cents on B. The Finnish question is `Paljonko käytin takseihin lokakuussa 2026?`.

| Account scope | Saved net expense / visible answer | Evidence opened | Local answer latency | Real Gemini answer latency |
| --- | --- | --- | ---: | ---: |
| A | **3097 cents / 30,97 EUR** | Both rows + actual detail | 86 ms | 2749 ms |
| B | **700 cents / 7,00 EUR** | One row + actual detail | 69 ms | 1452 ms |
| A + B | **3797 cents / 37,97 EUR** | Three rows + actual detail | 61 ms | 1372 ms |

All three real replies had **`source=model`, `provider=gemini-direct`**, model **`gemini-3.5-flash`**, no fallback diagnostic, and a visible Finnish sentence naming 2026-10-01–2026-10-31. Each result was compared to actual saved ledger rows and evidence, not screenshots alone. Their model waits were 2084.7 / 1370.2 / 1289.0 ms; server application times were 37.2 / 36.2 / 31.1 ms. Confirmation→first visible History: **285 ms**. These are single observations, not benchmark percentiles. The existing 5.3-second model cooldown is outside question timings; no limits were relaxed, no provider retries were added and no EACCES occurred.

Owner B initially sees an empty Coach/ledger, gets 404 for A's account and receipt, then imports the same CSV independently and sees only its own two saved rows. A still has exactly three. Workspace IDs differ, and repeated login preserves A's owner IDs while rotating the session. No horizontal overflow or browser page error was observed.

**Integration classification:** three real Gemini text interpretations; the three matching Privacy-mode answers use local rules. The six-format browser fixture disables hosted models. All identity tests use signed offline test OIDC; **real Auth0 and real bank logins were not run**. No real/customer statement, Gemini audio or physical-phone microphone is involved.

## Running local rehearsal and reproducibility

Local preview: **http://127.0.0.1:33123/banks** (choose `model-review` or `other-owner` at the test issuer). Coach: **http://127.0.0.1:33123/coach**. The frontend is unchanged from the requested base and its production artifact is `frontend/web/.next/signup-wise-20261114`, **build `1db8ae1-131377e695625033`**; the integrated backend is served from the signup integration source. Root ignored `.env` and the existing Gemini key were preserved. Public HTTPS presentation and its hosted-text/audio-off mode, ngrok and port 33118 were not changed. No push.

Commands: `npm run typecheck`; `python -m alembic -c backend/db/alembic.ini heads`; `python -m pytest -c backend/api/pyproject.toml tests/api` plus `tests/integration/test_self_signup.py`, `test_identity.py`, `test_invited_members.py`, `test_membership_fence.py`, `test_statement_branch_upgrade.py`, `test_statement_migration.py`, `test_statement_formats_flow.py`, `test_wise_flow.py`, `test_statement_staging.py`, `test_statement_publication.py`, `test_coach_query.py`, `test_coach_languages.py`. The six-format browser fixture requires the isolated DSN, `MONEYLENS_STATEMENT_BROWSER_TEST=true` and matching `MONEYLENS_NEXT_DIST`. The two-owner browser configuration requires its fresh local rehearsal and generated synthetic fixtures; `MONEYLENS_SIGNUP_LIVE_GEMINI=true` explicitly opts into the three paid calls. Logs, generated files, browser traces, timings and rehearsal launchers stay ignored under `test-results/` and `.cache/`.
