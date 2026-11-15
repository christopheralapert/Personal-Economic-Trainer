# Self-service signup and six-format import integration

## Final integrated release — 14 November 2026

### Amount-limit guard integrated into the release branch

The actual integration HEAD before this follow-up was **`6dc1e0d`**, retaining **`f239923`** and the finished signup/UI history. Independent fix checkpoint **`c243dc1`** is on **`integration/release-signup-ui-next`**. The later handoff commit changes documentation only. **`experiment/nemotron-search-next` remains at `1ae60ad`**, unmerged and unchanged.

Commit `770caac` was inspected before integration: its three application-file changes are independent, but its modification to `test_search_provider_privacy.py` depends on the experimental `399cfe7` test and Nemotron probe, neither present on the release branch. Consequently this is a **focused port, not a cherry-pick**. Native-Gemini-only regressions replace that dependency. The small follow-up admission guard from `10ac0cf` is retained so unsupported filters cannot consume or be rejected by the model cooldown. The prefix `€20`, missed by the original predicate, is now covered as well. No experimental provider, adapter switch or research routes were added to the ordinary API. No migration or published contract changed.

**New production artifact:** `frontend/web/.next/amount-guard-33129`, **build `c243dc1-131377e695625033`**, running on **33129**, isolated API **18049**. It was built from the committed fix. Existing public worker/assets were not regenerated. Next's automatic temporary tsconfig includes were restored to the original content; that generated change is not part of the patch. The same build header was checked on all three handoff URLs:

1. Anonymous organizer demo: **http://127.0.0.1:33129/demo?dataset=organizer1**
2. Anonymous Learn: **http://127.0.0.1:33129/demo?dataset=organizer1&tab=learn**
3. Private test entry: **http://127.0.0.1:33129/banks**

At the private entry choose **Connect your bank → Isolated synthetic identity → model-review** for saved sample data, or **fresh-preview** for an empty workspace. No password or preexisting cookie is needed. These are RSA-signed local **test-OIDC** identities, not Auth0. Browser checks verified both entry paths in fresh 390 × 844 Chrome contexts and verified repeat login reuses the empty workspace. Sample data is prepared through real CSV/XML import and classification, not by the model fixture. The preview's private Coach date is deliberately fixed to 14 November 2026, so “last month” is October; the anonymous organizer dataset retains its own September anchor, so its previous month is August.

**Gemini/voice policy on 33129:** real Gemini text **OFF**, hosted Gemini audio **OFF**; `/api/voice/capabilities` reports `enabled=false`. Private model interpretation uses the existing native `gemini-3.5-flash` adapter with an explicitly **mocked HTTP transport**, no real key and no paid network calls. Its ordinary `source=model`, `provider=gemini-direct` test response is **not evidence of real Gemini availability**. The test chooser states this limitation. The fixture recognizes only the documented EN/FI/ET taxi sample questions; other non-private model questions clarify rather than simulating a general live model. Privacy mode stays local. The real application Gemini path is unchanged. The launcher does not read or edit `.env`, and strips inference/identity/database settings from the child Next environment.

#### Guard and regular-question evidence

`tests/browser/amount-guard.spec.ts` passed **3/3** on that production build. Its first test asks these exact questions with Privacy **off**, then repeats immediately after a model-test answer:

| Language | Unsupported request | Visible local explanation starts with |
| --- | --- | --- |
| ET | `Näita eelmise kuu üle 20 € taksosõite` | `Summapiiranguga otsingut veel ei toetata, seega otsingut ei tehtud.` |
| EN | `Show last month's taxi rides over EUR 20.` | `Amount filters are not supported yet, so no search was run.` |
| FI | `Näytä viime kuun yli 20 euron taksimatkat.` | `Summarajauksia ei vielä tueta, joten hakua ei tehty.` |

Each response has one localized clarification question, `source=rule`, no provider/usage, and **no card, habits or transaction rows**. The native model HTTP counter is unchanged. Database regressions also forbid ledger-tool execution and model admission for the limited request, both with Privacy on/off and immediately after a model answer. Thus an unfiltered result cannot be presented as the requested filtered search.

For the normal sample, sign into **model-review**, open **Coach**, choose **Eesti** and **Synthetic taxi A account**, and ask **`Kui palju kulutasin taksodele eelmisel kuul?`**. Expected recorded spending is **30,97 EUR for 2026-10-01–2026-10-31**, with two evidence rows. The browser compared exact saved row IDs/cents, account and both period boundaries, opened the underlying list and an actual transaction detail, then enabled Privacy and confirmed the same 3097-cent result with no further model request. Equivalent EN/FI questions passed. The three normal non-private questions made exactly **3 mocked-native-Gemini HTTP requests total**; all guard and Privacy requests made zero additional requests. No real provider call was made in this follow-up.

The anonymous FI demo separately returned **“Käytit takseihin elokuussa 2026 yhteensä 30,97 €.”**, opened the organizer transaction and showed all six Learn topics without a session cookie. The empty identity had zero accounts/ledger rows and an editable Coach, with no sample-data answer carried over.

#### Commands, results and retained services

| Command | Result in this follow-up |
| --- | --- |
| `node .cache/check-integrated-amount-guard.cjs` | **1008 passed**, full API plus guard, Coach, multilingual and private-Gemini PostgreSQL selections; model transport mocked |
| `.venv\Scripts\python.exe -m pytest -c backend/api/pyproject.toml tests/api/test_unsupported_search_amount.py -p no:cacheprovider` | **10 passed**, including the exact ET request, € suffix/prefix, date ranges, quoted merchant and 20% scenario non-regressions |
| `npm run typecheck`; `node node_modules/typescript/bin/tsc -p .cache/tsconfig.amount-guard.json` | Both workspaces and strict new browser/config types passed, including after production build |
| `node .cache/build-amount-guard.cjs` | Production web build passed; dedicated directory, no public-worker regeneration |
| `node .cache/seed-amount-guard.cjs` | **1 passed**, fresh signed test-OIDC signup → synthetic Wise CSV/CAMT XML → saved History/classification → local Coach, repeat/overlap/ownership checks |
| `node .cache/check-amount-guard.cjs` | **3 passed (19.9 s)**, fresh-browser guard/regular evidence, anonymous demo/Learn, empty-identity entry/repeat login |
| `npm run test:structure`; `.venv\Scripts\python.exe scripts/check_contracts.py` | **12 passed**, published-v1 compatibility passed |
| `.venv\Scripts\python.exe -m py_compile scripts/run_guard_preview.py`; Alembic `heads` | Syntax passed; unchanged single `0028_merge_identity_statements` head |

The first added €-prefix regression caught a missing case and was fixed before the checkpoint; the first browser-only typecheck caught an incorrect dictionary key and passed after correction. There were no failing final assertions. Four existing dependency/intentional-forged-value warnings did not fail the Python run. No `Hook failed` occurred.

The sample import confirmation → visible scoped History was **400 ms** in this run (three synthetic rows, 160-byte CSV + 539-byte XML). Local A/B/all questions were **71/62/57 ms**, exact **30,97/7,00/37,97 EUR**, with opened evidence. These are individual warm-artifact observations, not model-speed measurements; the Gemini transport in this follow-up is a mock. No physical-device speech or real Auth0 check was performed.

The new preview and its uniquely created PostgreSQL database are left running. Older 33125/33128 previews still returned their existing `68d4044-131377e695625033` artifact, and the presentation backend on 33110 still returned `0d49b43-131377e695625033`; none was stopped, rebuilt or redeployed. Public HTTPS, ngrok, model/audio settings, `.env`, the experimental branch and other worktrees remain untouched. **No push, PR or deployment.**

If this local preview stops, the retained-checkout launch sequence is:

```powershell
Set-Location <repository root>
docker start moneylens-coach-test-20261114
node .cache/build-amount-guard.cjs
node .cache/start-amount-guard.cjs
```

Leave that terminal open. In a second terminal, run `node .cache/seed-amount-guard.cjs` **once per fresh database**, then `node .cache/check-amount-guard.cjs`. The ignored convenience launchers and synthetic fixtures are retained in this checkout; no secret is embedded in them. Rebuilding after a documentation commit changes the source-prefix build ID. The committed launcher is `.venv\Scripts\python.exe scripts/run_guard_preview.py --test-only`: it requires a dedicated loopback `MONEYLENS_TEST_DATABASE_URL`, refuses occupied ports, creates/migrates its own disposable database and never reads live model keys. Its header-protected POST `http://127.0.0.1:18049/rehearsal/shutdown` stops only this owned fixture and cleans up only its created database/roles; do not stop the shared PostgreSQL container or old previews. The browser config accepts explicit `MONEYLENS_GUARD_ORIGIN=http://127.0.0.1:33129` and `MONEYLENS_GUARD_API=http://127.0.0.1:18049`.

### Follow-up: ordinary versus isolated-test configuration

The **same existing artifact**, build **`68d4044-131377e695625033`**, was started in two additional local configurations without rebuilding or changing the public presentation. `node .cache/check-deployment-modes.cjs` completed **2 browser tests passed** (3.0 s), with the committed `tests/config/playwright.deployment-modes.config.ts` and `tests/browser/deployment-modes.spec.ts`.

| Configuration | Runtime boundary and browser proof | Result |
| --- | --- | --- |
| Ordinary, http://127.0.0.1:33126, API 18046 | Production API settings; `MONEYLENS_ALLOW_DEMO=false`, self-signup false, no test issuer or test chooser. Anonymous organizer demo 200. Private Coach shows the signed-out prompt and no financial content; test-issuer/summary routes, demo login, session/login and accounts are unavailable (404). | Passed: no test authentication path is exposed. |
| Isolated signed test OIDC, http://127.0.0.1:33127, API 18047 | Fresh disposable PostgreSQL, explicit test issuer and signup enabled. Membership count stays **0** before callback, after invalid browser state (400), at the issuer chooser, and after an invalid RSA signature (401). A valid signed issuer/subject creates **1** membership; repeat login keeps **1**. An independent no-cookie API context stays unauthenticated (401). | Passed: workspace creation follows successful verification, never merely opening the chooser. |

Both configurations returned the identical `X-MoneyLens-Build`. Ordinary mode deliberately **does not pretend that Auth0 is configured**: the existing root `.env` has no OIDC issuer/client settings and API authentication is disabled there. Its private routes fail closed; a successful ordinary real-Auth0 login remains unverified and needs the real issuer/client/endpoints and restricted database settings. The local `.env` is unchanged; the normal-mode launcher overrides development/demo switches in its process only. The public frontend synthetic demo is independent of the API's synthetic-session-login flag.

Retained local launch commands: `node .cache/start-normal-release.cjs` and `node .cache/start-config-test.cjs`; the latter must have a fresh database for the zero-member test. To rerun, stop only that owned test fixture with POST `http://127.0.0.1:18047/rehearsal/shutdown`, start it again, then run `node .cache/check-deployment-modes.cjs`. Existing main preview on 33125 stays running. The normal configuration has **no rehearsal routes**, including shutdown. No public deployment or push occurred.

Branch: **`integration/release-signup-ui-next`**. Integration checkpoint **`68d4044`** merges finished signup **`003f115`** with **`8ac89b7`**, including its ancestor **`53b119c`**. Voice **`bb02609`** was already an ancestor; it was not reapplied. Verification checkpoint **`e12e6f9`** adds recovery, scope, browser compatibility, exact preview metadata and provenance tests. Subsequent handoff changes are documentation only; `git log -1 --oneline` identifies that final documentation commit.

**Running production artifact:** `frontend/web/.next/release-final-20261114`, **build `68d4044-131377e695625033`**. Both application production builds passed. The artifact's source is the integration checkpoint; later test/report commits do not change application code. All final routes below returned HTTP 200 with that exact build header.

### Preview and sign-in

- Anonymous demo: **http://127.0.0.1:33125/demo?dataset=organizer1**
- All six Learn lessons: **http://127.0.0.1:33125/demo?dataset=organizer1&tab=learn**
- Private entry: **http://127.0.0.1:33125/banks**; choose **Connect your bank**, then a link on **Isolated synthetic identity**. There is no password. This is a loopback-only, RSA-signed **test OIDC issuer, not Auth0 or a real bank**.
- Choose **model-review** for the saved two-account taxi example; choose **other-owner** for an independent member; choose **fresh-preview** for an empty workspace. The normal entry was checked in a completely fresh 390 × 844 browser context using only these steps; fresh-preview had zero accounts. Private Coach: **http://127.0.0.1:33125/coach**; private Learn: **http://127.0.0.1:33125/learn**.
- On model-review, choose Suomi and ask **Paljonko käytin takseihin lokakuussa 2026?** Select account A, B or all accounts. Privacy mode defaults on; disable **Yksityisyystila** only to opt into a paid private Gemini text request. Expected amounts are **30,97 / 7,00 / 37,97 EUR** for October 2026. **Alustapahtumat** opens evidence; a row opens transaction details.

The final preview has **private Gemini text enabled**, model **`gemini-3.5-flash`**. Its **public demo Gemini text and all hosted Gemini audio are disabled**; `/api/voice/capabilities` returned `enabled=false`. Device/browser speech remains capability-gated. Existing public HTTPS presentation, ngrok and ports 33110/33118/33119 were not restarted or redeployed. Read-only header checks still found 33110/33119 on `0d49b43-131377e695625033`, and 33118 on `32c5877-131377e695625033`. The public HTTPS link is not this new build.

The final preview/API and their uniquely created PostgreSQL database are left running on loopback ports **33125/18045**. They use the existing dedicated test PostgreSQL container on 55440, not a development or presentation database. The root ignored `.env` was read by the launcher and not edited; all four expected setting names were present, including `GEMINI_API_KEY`. The key remains only in the API process, not the Next process. Runtime public-demo flags override the root's separate 33119 allowlist without changing that file.

If the preview has stopped, this **local-checkout-only PowerShell sequence** starts a fresh isolated rehearsal. Do not run it while 33125/18045 are occupied; it refuses occupied ports. The ignored launchers/artifact are retained locally, not committed:

```powershell
Set-Location <repository root>
docker start moneylens-coach-test-20261114
node .cache/build-release-final.cjs
node .cache/start-release-final.cjs --live-gemini
```

Leave that terminal open. In a second terminal, `node .cache/check-release-final-signup.cjs` seeds the fresh model-review/other-owner scenario from the retained synthetic fixtures. A restart creates a new empty test database; it does not recover the old disposable fixture database. To stop only this rehearsal cleanly, POST `http://127.0.0.1:18045/rehearsal/shutdown`; its own database/roles are removed. No other container, listener or database is stopped. A rebuild after a later documentation commit naturally has a new source-prefix build ID.

### Migration, signup, recovery and data isolation

Actual single head: **`0028_merge_identity_statements`**, parents **`0027_statement_file_provenance` + `0025_identity_self_signup`**. The two statement 0025 branches join at 0026 before 0027. Repeated filename prefixes are not duplicate revision IDs. No published migration was renamed or rewritten.

The final selected API/database run passed **1083 tests** using disposable PostgreSQL. It includes fresh installation, upgrades from all five relevant prior branches, and a populated pre-signup 0027 schema upgraded twice. Exact cents, transaction IDs, account IDs/ownership, receipts, data versions, user-state IDs and existing issuer/subject membership mappings were unchanged. The older populated-0024 replay regression also passed. Repeated/concurrent verified signup and a simultaneous administrator invitation reuse one workspace; invalid identities and existing blocked members remain denied. Restricted identity/runtime privileges and whole-workspace/session rollback passed.

Two fresh automatic-signup identities completed the 390 × 844 CSV + XML two-account journey. Saved rows are −1500/−1597 cents on A and −700 on B. UI classification is explicitly reviewed before taxi-spending questions. History, Overview/category evidence and local Coach agree at A=3097, B=700, both=3797 cents, with the same October period. The second member cannot read the first account or confirm its receipt; it can import the same synthetic bytes into its own workspace independently. Saved financial rows are read from the shared ledger, not reparsed from a file on each question.

The recovery browser case modifies one outbound confirmation to append a nonexistent preview, **without mocking the API response**. The real API rejects it, no rows/accounts are added, and the UI says nothing in the batch was imported and gives recovery steps. Retrying the valid preview, double-clicking Confirm and concurrently sending the same real command leaves exactly two new purchases, not four. A separate PostgreSQL fault injection raises **after inserting the second file**: both files' rows, accounts and receipts roll back, both previews remain retryable, the retry saves six rows once and an exact repeat adds zero.

Same-tab A → Sign out → browser Back → B sign-in → Back/reload → old A account URL passed. Prior transaction/Coach/preview DOM is cleared, and foreign account, staged preview and Coach selection return **404/404/404**. B's own saved rows and Coach remain separate. This supplements the fresh-context and same-tenant RLS checks; it is not inferred from a successful build.

### Precisely exercised file variants and limits

All six rows below passed **native file selection → preview → account/currency/date/count checks → confirmation → persisted History after reload → private Coach → exact repeat** in the seven-case PostgreSQL-backed browser fixture. It uses signed test OIDC with eight explicitly provisioned test memberships and **no model**, not real Auth0. Automatic signup is independently exercised on the same build by the two-account and cross-browser journeys. Each standard format fixture has three rows: two identical-reference, same-date, −500-cent purchases plus a +1250-cent entry; all three survive and the signed total is +250 cents.

| Format | Exact browser-tested synthetic variant | Limits / exclusions |
| --- | --- | --- |
| Wise CSV | UTF-8 `TransferWise ID,Date,Amount,Currency,Description`; DD-MM-YYYY, signed decimal EUR | Explicit destination account without a source account key; optional IBAN also unit-tested |
| Wise PDF | English selectable-text EUR statement, timezone-labelled period, IBAN, recognized incoming/outgoing/amount columns, running balance and transaction-reference detail | No OCR; scans, encrypted files, unknown or damaged layouts fail closed with CSV recovery |
| Wise XLSX | One OOXML worksheet, Wise CSV columns, inline-string cells and text dates | Shared strings/Excel-1900 numeric dates additionally unit-tested; not browser proof for other workbook layouts |
| CAMT.053 XML | `camt.053.001.10`, one EUR `Stmt`, `BOOK`, one `TxDtls` per `Ntry`, CRDT/DBIT and remittance/reference | Not an assertion of other namespaces, aggregated entries or multi-statement compatibility |
| MT940 | One EUR statement, tags 20/25/28C/60F, 61 with 86, 62F and bank references | Message wrappers, paged statements and alternative tag-86 layouts need samples |
| Bank QIF | `!Type:Bank`, D/T/P records terminated by `^`, explicit day-first slash dates and explicit destination/EUR choice | ISO/month-first and optional M/N/C additionally unit-tested; splits/account headers need samples |
| Canonical EUR CSV | `reference,booked_on,amount_minor,currency,description`, ISO dates, exact integer cents | Browser-tested separately in both engines at both viewports; two distinct same-date/amount/reference purchases retained |

Picker: **up to 10 files, 2 MiB each, 1–1000 normalized rows per file**; encrypted normalized payload is bounded to 500,000 bytes. Canonical CSV additionally has a **64 KiB** source limit. Browser fixtures prove the specified small variants, not every export/maximum-size combination. API scale tests cover 700 and 1000 CSV rows. CSV/XLSX/QIF use available transaction dates when no statement period is present; PDF/XML/MT940 fixtures declare October 1–31. QIF requires a user-confirmed EUR choice when currency is absent.

Mixed selection included valid CSV/PDF/XLSX plus scanned/unknown/broken PDFs; removing invalid files left valid previews usable. Complete CSV↔PDF/XLSX statement matching added zero rows, preserving tuple multiplicity. Exact re-import adds zero; a partially overlapping same-account statement is rejected for review, not silently merged. Removing it preserves the existing three rows. Explicit separate-purchase handling is covered in PostgreSQL. Unknown export variants require a layout-preserving **synthetic** sample as listed in [the detailed boundaries](wise-statement-review.md#variant-boundaries-and-samples-for-expansion); no such sample blocks the six variants above.

### Gemini, Privacy, speech and measured timings

**Exactly one real paid Gemini text request in this release round** passed through the ordinary private Coach after the imported two-account fixture. It returned HTTP 200, **`source=model`, `provider=gemini-direct`**, no fallback diagnostic, exact **3797 cents**, and the visible Finnish sentence **“Kirjattu nettokulutus oli 37,97 EUR ajalta 2026-10-01–2026-10-31.”** All three matching evidence rows and an actual transaction detail opened. A rule fallback would fail this test. No EACCES occurred in this request. `tests/browser/release-gemini.spec.ts` is opt-in and does not silently accept fallback.

The model interprets the bounded question/selectors; account ownership/scope and arithmetic stay on the authenticated server. The transport tests reject identifiers/arbitrary row-bearing context and prove selected account IDs do not enter model input. No statement files, raw ledger rows, account IDs or secrets were printed by the live-check diagnostics. Privacy replies have `source=rule`, no provider, zero/absent model usage and model timing 0; the multilingual database matrix forbids any provider call and checks missing-data/clarification behavior.

| Observation on build `68d4044-131377e695625033` | Fixture / transport | Time |
| --- | --- | ---: |
| Confirm → first visible scoped History, including View transactions click | 3 rows across Wise CSV (160 bytes) + XML (539 bytes), fresh two-owner Chrome mobile journey | **364 ms** |
| Question → visible answer, A / B / both | Same reviewed ledger, Privacy/local rules | **81 / 78 / 70 ms** |
| Question → visible answer, both accounts | Same ledger, **real Gemini text** | **1635 ms** |
| Reported server time for that real answer | Model wait / application / total | **1556.6 / 40.8 / 1597.4 ms** |
| Confirm → visible History, Chromium mobile / desktop | 2-row canonical CSV, fresh signed test members | **338 / 251 ms** |
| Confirm → visible History, WebKit mobile / desktop | Equivalent 2-row canonical CSV, fresh signed test members | **655 / 647 ms** |

These are individual observations while regression services were active, **not controlled cold/warm comparisons, percentiles or a speedup claim**. Model wait includes Google's processing and network time; the app does not separate those further. The historical 700-row cold/warm measurements remain in [the performance report](import-coach-review.md#current-integrated-follow-up-from-f70f933--14-november-2026); that benchmark was not rerun in this release round. Its sign-in locator was updated for the redesigned entry.

The 74 main voice browser cases passed with **mocked recognition, synthesis, microphone, playback and hosted audio**: editable dictation, no auto-send/read-aloud, explicit stoppable playback, denial, unavailable local speech, cancellation and Privacy overrides. They do not prove a physical microphone, iPhone language pack, acoustic quality or live Gemini audio. EN/FI/ET ordinary demo answers and Finnish August 2026 **30,97 €** evidence passed separately with local rules/test transport.

### Final command results and compatibility

| Command / test selection | Result |
| --- | --- |
| `node .cache/build-release-final.cjs`; `npm run build:coach` | Both production builds passed; root public worker/assets were not regenerated, preserving the running presentation |
| `npm run typecheck`; `node node_modules/typescript/bin/tsc -p .cache/tsconfig.release-tests.json` | Both workspaces and new browser/config types passed |
| `npm test` | **171 Vitest + 15 Node AI/PWA tests passed** after sandbox retry |
| `npm run test:structure`; `npm run test:worker`; `python scripts/check_contracts.py` | **12 + 54 passed**, published-v1 contracts compatible |
| `python -m alembic -c backend/db/alembic.ini heads` | One head: `0028_merge_identity_statements` |
| `node .cache/check-release-final-integration.cjs tests/api tests/integration/test_self_signup.py tests/integration/test_identity.py tests/integration/test_invited_members.py tests/integration/test_membership_fence.py tests/integration/test_statement_branch_upgrade.py tests/integration/test_statement_migration.py tests/integration/test_statement_formats_flow.py tests/integration/test_wise_flow.py tests/integration/test_statement_staging.py tests/integration/test_statement_publication.py tests/integration/test_coach_query.py tests/integration/test_coach_languages.py` | **1083 passed**, final run 60.65 s |
| `node .cache/check-release-final-integration.cjs tests/integration/test_statement_formats_flow.py tests/integration/test_statement_publication.py tests/integration/test_wise_browser.py` | **26 passed**, including seven real six-format/mixed browser cases inside one integration fixture |
| `node .cache/check-release-regression.cjs` | **103 passed, 7 opt-in statement cases skipped**; those seven passed in their own PostgreSQL fixture above |
| `npx playwright test --config frontend/coach/playwright.config.ts --reporter=line` | **49 passed, 2 live-provider opt-ins skipped**; standalone PWA cold-offline/update browser checks included |
| `node .cache/check-release-final-signup.cjs` | **1 passed**, fresh automatic-signup two-owner production journey, local rules |
| `node .cache/check-release-additional.cjs --project=chromium-mobile --project=chromium-desktop --project=webkit-mobile --project=webkit-desktop` | **8 passed** on fresh per-project members; requires a fresh rehearsal for rerun |
| `node .cache/check-release-additional.cjs --project=recovery`; same with `--project=scope` | **1 + 1 passed**, real DB/API and local rules |
| `node .cache/check-release-additional.cjs --project=real-gemini --live` | **1 passed**, the single real Gemini request above |
| `node .cache/check-release-preview.cjs`; `node .cache/check-release-pwa.cjs` | Fresh handoff entry/headers passed; actual main worker controlled Chrome, five public cache entries, **zero private entries**, offline cleared private DOM, private navigation stayed network-only, public `/` served public learning fallback |

The `.cache` commands are retained local helpers, not portable dependencies or committed artifacts. The committed browser entry is `npx playwright test --config tests/config/playwright.release.config.ts`, with `MONEYLENS_RELEASE_ORIGIN` set to a fresh loopback rehearsal. Real inference additionally requires `MONEYLENS_RELEASE_LIVE_GEMINI=true`; run the signup fixture first to create/review its expected rows. Do not run these fresh-owner fixtures against an ordinary user's database, nor launch multiple pytest runs sharing one `--basetemp` concurrently.

Compatibility: **Chromium via installed Google Chrome**, and **Playwright WebKit 27.2 (build 2370)**, each **390 × 844 and 1280 × 900**. All four combinations passed anonymous FI demo/evidence and fresh-signup canonical import → reload History → private Coach/detail. This is desktop/emulated WebKit, **not real iPhone Safari/audio**. The batched Chrome design/a11y sweep additionally covered 390/1280 × 844, light/dark, all four demo tabs and expanded Learn, with zero tested axe WCAG A/AA violations. Screenshots were reviewed without replacing the approved design; no horizontal document overflow was observed. This is not a complete accessibility certification or human financial-literacy study.

Initial new-test failures were corrected rather than hidden: Back can land on the test-issuer document, the redesigned positive-spending Overview uses category evidence rather than the empty/unresolved-history link, local usage receipts can be null, and English private answers use a decimal point. The main PWA intentionally does not serve private `/coach` offline; public home fallback was checked separately after the deliberately failed private navigation. The corrected affected checks passed. No application security rule was relaxed to satisfy a test.

`npm test` initially failed because sandboxed esbuild could not read its configuration/ancestor directory; rerunning the same suite using approved non-sandbox CMD passed. Existing Starlette deprecation and intentional forged-value serializer warnings did not fail assertions. No repeated `Hook failed` occurred in this round's test/build/commit output, so no check is attributed to that earlier warning; its historical external-hook cause was not re-established here. `git ls-files '*AGENTS.md'` confirms the tracked guide is `frontend/web/AGENTS.md`; there is no tracked root guide. The local `.agents/AGENTS.md` was also read and preserved.

### Challenge and acceptance evidence

The **full challenge text supplied by the user in this conversation** is the official-requirement reference for this audit. The attached organizer ZIP's README is a dataset/download guide, not a complete challenge brief. The requirements below distinguish that supplied brief, its optional bonuses and our separately agreed product acceptance criteria; company-size/market-position claims are not functional acceptance tests or independently reverified here.

Organizer provenance is documented, not guessed from the UI: the ZIP's `tx_junction_transactions.csv` is a **Git LFS pointer**, not the 346 MiB data itself. Its OID **`49b3265d8e44e751de305a074dcffcda732bb79aa1e07b46fcca774ce76f1e63`**, size **362796501**, match `scripts/import_junction_demo.py`'s enforced source hash and `frontend/coach/data/organizer-source.json`. `scripts/build_organizer_data.py` builds deterministic whole-customer profiles; `frontend/coach/src/engine/datasets.ts` maps organizer1 to `organizer-1.v1.json`. The manifest and actual profile agree on **1543 rows**. The August taxi row is **2026-08-26, −3097 cents**, opened in both browser engines. The provenance regression checks this relation. The raw 346 MiB source was **not downloaded/rehashed in this round**; this is the documented source/pointer/importer/manifest relationship plus browser proof, not a new full-file byte audit.

| Nõue | Kus seda kasutaja näeb | Kontroll ja tõend | Seis |
| --- | --- | --- | --- |
| Ametlik: vestlus oma finantsandmetega, vabatekst | Demo Coach ja autentitud Coach pärast importi | EN/FI/ET `public-coach.spec.ts`; `organizer-demo.spec.ts`; üks päris private Gemini kontroll, serveri arvutused ja tõend | Tõendatud |
| Ametlik: korraldaja suur sünteetiline andmestik | Avalik organizer1 demo ilma sisselogimiseta | LFS OID → kontrollitud impordiskript → manifest → 1543-realine profiil; `organizer-provenance.test.mjs`; anonüümsed Chromium/WebKit teekonnad | Tõendatud |
| Ametlik: taksokulu eelmisel kuul | Soomekeelne demo vastus ja tehing | August 2026, 30,97 €, 26.08 tehing avanes; `public-coach.spec.ts` ja `release-compatibility.spec.ts` | Tõendatud |
| Ametlik: kulutajaprofiil ja arusaadav selgitus | Demo Coachi profiiliküsimus, kategooriad/tõendid | `organizer-demo.spec.ts`; standalone `baskets.spec.ts` profiilitõend, mitte väljamõeldud isikuskoor | Tõendatud |
| Ametlik: kolm kulukorvi ja pedagoogiline nurk | Overview korvid ja Learn | `demo-rehearsal.spec.ts`, `learn.spec.ts`: kõik kuus EN/FI/ET õppetükki, praktiline samm, perioodiga tehingud | Tõendatud |
| Ametlik: „mis siis kui” 20% restoranikulu vähendus | Demo What if ja vestluse stsenaarium | `demo-presentation.spec.ts`: 159,58 €; muudetavad valikud ja õige periood; EN/FI/ET andmebaasimaatriks | Tõendatud |
| Ametlik: kulutamis-/säästmisruum ja puudulike andmete aus selgitus | Demo Why; private Coach/plaani ülevaatus | `saving.spec.ts`, `test_coach_languages.py`: puuduva katvuse/reservidega ei lubata väljamõeldud summat; täieliku päris pangapildi nõustamist ei testitud | Osaliselt tõendatud |
| Ametlik MyData: kasutaja valib küsimuse, perioodi ja andmed | Konto-/perioodivalikud, vabatekst ja alustehingud | `release-scope.spec.ts`, demo perioodi-/filtrite brauseritestid; A/B/kokku täpsed summad | Tõendatud |
| Ametlik soovitus: mobiili sobiv veeb | Kõik põhitabid ja privaatne import | Chromium/WebKit 390 × 844, lisaks töölaud; failivalik → salvestatud ajalugu → Coach | Tõendatud |
| Ametlik boonus: rahvastiku avatud andmete võrdlus | Võrdluste/reference UI | Viite-/kohorditestid olemas, kuid selle ringi päris avatud-rahvastikuandmete võrdluse brauseriteekond puudub; sünteetiline kohort ei ole rahvastikustatistika | Osaliselt tõendatud |
| Ametlik boonus: päris PSD2 mitme panga ühendus | Pangaliidese ühendus | Eraldi failikontode koondamine ei tõenda PSD2-d; päris provideri volitus/mandaadid puuduvad selles isolatsioonis | Blokeeritud |
| Meie nõue: automaatne privaatne signup ning korduv/samaaegne login | Tavaline Connect your bank → test-issuer → privaatne tööruum | Fresh-browser signup; `test_self_signup.py`: sama issuer+sub, samaaegsus, blokeeritud liikme keeld ja RLS | Tõendatud |
| Meie nõue: päris Auth0 sisselogimine | Sama OIDC sisenemistee päris konfiguratsiooniga | Kasutati allkirjastatud test-OIDC-d; päris Auth0 tenant/client/endpoints ei olnud selle kontrolli teenus | Blokeeritud |
| Meie nõue: Wise CSV | Import, History, Coach | Täpne ülaltoodud UTF-8 Wise ekspordivariant, `wise-statement.spec.ts` | Tõendatud |
| Meie nõue: Wise tekstikihiga PDF | Import, History, Coach | Täpne ülaltoodud ingliskeelne PDF; skanni keeld, `wise-statement.spec.ts` | Tõendatud |
| Meie nõue: Wise XLSX | Import, History, Coach | Üks OOXML leht/inline-string/text-date variant, `wise-statement.spec.ts` | Tõendatud |
| Meie nõue: CAMT.053 XML | Import, History, Coach | v10, üks statement/TxDtls variant, `wise-statement.spec.ts` | Tõendatud |
| Meie nõue: MT940 | Import, History, Coach | Üks EUR statement, täpsed ülaltoodud tagid, `wise-statement.spec.ts` | Tõendatud |
| Meie nõue: Bank QIF | Import, History, Coach | Bank D/T/P, day-first ja kasutaja EUR/konto valik, `wise-statement.spec.ts` | Tõendatud |
| Meie nõue: kanooniline EUR-sentide CSV | Sama failivalija | `release-compatibility.spec.ts`, kaks brauserit ja kaks laiust; täpsed sendid | Tõendatud |
| Meie nõue: mitme faili/konto koondamine, mitte päris PSD2 | Failide eelvaated, konto valik, History/Overview/Coach | Vigase faili eemaldamine, kordused 0, sama kuupäeva/summa ostud säilivad; A/B/kokku `release-scope.spec.ts` | Tõendatud |
| Meie nõue: atomaarne taastamine ja samaaegne Confirm | Impordi veateade ja kordus | `release-recovery.spec.ts`; teise faili lisamise järel DB-rike `test_statement_formats_flow.py`; topeltkirjeid 0 | Tõendatud |
| Meie nõue: kontovahetus/Back/reload ei leki | Sama tabi sign-out → teine kasutaja → vanad lingid | `release-recovery.spec.ts`, võõra konto/eelvaate/Coachi 404; värske konteksti juhis läbitud | Tõendatud |
| Meie nõue: päris Gemini ning privaatsusrežiimi lokaalne vastus | Autentitud Coach | `release-gemini.spec.ts` päris 37,97 €; `release-scope.spec.ts` rule/no-provider; andmebaasitest keelab Privacy puhul mudelikõne | Tõendatud |
| Meie nõue: mikrofoni/etteloetava vastuse juhtimine | Demo Coachi heli nupud | 74 mock-brauseritesti, katkestamine ja veateated; päris seadme heli pole tõendatud | Osaliselt tõendatud |
| Meie nõue: füüsilise iPhone'i/device ja Gemini heli | Telefoni brauser | WebKit on emuleeritud, mikrofon/heli mock; avalik hosted-audio lüliti jäeti välja | Tegemata |
| Meie nõue: PWA ei salvesta privaatseid andmeid | Offline-olek ja avalik õppevaruvaade | 54 worker-testi, päris Chrome worker/cache/offline kontroll ning standalone cold-offline/update testid; füüsilist installi ei tehtud | Tõendatud |
| Meie nõue: kohalikud commit'id, saladuste/teiste töökoopia muutuste säilimine, ei push'i | Git ja kohalik eelvaade | 68d4044 + e12e6f9; allikate dirty-status säilis; ainult etapi failid indeksis, `.env`/logid/artefaktid välistatud | Tõendatud |

**Remaining evidence limits / smallest next steps:** core synthetic signup → import → History → Coach has no blocked check. For a complete real-provider release, configure and authorize the real Auth0 tenant/client and repeat the normal sign-in test; obtain a separately authorized PSD2 sandbox/production connection for the optional bank bonus. A physical iPhone needs the existing HTTPS/device-speech test first; deploying this new build or enabling hosted audio requires the user's later publication decision and was not done. Live budget/saving recommendations require a complete, fresh balance/reserve/bill picture; the private incomplete-data path correctly requests review rather than inventing certainty. Financial-literacy improvement, real-bank end-to-end behavior and physical-phone audio are not established by these synthetic tests. Unknown export variants need the specific synthetic sample, not a real customer's file.

No push, force-push, PR, Sync/Publish action or deployment was performed. Generated fixtures, timing output, screenshots, logs, ephemeral database settings and local launchers remain ignored. The source signup/design worktrees and local secrets were left intact.

## Historical signup-only verification (`003f115`)

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
