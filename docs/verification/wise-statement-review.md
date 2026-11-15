# Wise EUR multi-format import verification

## Coordinator integration — 14 November 2026

Latest follow-up: the same checked application is now on **`integration/import-coach-next`**, advanced from the requested `f70f933` without rewriting history. Its fresh 700-row cold/warm repeat, new live model-review identity journey and current links supersede the earlier running-preview details below; see [the current import/Coach follow-up](import-coach-review.md#current-integrated-follow-up-from-f70f933--14-november-2026). The application build remains `f9bebef-131377e695625033`.

Commit `6f611b0` is integrated on **`integration/wise-multiformat-next`**, merge `08475f7`, with backward-compatible replay fix **`f9bebef`**. The final production artifact is `frontend/web/.next/wise-multiformat-final-20261114`, **build `f9bebef-131377e695625033`**. Test/documentation-only commits after that source do not change its build ID. The running isolated preview is **http://127.0.0.1:33120/banks**; sign in using its clearly labelled test issuer, selecting **other-owner** for the completed live journey. This is signed offline OIDC with real sessions, CSRF, ownership checks, BFF/API and PostgreSQL, **not a real Auth0 or bank connection**. No push was made.

### Actual migration IDs and disposable PostgreSQL proof

The repeated `0025` filename prefix is not a duplicate Alembic revision ID. The actual graph is:

| Revision ID | Parent(s) | Integrated status |
| --- | --- | --- |
| `0025_statement_provenance` | `0024_statement_staging` | Previously integrated; preserved unchanged |
| `0025_statement_formats` | `0024_statement_staging` | From `6f611b0`; preserved unchanged |
| `0026_merge_statement_branches` | Both statement `0025` revisions | Permanent merge; no schema rewrite |
| `0027_statement_file_provenance` | `0026_merge_statement_branches` | **Single current head**; supports every bounded adapter's provenance and account-scoped file/content uniqueness |
| `0025_identity_self_signup` | `0024_statement_staging` | Still uncommitted in the separate signup worktree; **not included in this application** |

`.venv\Scripts\python.exe -m alembic -c backend/db/alembic.ini heads` returns exactly **`0027_statement_file_provenance (head)`**. `tests/api/test_statement_migration_graph.py` checks unique IDs and graph edges. `tests/integration/test_statement_branch_upgrade.py` upgrades fresh temporary databases from **0024**, **0025 provenance**, and **0025 formats** to the same single version row. The normal database fixture also proves an empty-database upgrade. The populated 0024 migration test preserves transaction IDs, receipt links, exact cents, classification and data version; a byte-exact legacy CSV replay through the new file API adds **zero rows**. Forbidden downgrade remains forbidden.

Before considering any non-test database update, the actual pending signup migration was also tested in an **ignored, temporary version-location overlay**, with an explicit scratch-only merge of signup and the integrated head. Both first and repeated upgrades passed; its identity function and index existed alongside statement provenance. The scratch database was removed. This proves migration compatibility, **not integration or validation of the uncommitted signup application changes**. A permanent merge revision will still be needed when that work is actually integrated. The signup worktree, development database, existing ngrok process and 33118 demo were untouched.

### Integration resolutions

- Kept the existing private Coach language, Privacy mode, owned-account scope and model path. Added statement-date display without introducing a second account selector. Kept both post-import actions, **View transactions** and **Ask Coach**, with saved account/period selectors and an editable draft.
- All file variants publish already normalized values through the same exact-cent bulk insert as the existing CSV path. Actual source format, owned account, receipt ID and row hash remain linked; files are not reparsed by History, Overview or Coach. Legacy Wise/canonical JSON API routes remain compatible. The explicit canonical EUR-cents CSV header is also recognized by the file picker (**64 KiB** canonical limit); its adapter has a regression test. This is additional to the six Wise variants documented below, not a claim of arbitrary CSV support.
- Exact-byte receipt uniqueness is now **owner + account** scoped. Keyless CSV/XLSX/QIF repeats require a destination account before declaring a duplicate; identical bytes may legitimately belong to two distinct accounts. Complete cross-format signatures retain row multiplicity. Changed QIF date interpretation on an already saved account returns a conflict, never the wrong old result. A fixed-interpretation, byte-exact pre-upgrade CSV receipt without a retained canonical signature can still replay safely; missing old references do not enable speculative cross-format matching.
- Rejected ambiguous PDF amount columns rather than turning a debit into zero. Added debit/credit/ambiguous-column, MT940 leap-day/year-boundary, and maximum declared-date regressions. Unknown layouts still fail closed. The original agent's generated service-worker hash was not used to replace unrelated running previews' public assets.

### Final regression results

- Production build, both workspace typechecks and published v1 contract compatibility: **passed**.
- `tests/api`: **975 passed**.
- Combined PostgreSQL migration/import/RLS/Coach selection: **65 passed**, including the opted-in Wise fixture's **7 passing browser cases**. This is a targeted combined run, not a repeat of the older full 439-test suite.
- Final production main-web browser suites: **15 demo, 5 Coach, 74 voice passed**. Recognition, synthesis, microphone capture and Gemini audio are mocked; local financial calculations run normally. These are not live audio or physical-phone results.
- Coach unit/transport suite: **169 Vitest + 15 Node AI/PWA passed**; main PWA **54**, structure **9**, web utilities **7** passed. Separate strict voice/browser TypeScript check and `git diff --check` passed.

Commands use the existing `tests/api`, `tests/integration/test_statement_branch_upgrade.py`, `test_statement_migration.py`, `test_statement_formats_flow.py`, `test_statement_publication.py`, `test_statement_staging.py`, `test_wise_flow.py`, `test_database.py`, `test_wise_browser.py`, `test_coach_query.py` and `test_coach_languages.py` selections. The browser fixture opts in with `MONEYLENS_STATEMENT_BROWSER_TEST=true` and `MONEYLENS_NEXT_DIST` matching the isolated artifact. Every database is uniquely created in a dedicated local PostgreSQL 17.6 test container; cleanup only removes those test databases/roles. Existing dependency deprecation and intentional forged-value serializer warnings did not fail assertions.

### Real Gemini: one account, then both

On the **ordinary authenticated web UI**, a fresh synthetic **Wise CSV** supplied two same-reference taxi purchases of **−15.00 and −15.97 EUR** to account A. A synthetic **CAMT.053 v10 XML** supplied **−7.00 EUR** to account B. The native picker previewed both, explicit account choices were confirmed atomically, History displayed the saved rows, and each was reviewed as a taxi/everyday expense using the normal classification sheet. A repeat import added **zero** rows and retained those reviews. **Ask Coach** opened the selected saved account. Files without review are not silently promoted to classified expenses.

Choose Suomi, disable Privacy mode and ask **Paljonko käytin takseihin lokakuussa 2026?** first with account A selected, then with all included EUR accounts. Both final replies were HTTP 200, **`source=model`, `provider=gemini-direct`**, model **`gemini-3.5-flash`**, with no fallback diagnostic:

| Scope | Saved row sum / answer | Evidence opened | Question → visible answer | Model wait | Application |
| --- | --- | --- | ---: | ---: | ---: |
| Account A | −3,097 cents / **30,97 EUR** | Both rows; actual transaction detail | **3,261 ms** | 3,182.8 ms | 34.4 ms |
| Accounts A + B | −3,797 cents / **37,97 EUR** | All three rows; actual transaction detail | **1,539 ms** | 1,463.4 ms | 40.1 ms |

Both visible Finnish sentences named **2026-10-01–2026-10-31**. The second answer changed by exactly **700 cents**, equal to the added account's saved transaction. The actual ledger responses and answer artifact, not screenshot text alone, were checked. **Confirmation → first visible History rows: 220 ms**, including clicking View transactions. Timings are single 390×844 desktop-Chrome observations; model wait includes both network and Google's processing, not a separately measured inference duration. The 5.3-second pause between final questions respects the existing per-user five-second model cooldown and is outside the individual question timers.

An earlier live attempt completed the single-account question and evidence, but its immediately following second question received local HTTP **429** from the cooldown. It was **not** counted as a passing model answer. The complete fresh-owner retry above then passed both scopes. Thus this round made **three successful real Gemini text interpretations in total** (one initial + two final); the rejected request did not reach model interpretation. No automatic provider retries or relaxed rate limits were added. No real-call `EACCES` occurred.

A separate final-build Privacy-mode journey used **local rules only**, returned the same **3,097/3,797-cent** results and opened the same evidence. Other regression model transports were injected; the live browser journey did not intercept chat/ledger/model responses. No real Gemini audio was used. The root ignored `.env` key and remaining settings were preserved without displaying secrets. The existing public HTTPS presentation remains on its prior verified build, with hosted text/audio disabled; it was not silently replaced by this private preview.

Phone-width and desktop captures at **360, 390 and 1280 CSS pixels** showed no horizontal document overflow. The Impeccable-guided conflict resolution retained existing layout/tokens, editable drafts and the two explicit post-import actions. The existing private drawer's return focus can land on the skip link; this work does not claim a full accessibility or physical-phone pass. Generated fixtures, browser captures, timing JSON and temporary migration overlay remain ignored under `test-results/multiformat-live/` and `.cache/`.

## Original agent verification

All six variants below pass **file selection → preview → confirmation → saved PostgreSQL transactions → Coach answer** in the existing **Import bank statements** view. Verification uses generated synthetic files, signed offline test-OIDC, the production Next.js BFF, the real Python API, and disposable PostgreSQL 17.6. No external bank or hosted model is called.

## Precisely tested variants

| Format | Accepted and tested variant | Evidence |
| --- | --- | --- |
| CSV | UTF-8 Wise header with `TransferWise ID,Date,Amount,Currency,Description`; `DD-MM-YYYY`, signed decimal EUR amounts; optional `IBAN` column | Full browser journey; existing legacy JSON CSV API tests also pass |
| PDF | English Wise `EUR statement`, dated period with timezone labels, IBAN, `Description Incoming Outgoing Amount`, amount plus running balance, and `date \| … \| Transaction: reference` detail rows | Local supplied layout accepted without printing records; same-structure synthetic full browser journey; wrapped-description unit case |
| XLSX | Single-sheet OOXML with the same Wise columns as CSV; inline/shared strings, text dates or numeric dates using Excel's 1900 epoch | Synthetic inline-string full browser journey; shared-string/numeric-date unit case |
| CAMT.053 XML | Namespace `camt.053.001.10`, one `Stmt`, EUR account, `BOOK` entries, one `TxDtls` per `Ntry`, booking date, CRDT/DBIT, transaction reference and remittance | Synthetic full browser journey |
| MT940 | One statement with `20`, `25`, `28C`, `60F`, paired `61`/`86`, and `62F`; EUR balances, booking date, signed debit/credit and bank reference | Synthetic full browser journey |
| QIF | `!Type:Bank`, terminated `D/T/P` records, optional `M/N/C`; ISO dates or explicitly selected day-first/month-first slash dates | Synthetic full browser journey with day-first dates and explicit account/EUR choice |

The format list and CAMT version are documented in [Wise's statement help](https://wise.com/help/articles/2736049/how-do-i-download-a-statement); Wise's API documents the [statement formats and COMPACT/FLAT options](https://docs.wise.com/api-reference/balance-statement/balancestatementget). The MT940 field boundary follows [SWIFT's Category 9 documentation](https://www2.swift.com/knowledgecentre/rest/v1/publications/us9m_20190719/2.0/us9m_20190719.pdf?logDownload=true). These sources establish the formats, not universal compatibility with every possible Wise export layout.

Only the PDF layout was available as a local real export for structural inspection. It was parsed locally without importing it, logging its records, sending it to a model, or copying it into Git. Other new export variants were tested with the exact synthetic structures above, not real Wise downloads. Fixtures are generated by `scripts/generate_wise_fixtures.py` into ignored test storage; no private files are required to run the suite.

## Behavior verified

- Select six file types through the native picker. Each preview shows account, currency, period, last available date, entry count, and sample dates/amounts. Up to ten files of 2 MiB each are bounded independently; encrypted preview storage and row count are also bounded.
- A mixed CSV/PDF/XLSX selection includes damaged, scanned and unknown PDFs. Each failure has a specific recovery message with CSV offered; removing bad files leaves the valid previews confirmable.
- Exports without an account key require an explicit existing imported account or new account choice. QIF additionally requires an explicit currency and, for slash dates, date order. File-provided identifiers never establish verified bank ownership or automatically link a live bank account.
- A complete batch publishes in one authorized database transaction under the existing owner-state lock. A later missing/foreign preview rolls the entire batch back. Expired previews, CSRF/session checks and owner RLS remain enforced.
- Complete-statement fingerprints include the selected/bound account, all reference/date/amount/description tuples and their occurrence counts. CSV followed later by PDF and XLSX adds no transactions; the same also holds within a mixed batch. Exact-byte repeats are owner-scoped and idempotent. Automatic cross-format matching requires nonempty references; QIF without those references falls back to ambiguity handling.
- A reference alone, date/amount pair, or partial multiset never collapses rows. A changed occurrence count causes an overlap conflict. The user can remove the overlapping file or explicitly keep all its entries as separate purchases. This is conservative whole-statement matching, not automatic partial-statement reconciliation.
- Two identical purchases with the same Wise reference remain two transactions. The canonical fixture has dates `2026-10-03`, `2026-10-03`, `2026-10-15` and amounts `-500`, `-500`, `1250` cents; saved records and Coach answers match those values.
- Multiple accounts can be viewed together or separately in history, Overview and Coach. Last statement dates appear in all three. If a format has no declared statement period, its available dates come from transaction dates; the UI explains this limitation.
- A second user cannot confirm the first user's preview/receipt or read their account. Their own history and Coach are empty before import, and identical source bytes can subsequently be imported independently. Separate API/database checks cover two users in the same tenant as well.

## Commands and results

From the repository root, with an isolated `MONEYLENS_TEST_DATABASE_URL`:

| Command | Result |
| --- | --- |
| `npm run build:web` | Passed |
| `python -m pytest -c backend/api/pyproject.toml tests/integration/test_wise_browser.py -s`, with `MONEYLENS_STATEMENT_BROWSER_TEST=true` | 7 browser tests passed inside 1 integration fixture; final database assertions passed |
| `python -m pytest -c backend/api/pyproject.toml tests/integration/test_statement_formats_flow.py tests/integration/test_wise_flow.py tests/integration/test_statement_staging.py -p no:cacheprovider` | 9 passed |
| `python -m pytest -c backend/api/pyproject.toml tests/api -p no:cacheprovider` | 848 passed |
| `npm run test:demo -- --reporter=line` | 15 passed, including existing S-Pankki organizer demo |
| `npm run test:web -- tests/browser/live-banking.spec.ts --grep Swedbank --workers=1 --reporter=line` | 1 passed with offline Swedbank transport; no real bank login claimed |
| `python scripts/check_contracts.py` | Published v1 baseline compatible |
| Web TypeScript build, strict standalone browser/config TypeScript check, `git diff --check` | Passed |

The integration fixture removes its unique databases and restricted roles. The disposable Docker container is stopped and removed after verification. Screenshots and traces remain ignored under `test-results/statement`. Existing pytest cache permission and dependency deprecation/serializer warnings do not invalidate the passing assertions. The explicit missing-database guard remains: a requested browser run must fail rather than silently skip.

## Variant boundaries and samples for expansion

Unknown layouts fail closed. To support additional variants, supply a layout-preserving synthetic or anonymized Wise export for the affected format:

- PDF in another language/layout, changed headings, split or multi-page transaction detail lines: the affected selectable-text EUR PDF. Scanned PDFs require CSV; OCR is not used.
- XLSX with title rows, multiple sheets, another date epoch, formulas or different column names: the affected `.xlsx` preserving sheet structure, header rows and cell types.
- CAMT with aggregated entries, multiple statements or a different namespace: the affected Wise version-10 `.xml` preserving all `Ntry/NtryDtls/TxDtls` and reference structures.
- MT940 with message wrappers, paged `60M/62M` statements, reversal/funds codes or alternative `86` conventions: the affected Wise `.mt940` file preserving tags and line wrapping.
- QIF with account headers, split records or a different date convention: the affected Wise `.qif` preserving control lines and date formatting.

Legacy CSV receipts without retained references cannot safely be matched to another format retroactively; they remain an explicit overlap decision. Live Wise connections remain blocked from uncertain statement linking. S-Pankki demo data and Swedbank connection implementation were left intact; no push was performed.
