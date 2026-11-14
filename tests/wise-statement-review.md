# Wise statement recheck

Verified on 2026-11-14 against this checkout's production web build and API, using disposable PostgreSQL 17.6. The integration fixture migrated a uniquely named database and created restricted runtime and identity roles, then removed those resources after each run. Signed offline test-OIDC tokens exercised PKCE, nonce, membership lookup, and the normal sign-in entry point. Bank providers and hosted models were disabled; Coach answered using local rules and owned server tools.

## Results

- `npm run build:web`: passed.
- `python -m pytest -c backend/api/pyproject.toml tests/integration/test_wise_browser.py -s` with `MONEYLENS_STATEMENT_BROWSER_TEST=true` and the temporary `MONEYLENS_TEST_DATABASE_URL`: the unchanged integrated browser case passed first (**1 passed**, 12.12 s), followed by the extended regression (**1 passed**, 11.11 s).
- `python -m pytest -c backend/api/pyproject.toml tests/api/test_statement_wise.py tests/api/test_statement_pdf.py tests/api/test_statement_lhv.py`: **20 passed**.
- Strict TypeScript checking of `tests/browser/wise-statement.spec.ts` and `tests/config/playwright.statement.config.ts`, Playwright test discovery, and `git diff --check`: passed.

The database-backed runs emitted a pytest cache-directory permission warning; assertions and fixture teardown completed successfully. The original attempt without a database URL skipped. An explicitly enabled run now fails clearly if that URL is absent, and this failure path was checked separately.

## CSV behavior exercised

The browser selected a synthetic EUR CSV, previewed two repeated-reference entries without creating an account, confirmed publication, reopened and reloaded the saved ledger, and obtained both records in a Coach answer. Repeated confirmation and repeated file selection preserved the two rows. Different CSV bytes covering the saved period returned HTTP 409 without exposing confirmation.

A second signed-in user could neither confirm the first user's preview nor read their account. Their own ledger and Coach answer were empty before import. The same CSV bytes could then be imported independently by that owner. Final administrator assertions found exactly two accounts, two receipts with four total rows, two rows totaling -1000 cents per owner, data version 2 for each owner, and no remaining previews. Thus repeats and rejected files caused no extra publication.

## PDF boundary and missing sample

The extended browser case uses a valid 734-byte synthetic PDF generated with the existing `pypdf` dependency. Before opening the browser, the fixture verifies its exact extracted text: a synthetic EUR heading and one synthetic transaction line. The CSV upload rejects this PDF before a preview request, offers no confirmation, and leaves both owners' saved rows intact. This is a text-PDF rejection check, not successful PDF ingestion.

The missing input is **one English Wise EUR account-statement PDF with a selectable text layer**, anonymized or synthesized while preserving the actual export layout: statement heading, account/currency labels, period, transaction column headings and positions, reference placement, dates, amount signs and decimal formatting, balances, and any repeated page headers or wrapped descriptions. No such verified Wise layout is present in the supplied fixtures. The generated rejection PDF deliberately does not invent one.

PDF preview-to-publication-to-Coach, PDF repeat-import, and CSV/PDF overlap matching remain unverified and unimplemented pending that sample and a derived synthetic adapter fixture. CSV coverage is complete for the selected journey above; no live Wise, external identity provider, or hosted model was exercised.
