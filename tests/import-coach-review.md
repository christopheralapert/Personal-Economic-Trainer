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

Final production browser, model and performance results are recorded below after running the integrated artifact. The public presentation configuration is not changed by local private testing. The separate signup worktree remains uncommitted and untouched; its `0025` identity migration needs reconciliation with the statement-provenance migration when that work is integrated later.

## Timing method

Chrome at 390×844, loopback BFF/API and a dedicated PostgreSQL 17.6 container; synthetic Wise files contain **10 rows / 439 bytes** and **700 rows / 28,639 bytes**. Timers start at the UI action and wait for the corresponding visible result, not merely HTTP completion. Confirmation-to-first-rows includes clicking **View transactions** and loading the first ledger rows. Repeat-import timing is the same normalized receipt returned without new rows; it is not a second publication.

Each cold file-size result is the first import journey after restarting the isolated API and web process, with a fresh database and browser context. Warm results use a new synthetic owner/browser context after those requests in the same process; this deliberately warms server/runtime paths without reusing a published receipt. These are local observations, not statistical benchmarks or physical-phone timings. No artificial throttling or provider-response fixtures are used in the timing journey.

Original 700-row publication used per-row inserts. Measured UI confirmation was 413–537 ms in an initial mixed-size pass, then 563/490 ms in a dedicated cold/warm 700-row process run. The revised publisher uses one atomic `jsonb_to_recordset` insert. `Server-Timing` separates application work from model request wait (network plus Google's processing); it cannot isolate Google's internal inference from internet latency.
