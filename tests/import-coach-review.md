# Saved import and private Coach verification

## Supported statement uploads

Both adapters normalize once into the same encrypted, session-bound preview and publish into the shared owned transaction ledger. The file is not parsed by History, Overview or Coach. Confirmation consumes validated staged values. Each saved row links its account, owner and receipt; all monetary values are exact integer minor units.

- **Wise EUR CSV:** UTF-8, optional BOM; required columns `TransferWise ID,Date,Amount,Currency,Description`; `DD-MM-YYYY` dates and signed dot-decimal EUR amounts with at most two fraction digits. Additional Wise columns are allowed within parser bounds.
- **Canonical EUR CSV:** UTF-8, optional BOM; exactly `reference,booked_on,amount_minor,currency,description` (column order may vary); ISO dates and signed integer EUR cents.
- Upload limits: **64 KiB, 1–1,000 transaction rows**, EUR only, descriptions/references at most 200 characters, amounts within ±9,007,199,254,740,991 cents. Preview dates are observed transaction dates, not certified whole-statement coverage. Account identity remains unverified.
- PDF, XLS/XLSX and arbitrary bank CSV layouts are **not** supported for publication. LHV's separated candidate-row validator and PDF text extraction remain offline utilities, not an upload promise.

Preview shows the account label, observed period, currency, count, repeated-reference warning and overlap result. Unsafe overlaps return 409 without publication. Re-importing equivalent normalized contents, including canonical/Wise conversion, row ordering, BOM or line-ending differences, reuses the receipt. Distinct row occurrences remain distinct even with identical references and amounts. Confirmation is atomic and idempotent; existing owner classifications survive repeats.

## Separate inference boundaries

The public main-web `/demo` uses Next.js `/api/chat`; private `/coach` uses the authenticated Python `/v1/coach/query` through the BFF. The private native adapter is pinned to **`gemini-3.5-flash`**. The model sees the question and closed validated selector context, never bank files, ledger rows or account identifiers. UUID/IBAN-containing questions are clarified before network access. Caller account selection, owner scope, source access and calculations remain in existing server tools.

Only a successful model interpretation reports `source=model`, `provider=gemini-direct`. Local Privacy mode reports `source=rule`, without a provider or model traffic. Stable fallback diagnostics and `Server-Timing` survive the BFF; a rule response does not count as a real Gemini pass. Native function selection follows [Google's function-calling contract](https://ai.google.dev/api/generate-content).

## Regression and browser evidence

Coordinated implementation includes import agent `6517ac6`, Coach agent `71db964`, and prior statement regression `87581cb`. The combined database run passed **36 tests**, including native Gemini injected transport, owner isolation, reviewed bank/CSV equality and exact **700-cent** added-account delta. Model transports in these regressions are injected; they are not live Gemini evidence.

The tested production source is **`ba9cf32`**, branch **`integration/import-coach-next`**, build **`ba9cf32-131377e695625033`**. Production build, both workspace typechecks and published-v1 contract compatibility passed. The API suite passed **954 tests**; Coach unit/transport/PWA tests passed **169 + 15**; main service-worker privacy/offline policy tests passed **54**; structure tests passed **9**. The main production browser suites passed **15 demo**, **5 public Coach** and **33 voice** cases. Voice APIs, microphone and playback in the voice suite are mocked. The signed-OIDC Wise persistence/overlap/PDF/owner-isolation browser regression passed against real BFF/API/PostgreSQL.

The separate signup worktree remains uncommitted and untouched; its `0025` identity migration needs reconciliation with the statement-provenance migration when that work is integrated later.

The **full combined database integration rerun passed 439 tests, with 31 opt-in service/browser checks skipped** (266.61 s). Its first broad pass found a stale 39-table expectation and two tests attempting prohibited schema downgrades. The RLS inventory now explicitly includes both statement-owned tables and still inspects every owned table/foreign key. Historical goal migration starts at revision 0012 in a fresh uniquely named database and upgrades forward; a separate scratch-schema test confirms the current head and verifies unsafe downgrade refusal without changing it. Retention protections in production migrations were not weakened. The corrected database/goal subset passed 30 tests before the full green rerun. The required Wise browser check was separately opted in and passed; skipped service/browser gates are not claimed as verified.

## Two real Gemini browser checks

Exactly two live model requests were made for this task after the injected-transport regressions passed. Both used **`gemini-3.5-flash`**, returned HTTP 200, `source=model`, `provider=gemini-direct`, and opened the actual underlying transaction evidence. Rules-only responses were checked separately and were not counted as model passes.

1. **Public synthetic main web:** `http://127.0.0.1:33119/demo?dataset=organizer1`, Settings → Suomi, Privacy mode off, **Paljonko käytin takseihin viime kuussa?** Visible response: **Käytit takseihin elokuussa 2026 yhteensä 30,97 €.** Evidence opened **MRC-TRN-0063**, 26.8.2026, −30,97 €. Question-to-visible-sentence time: **1,508 ms**. A second question with Privacy enabled returned `source=rule`, `evaluation=privacy_rule`, with no provider.
2. **Authenticated private Coach after CSV import:** `http://127.0.0.1:33120/banks`, choose the **model-review** identity on the clearly labelled isolated test-issuer page. The normal file picker imported two synthetic Wise rows, −15.00 and −15.97 EUR, sharing one provider reference. Confirmation saved both; History opened them and the normal classification sheet explicitly reviewed each as taxi/everyday expense. Re-import reused the receipt and retained those reviews. **Ask Coach** opened `/coach` with the saved account and observed period; Suomi + Privacy off + **Paljonko käytin takseihin lokakuussa 2026?** returned **Kirjattu nettokulutus oli 30,97 EUR ajalta 2026-10-01–2026-10-31.** The card's actual ledger total was **3,097 cents**, exactly the reviewed saved rows. The evidence drawer listed both rows and opened the transaction detail sheet. Visible response took **1,801 ms**: `Server-Timing` reported **1,699.6 ms model wait**, **52.6 ms application work**, **1,752.1 ms server total**. No browser page errors.

The private journey uses a signed offline OIDC test issuer with nonce, PKCE and real provisioned test memberships, plus the actual session/CSRF/ownership/RLS path and real Google inference. **It does not prove real Auth0 availability**, and the isolated test database is not the user's development database. The running preview provides a usable loopback test link while its launcher stays running. Root `.env` was loaded by the launchers; the existing key and other settings were preserved without displaying credentials. Public/private inference run in different processes: Next.js on 33119 and Python API on 18040 behind the 33120 BFF. No real-call `EACCES` occurred in this round; those processes were started through approved external Command Prompt, not the network-restricted sandbox.

Local browser probes exercised the import/Coach/evidence journey at **360, 390 and 1280 CSS pixels**, plus 200% root text at 360, with no horizontal document overflow. This is desktop Chrome at phone widths, not physical-phone, microphone or acoustic playback proof. The Impeccable review preserved the established surface while adding explicit format/limit copy, progress states, visible language/account/privacy controls, and the two direct post-import actions.

The public presentation remains **`https://trophy-ranged-precook.ngrok-free.dev/demo?dataset=organizer1`**, build **`2fc4c66-131377e695625033`**, Gemini/hosted voice disabled, browser/device voice selected. It was deliberately not replaced by the local private preview. Ngrok, the 33110 presentation listener and the 33118 demo were left untouched. The actual HTTPS page still returned HTTP 200 with its original build header after local checks.

## Timing method

Chrome at 390×844, loopback BFF/API and a dedicated PostgreSQL 17.6 container; synthetic Wise files contain **10 rows / 439 bytes** and **700 rows / 28,639 bytes**. Timers start at the UI action and wait for the corresponding visible result, not merely HTTP completion. Confirmation-to-first-rows includes clicking **View transactions** and loading the first ledger rows. Repeat-import timing is the same normalized receipt returned without new rows; it is not a second publication.

Each cold file-size result is the first import journey after restarting the isolated API and web process, with a fresh database and browser context. Warm results use a new synthetic owner/browser context after those requests in the same process; this deliberately warms server/runtime paths without reusing a published receipt. These are local observations, not statistical benchmarks or physical-phone timings. No artificial throttling or provider-response fixtures are used in the timing journey.

Original 700-row publication used per-row inserts. Measured UI confirmation was 413–537 ms in an initial mixed-size pass, then 563/490 ms in a dedicated cold/warm 700-row process run. The revised publisher uses one atomic `jsonb_to_recordset` insert. `Server-Timing` separates application work from model request wait (network plus Google's processing); it cannot isolate Google's internal inference from internet latency.

## Before/after results (milliseconds)

| Rows | Source | Process state | Preview visible | Confirmation complete | Confirmation → first visible ledger rows | Local question → visible rows | Exact repeat import |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 10 | Before | Cold | 60 | 61 | 228 | 65 | 47 |
| 10 | Before | Warm | 49 | 43 | 188 | 56 | 41 |
| 10 | After | Cold | 69 | 58 | 215 | 86 | 46 |
| 10 | After | Warm | 61 | 43 | 187 | 59 | 38 |
| 700 | Before | Cold | 77 | 563 | 864 | 71 | 43 |
| 700 | Before | Warm | 70 | 490 | 750 | 67 | 53 |
| 700 | After | Cold | 75 | 99 | 256 | 87 | 63 |
| 700 | After | Warm | 63 | 100 | 345 | 75 | 48 |

The dedicated cold/warm 700-row measurements above supersede the initial mixed-size trial for that size; 700 was already warm in that first trial. The measured bottleneck improved by about **5.7× cold / 4.9× warm** at confirmation and **3.4× / 2.2×** to visible rows. Preview and tiny-file times did not uniformly improve; no broad speed claim is made for them. All timing-journey questions used local Privacy mode, with **zero Gemini wait**; the revised local application portion was 18.5–38.6 ms in the small-file run and 24.2–32.9 ms in the dedicated 700-row run. Live Gemini timings above are separate single requests, not repeated paid-call performance samples.

Generated timing JSON, screenshots and the bounded local rehearsal launchers stay ignored under `test-results/import-coach/` and `.cache/`. No keys, real bank files or runtime database credentials were committed. Documentation-only result commits after `ba9cf32` do not change the running artifact.
