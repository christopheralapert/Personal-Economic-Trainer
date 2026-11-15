# Challenge readiness — 15 November 2026

## Presentation cleanup: bundled interface text

The presentation uses bundled, reviewed **English / Finnish / Estonian** interface
labels and all six Learn topics. The generated-UI client, catalog, provider route
and their obsolete tests were removed, rather than merely hidden behind a flag.
`/api/language` returns 404. Unsupported app-language commands explain the three
available choices without calling a model or changing the current conversation.
Settings and supported whole-app commands still switch/persist the bundled copy.
Spanish/Japanese conversation controls remain separate; Gemini Coach text, voice,
Privacy mode, imports, finance calculations and transaction evidence are preserved.
No old application version or Git history was restored over the integrated fixes.

Preview: http://127.0.0.1:33172/demo ; Coach:
http://127.0.0.1:33172/demo?dataset=organizer1&tab=coach . The checked production
artifact has application fingerprint **`b19c3d23df02`**, built from base `6da8ba7`
plus this cleanup; its HEAD prefix advances after the local commit/rebuild.
The existing private test API/data and bounded usage ledgers remain intact.

| Check in this cleanup | Result |
| --- | --- |
| Main and standalone production builds; both application typechecks | Passed |
| Coach/domain/voice unit suite | **253 passed**, 48 files; obsolete generated-translation tests removed, conversation controls retained |
| Structure and main PWA/privacy checks | **75 passed** |
| Conversation, voice-flow and challenge production browser suites | **42 passed**; test transport/local rules, audio mocked |
| Real Finnish organizer1 Gemini regression | **1 passed**; `source=model`, `provider=gemini-direct`, August 2026 / €30.97 and open transaction; question → evidence 2,838 ms, provider 2,565 ms |
| Visual review | 390 × 844 and 1280 × 900 landing, Overview, Learn and Finnish Settings; no horizontal overflow; existing design retained |
| Repository hygiene | No tracked environment/build/log/archive artifacts, files over 2 MiB or high-confidence key-pattern candidates; entry-guide links resolve. This is not a comprehensive security audit |

The first revised voice test incorrectly counted all Settings radios as five;
scoping its assertion to the actual three-option Language group fixed the test.
The first screenshot capture used a heading that is not present on the landing
page; using its actual primary link allowed the complete batch to run. Neither
failed harness attempt is counted as a passing check. The Impeccable hardening
pass preserved layout/tokens; its detector returned no findings.

Only the six retired generated-UI source/test files were removed in this cleanup;
they remain recoverable in Git history. Useful finance, import, ownership,
Privacy, voice and provider regressions and dependency attribution are retained.
README and test guides now describe the supported presentation behavior. Local
secrets were not changed; public HTTPS/ngrok were not updated. Physical-device,
real Auth0, Nemotron correctness and production-operation gaps below remain.

## Prior handoff after the permission retry

- Implementation checkpoint: **`d0edf1e`**, `feat: add exact amount search and release readiness`.
- Current local preview: http://127.0.0.1:33172/demo
- Organizer Coach: http://127.0.0.1:33172/demo?dataset=organizer1&tab=coach
- Anonymous sample import: http://127.0.0.1:33172/demo/import
- Private test entry: http://127.0.0.1:33172/api/v1/auth/login?return_to=/import
- Learn: http://127.0.0.1:33172/demo?dataset=organizer1&tab=learn
- Verified production build: **`d0edf1e-131377e695625033-bdeae4fa70c4`**;
  later test/report-only commits retain application fingerprint `bdeae4fa70c4`.

The isolated API is on 18085. The normal test sign-in entry offers **model-review**
(one “Synthetic conversation account”, two October taxi rows totalling €30.97),
**other-owner** and **fresh-preview** (empty). No password is needed. This is
signed **test-OIDC, not real Auth0**. Public and private text use real Gemini;
public Gemini voice is enabled. Private hosted audio remains disabled. Nemotron
search is not enabled/promoted after the failed strict probe. Earlier previews,
public HTTPS and ngrok remain unchanged.

### Real-provider and recovery results

This section supersedes the earlier network/Git blockers below. New processes
can reach Google and Verda and stage Git changes. The PowerShell executable still
fails at process launch; Command Prompt can launch Node, Python and Git normally.
The older web process retained its denied network context. Restarting **only**
the task-owned 33171 listener fixed public Gemini without changing keys, usage
ledgers, other previews, ngrok or the public HTTPS deployment.

On production build `f5218e9-131377e695625033-bdeae4fa70c4`, the opt-in real
conversational browser selection passed **2 tests** (three real answers):

| Real organizer1 browser query | Visible answer | Provider wait | Result |
| --- | ---: | ---: | --- |
| “How can I fixs my spending?” | 3,430 ms | 2,819 ms | `source=model`, `provider=gemini-direct`; September 2026, €7,017.40 and actionable next step |
| Last-month taxis | 2,363 ms | 2,260 ms | Same real provider; August 2026, €30.97; underlying dated transaction opened |
| Previous-month follow-up | 2,394 ms | 2,300 ms | Same real provider; July 2026, €226.57, retained taxi scope |

Each financial answer used two native Gemini calls: tool selection then grounded
composition. These are single observations, not percentile benchmarks. The real
speech browser test also passed: **503,022 streaming-envelope bytes**, containing
audio and completion with no error. This byte count is not decoded audio size or
physical-speaker proof. The repeated real speech test passed with a playback
timing assertion: **2,701 ms** click → first scheduled PCM, **68 ms** estimated
browser/output startup, **2,769 ms** estimated click → output. The provider's
first-chunk wait was **2,537 ms**. Output latency is estimated by the browser, not
measured acoustically; this repeat is another fresh generation, not audio replay.
The second stream envelope contained 456,663 bytes, audio and successful completion.

Permission-retry regressions also passed: both workspace typechecks, **53**
targeted API tests, **59** targeted Coach/voice tests and **18** structure/readiness
tests. Full-suite results below were obtained earlier on the same application
source. GitHub read-only reachability now works; the remote integration branch
still points at the local base `f5218e9`.

On the 33172 build, one additional **real Finnish browser test passed**:
“Paljonko käytin takseihin viime kuussa?” returned `source=model`,
`provider=gemini-direct`, a Finnish August 2026 sentence and €30.97. The dated
underlying transaction opened. Question → open evidence took **4,129 ms**;
provider time **3,870 ms** across two calls (evidence time is included, not merely
answer latency).

The fresh private browser test also passed through real synthetic CSV selection,
automatic local classification, saved History and real `gemini-3.5-flash`:
two saved October taxi rows → **€30.97**, both evidence rows opened and a detail
drawer verified. Confirmation → History: **368 ms**; general conversation →
visible answer: **1,314 ms**; taxi query → API answer: **2,482 ms**, followed by a
passing visible-answer assertion. Three real private provider calls, zero model
transport mocks. Enabling Privacy then produced a local answer without changing
the provider counters. The identity service alone uses a signed test issuer.

On this same source, **8** mocked-SSE/local conversational, **14** mocked voice
and **20** local-Privacy challenge browser regressions passed again. Challenge
coverage includes EN/FI/ET, Chromium/emulated WebKit, 390 × 844 and 1280 × 900.
No physical microphone, acoustic output, phone installation or human user study
is implied by these tests.

Docker now works. The new opt-in `tests/integration/test_backup_restore.py`
**passed** against disposable PostgreSQL 17.6: four synthetic rows / three owner
scopes, exact full-table snapshots, migration head `0029_automatic_classification`,
RLS policies and restricted-role totals preserved. Dump **258 ms**, restore
**788 ms**; source unchanged. Encryption/decryption was in memory, with no retained
backup or key. Only uniquely created test databases/roles were removed; existing
preview databases were left intact. Two earlier exploratory dump attempts failed
because the container's database superuser was not named `postgres`; using its
configured administrator resolved this without credential logging. This does not
prove production off-host backups, lost-key recovery, retention or billing setup.

The separate, read-only Nemotron smoke reached **HTTP 200** in **1,586.7 ms** and
returned `interpret_money_question`. It **failed** strict validation:
`reduction_basis_points` had an invalid integer type and `comparison_mode` an
invalid literal. No ledger search was run and this is **not** a Nemotron search
success. The experimental adapter remains separate; Gemini stays the default.
Keys, payloads and provider bodies were not logged. Real Auth0 and physical-device
or human-user checks remain unverified; improved permissions do not prove them.

### Repeat commands

```powershell
$env:CONVERSATION_COACH_URL='http://127.0.0.1:33172'
$env:MONEY_COACH_REAL_CONVERSATION_TEST='true'
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.conversational-coach.config.ts --grep '@real.*Finnish taxi answer'
$env:PRIVATE_CONVERSATION_URL='http://127.0.0.1:33172'
$env:PRIVATE_CONVERSATION_API_PORT='18085'
$env:PRIVATE_CONVERSATION_REAL='true'
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.private-conversation.config.ts
$env:FRESH_COACH_URL='http://127.0.0.1:33172'
$env:MONEY_COACH_REAL_FRESH_TEST='true'
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.fresh-coach.config.ts --grep 'real Gemini speech'
```

These opt-ins use paid live inference and preserve durable request allowances.
Repeating the private fixture now tests an exact re-import (zero added rows), not
another fresh workspace. The container recovery command is documented in
`deploy/production-readiness.md` and requires the existing private test DSN.

**Still missing:** real Auth0's six settings and normal two-user tenant sign-in,
successful schema-valid Nemotron search/ledger/browser proof, physical-device
microphone/playback/install, actual participant review and production
security/retention/key-recovery/provider-billing approval. Do not call a fallback,
configured key or HTTP 200 alone a successful provider check.

Everything below is the historical baseline and earlier diagnostics, superseded
by this current handoff where results differ.

## Historical checked version and entry points

- Branch: `integration/demo-import-first-next`; base HEAD: `f5218e9`.
- Source: modified working tree, **not a new commit**. Git could not create `.git/index.lock` (`Permission denied`); the elevated process itself failed with `Access is denied (os error 5)`. The index remains empty. No history rewriting, push, PR, public deployment or ngrok action occurred.
- Production artifact: `frontend/web/.next/fresh-coach-33171`.
- Current build after amount-search implementation: **`f5218e9-131377e695625033-bdeae4fa70c4`**. The last segment fingerprints application source/config/contracts, including uncommitted changes, without reading dotenv, Git metadata, uploads or usage ledgers. `BUILD_ID` and HTTP `X-MoneyLens-Build` agree. This is not proof that the work has been committed. The cleanup preview on 33170 remains running separately.
- Start: http://127.0.0.1:33171/demo
- Organizer Coach: http://127.0.0.1:33171/demo?dataset=organizer1&tab=coach
- Anonymous sample importer: http://127.0.0.1:33171/demo/import
- Learn: http://127.0.0.1:33171/demo?dataset=organizer1&tab=learn
- Private test entry: http://127.0.0.1:33171/api/v1/auth/login?return_to=/import

The current preview and its isolated API (`18084`) are left running. Sign-in uses locally signed **test-OIDC**, not Auth0. Select **model-review** for “Amount fixture A” (two October taxis: €15.00 + €15.97 = €30.97) and “Amount fixture B” (one €7.00 taxi), together €37.97. **other-owner** has no accounts; a fresh browser reached its editable composer without another owner's rows. **fresh-preview** is unused on this new fixture. No password is needed. Private online Coach uses **native Gemini test transport, not real Gemini**. Public demo Gemini text/audio are opted in but blocked by outbound `EACCES`. The older preview/API on 33170/18083 and public HTTPS/ngrok remain untouched.

The public sample requires no sign-in, personal bank account, bank query or downloaded file. Use **Try file import → Use sample file → Confirm imports → View transactions / Ask Coach**. Ask “How much did I spend on taxis in October 2026?” for €30.97 and two openable transactions. Organizer1 is different: “How much did I spend on taxis last month?” means August 2026 and €30.97 from one transaction.

## Current follow-up: exact amount search and remaining release gaps

Implemented exact EUR transaction-magnitude bounds across the public engine,
authenticated ledger SQL/API, closed tool arguments, model validation, paging,
selector follow-ups and private evidence. `over EUR 20` means at least **2,001
cents**; `at least EUR 20` means **2,000**; `under EUR 20` means at most **1,999**.
Category, literal merchant, selected accounts and dates intersect with these
bounds. Signed flow remains separate: refunds and unknown transfers are not
reclassified as purchases. Cross-currency, negative, contradictory, repeated and
ambiguous OR/range expressions are not silently relaxed. Arbitrary analytics,
FX conversion and every natural-language range formulation are not claimed.

For private queries, the server attaches parsed amount constraints after the
model's validated intent selection; the model cannot change them. Wrong period,
category, merchant or intent is rejected and the local fallback retains the
requested bounds. The public model's complete closed tool input must match all
locally resolved selectors. No model gets account authority or SQL. Gemini remains
default; the failed/research-only Nemotron adapter was not promoted.

| Final working-tree check | Result and boundary |
| --- | --- |
| Main web production build, both workspace typechecks | Passed |
| Coach Vitest with runner configuration loader | **257 passed**, 50 files; model transports mocked |
| Full API unit suite | **1,113 passed**, four existing warnings |
| Actual PostgreSQL ledger, amount search, query, records-model and private-Gemini suites | **28 passed**; hosted providers mocked, signed synthetic sessions |
| Workspace/source/context/readiness checks | **21 passed**, including five secret-free readiness tests |
| Main/standalone PWA and AI Node suites | **69 passed** |
| Published v1 contract compatibility | Passed; optional additive amount fields and resolved references |
| New amount-search production browser suite, 390 × 844 Chrome | **4 passed**: EN/FI/ET organizer plus fresh private CSV/two-account journey, exact rows, evidence, empty result and second owner; one private answer used native Gemini **mock transport** |
| Full challenge production browser suite | **20 passed**, EN/FI/ET in Chrome and emulated WebKit at 390 × 844 and 1280 × 900 |
| Conversational Coach production browser contract | **8 passed**, mocked SSE, real local Privacy/fallback rendering |
| Voice production browser flow | **14 passed**, mocked recording, device speech and hosted audio, not physical devices |
| Six-format PostgreSQL/browser regression | **7 passed** in 22.6 s; wrapper **1 passed** in 26.31 s; all pre-existing fixture databases/roles preserved, no fixture leftovers |
| Visual hardening | Existing layout preserved; inspected phone/desktop renders and no overflow. Mechanical detector returned no findings |

The first new private browser run used the wrong accessible account label; after
correcting the test to the existing **Account scope** control, its fresh isolated
rehearsal passed. A temporary invocation overriding pytest's normal import mode
failed collection; the normal repository configuration then passed the complete
API and 28-test PostgreSQL selections. Neither earlier failure was counted as a
passing run.

Final-build timing samples, one observation each with synthetic data (not cold /
warm distributions): private CSV A, two rows, Confirm → History **348 ms**; CSV B,
one row, **208 ms**. Question → visible filtered answer: account A/local **84 ms**,
account A/native Gemini **mock** **89 ms**, account B/local **67 ms**, combined/local
**68 ms**, empty/local **66 ms**. During that private browser journey the mock provider made exactly **two** native
Gemini transport calls; real Gemini/Verda calls were **zero**. No real-model
latency or physical audio success is claimed.

Separate explicitly live attempts on the final build **failed**, not counted above:

| Attempt | Actual result |
| --- | --- |
| Normal organizer browser, “How can I fixs my spending?”, Privacy off | HTTP 200, `source=rule`, `provider_network_access_denied`, one attempted provider call; visible fallback 165 ms, failed model wait 32 ms; not Gemini success |
| Gemini read-aloud route for the server-computed August taxi answer | HTTP 200 streaming envelope, provider header `gemini`, **zero audio events**, no completion, `voice_unavailable`; 48 ms to failure, no audible playback |
| Existing separate-branch Nemotron synthetic probe, executed read-only against the current runtime | One attempted Chat Completions call; no HTTP response or tool; `MODEL_TRANSPORT_ERROR`, `ConnectError`, errno 13 / winerror 5, 217.6 ms; tool validation and ledger execution were not reached |

The last probe reused the reviewed `scripts/probe_nemotron_search.py` source from
`experiment/nemotron-search-next` without merging the research adapter or changing
branches. Keys, model request bodies and provider response bodies were not printed.
The failed provider wait times are not first-audio or successful inference benchmarks.

Repeat public amount checks with:

```powershell
$env:MONEYLENS_AMOUNT_SEARCH_ORIGIN='http://127.0.0.1:33171'
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.amount-search.config.ts
node --env-file-if-exists=.env scripts/release_readiness.mjs --probe
```

The private case additionally needs `MONEYLENS_AMOUNT_SEARCH_PRIVATE=true` and a
**fresh** database/identities. Do not repeat it against the retained populated
workspace and pretend another exact import is a fresh upload. To create another
isolated rehearsal, privately supply a dedicated loopback
`MONEYLENS_TEST_DATABASE_URL`; use unused web/API ports, build with
`scripts/local_fresh_coach.mjs build <webPort> <apiPort>`, then run
`scripts/run_guard_preview.py --test-only --port <webPort> --api-port <apiPort>
--dist .next/fresh-coach-<webPort> --coach-model mock --classification-model off
--api-only` and the matching web launcher. Existing previews must stay running.

Remaining checks and smallest next steps:

- **Live Gemini text/audio and Nemotron:** both credential-free Google and Verda
  HTTPS probes return `EACCES`; approved elevation fails to launch with
  `Access is denied (os error 5)`. Run in an authorized server session with HTTPS
  egress, then repeat the strict real-provider/browser cases. Configured keys and
  HTTP envelopes are not inference/audio proof. The separate Nemotron research
  report was read from `experiment/nemotron-search-next`; its last strict smoke
  failed schema validation, so it remains experimental, not the default.
- **Real Auth0:** all six actual `MONEYLENS_OIDC_*` issuer/client/secret/URL settings
  named by the readiness tool are absent. Configure the real tenant and callback,
  then perform normal two-user login/logout/isolation; test-OIDC is not Auth0.
- **Physical device and user study:** no physical microphone/speaker/install or
  human participants are available here. Execute the consent-based phone/user
  protocol in [production readiness](../deploy/production-readiness.md); automation
  and emulated WebKit do not replace it.
- **Production backup/security/billing:** local admission/privacy/RLS controls are
  tested, but a production deployment is not certified. Docker engine access is
  denied and host `pg_dump`/`pg_restore` were not found, so no backup restore was
  performed. Provide an authorized PostgreSQL tool/container environment and run
  the documented disposable restore drill; set real provider project quotas and
  alerts and approve retention/security/incident controls before release.
- **Commits:** `.git` writes and approved elevated process creation are still
  denied. Pending code, tests and documentation are preserved; HEAD stays
  `f5218e9`, with no new commit, push or public deployment.

## Earlier planning and cleanup changes

- Demo financial coverage remains honestly low confidence even after confirming bills/classifications. Stale balances suppress spending ranges; an income estimate never substitutes for a balance. Recurring income is grouped by account and merchant and cannot use an old stopped salary pattern.
- How is this calculated? now has localized EN/FI/ET input-review steps and the relevant income, bills and classification actions. Extra saving remains unavailable where the snapshot cannot establish it. The three previously removed explanatory paragraphs stay removed from Coach, Learn and What if; confidence, source date, partial-data chip, info and calculation controls remain.
- FI/ET “previous period” comparisons resolve through the existing authenticated comparison tool, preserving literal merchant filters, current account selection and date semantics. The follow-up below implements exact EUR search bounds; invalid/ambiguous/cross-currency predicates still fail closed instead of silently returning unfiltered results.
- Hosted text, transcription and speech now share finite lifetime/rate admission and concurrency protection. Reservations are durable and fail closed on corruption or unfinished writes. Optional money reservations are operator estimates, not a provider-invoice guarantee. Privacy bypasses hosted dispatch and budget writes. Fresh AI results are not cached.
- The production build identifies application-source changes even if HEAD is unchanged. Obsolete browser entry assertions were updated to the import-first journey; no public bank-connect step was reintroduced.

The interface work used the Impeccable hardening workflow, preserving existing layout/tokens. The detector returned no findings; phone and desktop renders were inspected. Automated WebKit is not a physical iPhone.

## Challenge requirements and acceptance

The official challenge text supplied in the conversation was the requirement source. The organizer archive README supplies dataset/download instructions, not additional task authority.

| Requirement / scope | Where the user sees it | Check and evidence | State |
| --- | --- | --- | --- |
| Official core: talk with personal financial data | Coach and evidence drawers | Public localized/browser flows and private six-format saved-ledger queries; real-provider recheck blocked below | Partly proven |
| Official core: organizer synthetic dataset | Anonymous organizer1 | `organizer-source.json`, `build_organizer_data.py`, provenance test; 1,543 whole-customer rows; matching source SHA-256 `49b3265d8e44e751de305a074dcffcda732bb79aa1e07b46fcca774ce76f1e63` | Proven |
| Official example: last-month taxis | Organizer Coach | EN/FI/ET, August 2026, €30.97, opened `MRC-TRN-0063`; Chrome/WebKit phone/desktop | Proven |
| Official example: spender pattern | Coach | `organizer-demo.spec.ts` free-text profile → Home, transaction-linked chart | Proven |
| Official core: three baskets and plain-language learning | Overview / six Learn topics | `challenge-acceptance.spec.ts`, organizer suite and existing learning/domain tests | Proven |
| Official example: reduce dining by 20% | Coach / What if | September €797.88 → €159.58; 20% initial slider, 30%/speech regression | Proven |
| Official emphasis: safe spending/saving | Demo calculation review / private Plan | Incomplete data withheld; 55 real-DB planning checks and 9 mocked-API UI checks independently prove €200 → reserve €50 → €150 → release €200. No claim of one unmocked planning browser journey or complete organizer finances | Partly proven |
| Official MyData direction: choose what to explore | Account/period/category selectors, free-text Coach, transaction details | Scoped queries, comparisons and exact EUR minimum/maximum search combined with category/merchant/period/account. Arbitrary OR logic and unrestricted analytics are not claimed | Partly proven |
| Recommended: mobile web | Demo, upload, Coach and private views | Chrome/WebKit 390 × 844; desktop 1280 × 900; no document overflow in checked journeys | Proven |
| Optional bonus: population benchmarks | Comparison/reference tools | Existing reference/domain tests; no new population-data browser proof in this pass | Partly proven |
| Optional bonus: PSD2 multi-bank connection | Separate real-bank integration | File-account aggregation is not PSD2; real consent/credentials were not exercised | Blocked |
| Product acceptance: private signup and isolation | Normal /import sign-in and private workspace | Signed test-OIDC; fresh/repeat/concurrent provisioning, blocked membership, RLS, saved-ledger isolation in database regressions and six-format harness | Proven with test-OIDC |
| Product acceptance: real Auth0 | Same private entry with real configuration | Not supplied/verified by local test issuer | Blocked |
| Product acceptance: import-first anonymous practice | Landing /demo/import | Choose/remove/drop/sample, invalid-file recovery, repeat, History reload, Coach and evidence | Proven |
| Product acceptance: privacy and editable speech flow | Coach and Settings | Hosted admission/unit assertions, 14 mocked-audio browser checks, local evidence and no provider dispatch under Privacy | Proven with mocked audio |
| Product acceptance: actual microphone, audible playback and PWA install | Physical phone/browser install prompt | No physical device in this environment | Not done |
| Product acceptance: financial-literacy/usability outcome | New users completing the journey | Browser tests are not a user study; run the short review below | Not done |
| Product acceptance: current public HTTPS presentation | Approved public URL | Deliberately left unchanged pending review; not deployed here | Not done |

The attached organizer ZIP contains a 134-byte Git LFS transaction pointer, not a new full CSV. The app's recorded full-source hash matches it. Source provenance is therefore not replaced by invented transactions.

## Exact import coverage

The real production BFF, signed test-OIDC and disposable PostgreSQL harness verifies file selection → account/period/currency/count preview → confirmation → persisted History → private Coach for six synthetic exports, with a seventh mixed-file case. Provider models/banks are disabled or mocked in those regressions, not live services.

| Format | Tested export variant |
| --- | --- |
| CSV | UTF-8 English Wise EUR export with required transfer ID/date/amount/currency/description columns; optional BOM/IBAN. Canonical EUR integer-cents CSV remains covered by publication/unit/database tests. |
| PDF | English Wise EUR selectable-text statement, dates, account and transaction references. Wrapped descriptions covered by unit tests; **no scanned/OCR or encrypted PDF support**. |
| XLSX | One OOXML worksheet with Wise columns and inline text/date fixture; shared strings and 1900-epoch numeric dates covered by parser tests, not a separate browser fixture. |
| CAMT.053 XML | `camt.053.001.10`, one EUR statement, BOOK entries, one transaction-detail record per entry, CRDT/DBIT. |
| MT940 | One EUR statement with `20/25/28C/60F`, `61/86` pairs and `62F`. No claim for every bank's wrapper/reversal variant. |
| QIF | `!Type:Bank`, terminated D/T/P records, explicit day-first date choice and EUR/account selection. |

Wise intake: up to **10 files, 2 MiB each, 1,000 rows per file**, plus the encrypted-preview size bound. Canonical cents CSV has its separate **64 KiB / 1,000-row** limit. Exact repeats/full cross-format matches add zero rows; distinct equal-date/equal-amount purchases survive. Partial overlaps are conservatively surfaced for review, not silently merged. See [the import review](wise-statement-review.md) for full boundaries.

Actual migration head: **`0029_automatic_classification`**, one head. Upgrade regressions cover fresh setup and populated historical schemas, including both statement `0025` revisions and the separate signup `0025`; historical transactions, ownership and replay protections survive. Older handoffs naming 0027/0028 as the current head are historical.

## Earlier verification and timing (before amount search)

Commands run from the repository root; existing ignored keys were neither changed nor printed.

| Check | Result / boundary |
| --- | --- |
| `npm exec --workspace @moneylens/coach -- vitest run --configLoader runner` | **235 passed**, 49 files; model transports injected |
| `.venv/Scripts/python.exe -m pytest -c backend/api/pyproject.toml tests/api -q --disable-warnings` | **1,092 passed**; database-free API tests, offline providers |
| Targeted signup/identity/import/Coach/migration PostgreSQL selection | **117 passed**; disposable real databases, offline providers |
| Planning routes/review/store PostgreSQL selection | **55 passed**; real calculations, persistence, RLS and reservation/release |
| `npm run typecheck` | Both workspaces passed |
| `npm run build:coach` | Standalone production build passed; unrelated generated worker stamp restored |
| `node --env-file-if-exists=.env scripts/local_fresh_coach.mjs build 33170 18083` | Main production build passed |
| `npm run test:structure` | **16 passed**, including source identity, container-helper inclusion and dataset provenance |
| `node --test tests/pwa/*.test.mjs` | **54 passed**; private/model/voice responses never cached |
| `node --test frontend/coach/tests/pwa/*.test.mjs frontend/coach/tests/ai/*.test.mjs` | **15 passed**, offline AI transport/usage and PWA boundaries |
| `npm run test:web-money` | **7 passed**, exact cents/input and proxy-context utilities |
| Challenge config, final build | **20 passed**, EN/FI/ET × Chrome/WebKit phone/desktop, planning review and anonymous import |
| Planning-review config, final build | **9 passed**, mocked session/API fixtures, real rendered forms |
| Voice-flow config, final build | **14 passed**, mocked recording, device speech and hosted audio/translation; no physical-device claim |
| Conversational-Coach config excluding `@real` and provider-disabled-only case | **8 passed**, mocked SSE/local Privacy and failure rendering |
| Demo config, final build | **15 passed**, source/evidence, scenario, navigation and keyboard |
| Demo-import config | **8 passed** before the diagnostics/build-ID-only rebuild; anonymous seven-case subset repeated on the final artifact. Private test identity was already populated on repeat, so the fresh-only case was not falsely called a second empty-workspace run |
| Wise browser/PostgreSQL harness | **7 browser cases passed** on the final source-fingerprinted build in 28.0 s; **1 PostgreSQL wrapper passed** in 32.11 s. All six formats, mixed files, account scopes, History/Coach, replay and owner isolation; fixture services/databases cleaned up |
| Fresh-context private entry | other-owner: zero accounts, editable Coach, signed test-OIDC; real Auth0 not used |

Pre-cleanup build `d169aacc27e3` two-row public CSV measurements (one observation per browser, not statistical/cold-start benchmarks):

| Browser / viewport | Confirm → visible History | Submit → visible local answer |
| --- | ---: | ---: |
| Chrome 390 × 844 | 173 ms | 200 ms |
| Chrome 1280 × 900 | 185 ms | 234 ms |
| WebKit 390 × 844 | 755 ms | 716 ms |
| WebKit 1280 × 900 | 675 ms | 562 ms |

Reproduce the browser checks against the running production artifact:

```powershell
$env:MONEYLENS_CHALLENGE_ORIGIN='http://127.0.0.1:33170'
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.challenge.config.ts
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.planning-review.config.ts
$env:VOICE_FLOW_URL=$env:MONEYLENS_CHALLENGE_ORIGIN
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.voice-flow.config.ts
$env:CONVERSATION_COACH_URL=$env:MONEYLENS_CHALLENGE_ORIGIN
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.conversational-coach.config.ts --grep-invert '@real|production server with provider disabled'
$env:MONEYLENS_DEMO_TEST_ORIGIN=$env:MONEYLENS_CHALLENGE_ORIGIN
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.demo.config.ts
$env:MONEYLENS_IMPORT_DEMO_ORIGIN=$env:MONEYLENS_CHALLENGE_ORIGIN
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.demo-import.config.ts --grep-invert 'own statement signs in'
```

The omitted fresh-private-identity case requires an unused identity/database, not deletion of the preview user's rows. To rerun the independent seven-case format harness, privately set the isolated `MONEYLENS_TEST_DATABASE_URL`, then:

```powershell
$env:MONEYLENS_STATEMENT_BROWSER_TEST='true'
$env:MONEYLENS_NEXT_DIST='.next/fresh-coach-33170'
.venv/Scripts/python.exe -m pytest -c backend/api/pyproject.toml tests/integration/test_wise_browser.py -s --tb=short -p no:cacheprovider
```

For the 117-test database selection, with that same dedicated test administrator:

```powershell
$dbChecks=@('self_signup','identity','invited_members','membership_fence','statement_branch_upgrade','statement_migration','statement_formats_flow','wise_flow','statement_staging','statement_publication','auto_classification_flow','coach_query','coach_languages','private_gemini','private_records_model','coach_amount_guard') | ForEach-Object {"tests/integration/test_$_.py"}
.venv/Scripts/python.exe -m pytest -c backend/api/pyproject.toml @dbChecks -p no:cacheprovider --tb=short
.venv/Scripts/python.exe -m pytest -c backend/api/pyproject.toml tests/integration/test_planning_routes.py tests/integration/test_planning_review.py tests/integration/test_planning_store.py -p no:cacheprovider --tb=short
```

The 700-row benchmark was not repeated in this pass; the earlier cold/warm measurements retain their own artifact context. No final-build successful Gemini latency is claimed.

## Repository cleanup follow-up

Removed the unused seven-file `frontend/prototype` Vite dashboard and its separate service worker, the three superseded `integration-review`, `ui-redesign-review` and `presentation-handoff` reports, four unused npm commands, and the root-only Vite dependency declaration. All deleted tracked content remains recoverable from Git history at `f5218e9`; no history was rewritten. Vite remains a transitive test dependency, with existing resolved package versions unchanged. The lockfile was updated offline with lifecycle scripts disabled.

Removed one obsolete duplicate real-chat test that expected the retired `data-model-guidance` element. Native conversational text, fresh repeated requests, reload, financial facts and evidence remain covered by `conversational-coach.spec.ts`, including opt-in real-provider cases. The separate real speech and NVIDIA translation checks remain; failing or blocked checks were not removed to produce a pass. Import, calculation, ownership, migration, privacy, voice and PWA suites and their synthetic fixtures remain intact.

Updated the test guide to distinguish historical handoffs from the current preview, corrected signup's documented migration head, and included `scripts/web_revision.mjs` in the Docker build-context allowlist. A structure regression now checks both the required Docker COPY and its context exception. No container runtime build was performed.

Checks repeated on current build `30db5c25696e`:

| Check | Result |
| --- | --- |
| Production main-web build and both application typechecks | Passed |
| Coach Vitest | **235 passed** with `node node_modules/vitest/vitest.mjs run --root frontend/coach --configLoader runner` |
| API unit suite | **1,092 passed**, four pre-existing warnings |
| Workspace/source identity/build-context structure | **16 passed** |
| Main and standalone PWA/AI Node suites | **69 passed** |
| Exact-cent web utilities | **7 passed** |
| Chrome and emulated WebKit, phone and desktop challenge journey | **20 passed**, local Privacy answers, no live model |
| Conversational Coach browser contract | **8 passed**, mocked SSE plus real local Privacy/failure handling |
| Voice-flow browser regression | **14 passed**, mocked recording/providers/device speech; cancellation, editable drafts, exactly-once send and Privacy boundaries |
| Six-format PostgreSQL/browser harness | **7 browser cases passed** in 25.6 s; wrapper **1 passed** in 29.36 s; pre-existing databases/roles preserved and no fixture databases/roles left |

The default `npm test` invocation hit an environment-specific esbuild parent-directory `Access is denied` while bundling its configuration. The runner configuration loader above then executed all 49 files / 235 tests successfully; tests and provider assertions were not bypassed. Retained real-provider tests still collect, but were not rerun as paid successes.

Two-row sample timing observations on the current artifact, with other regression runners active (not controlled cold/warm comparisons):

| Browser / viewport | Confirm → visible History | Submit → visible local answer |
| --- | ---: | ---: |
| Chrome 390 × 844 | 182 ms | 168 ms |
| Chrome 1280 × 900 | 166 ms | 183 ms |
| WebKit 390 × 844 | 713 ms | 656 ms |
| WebKit 1280 × 900 | 678 ms | 658 ms |

Cleanup did not change credentials, usage ledgers, public HTTPS deployment or ngrok. Google HTTPS still returns `EACCES`. `git add -- .dockerignore` still fails to create `.git/index.lock` with `Permission denied`; both requested elevated Git/HTTPS processes failed to start with `Access is denied (os error 5)`. No stale index lock exists. These are remaining session permission blockers, not successful Gemini or commit verification.

## Live-provider blocker — not counted as a pass

Public conversational Gemini browser tests attempted real `gemini-3.5-flash`, but returned `source=rule`. A credential-free Node HTTPS probe to Google failed with `TypeError` → `EACCES`. A Python HTTPS probe likewise reached `PermissionError`, errno 13. The task-created web/API processes cannot establish outbound provider connections in this execution environment.

The public adapter now safely reports `provider_network_access_denied`, rather than conflating connection denial with invalid model output. The authenticated browser test reached the real import and saved two rows, then failed its real-model assertion with `MODEL_UNAVAILABLE`; its rehearsal transport counter recorded real dispatch attempts and zero mocked Gemini calls. **This is not successful private Gemini verification.**

The real Listen browser attempt also failed; no physical speaker test was performed. A direct request to the same speech route returned HTTP 200's streaming envelope with **zero audio events**, `complete=false`, `error=voice_unavailable`. HTTP 200 or a “gemini” provider header alone does not establish generated audio. The browser's cancelled-error stream also made its DevTools response body unavailable; it is recorded as failed, not passed audio.

Text and voice are explicitly opted in on this local preview with a shared **100-operation lifetime / 60-per-minute** QA grant; their keys remain server-only. Actual network availability is blocked. Generated NVIDIA UI translation stays disabled by the preview helper; Nemotron transaction search remains separate from the main Gemini text path. Public HTTPS settings were not changed.

### Reproduce after allowing normal server egress

The smallest next step is to run the preview server from a normal authorized PowerShell terminal with Google HTTPS access. Do not expose keys in the browser or proxy them through an unrelated service. Stop only this task's localhost web listener, not existing previews/ngrok, then use:

```powershell
$env:MONEY_COACH_PUBLIC_GEMINI_ENABLED='true'
$env:MONEY_COACH_GEMINI_VOICE_ENABLED='true'
$env:MONEY_COACH_PUBLIC_AI_BUDGET_PATH="$PWD/.cache/public-ai-budget-challenge33170.json"
$env:MONEY_COACH_PUBLIC_AI_MAX_REQUESTS='100'
$env:MONEY_COACH_PUBLIC_AI_REQUESTS_PER_MINUTE='60'
$env:MONEYLENS_OIDC_ISSUER='https://identity.example'
$env:MONEYLENS_ALLOW_DEMO='false'
node --env-file-if-exists=.env scripts/local_fresh_coach.mjs start 33170 18083
```

Preserve the existing usage ledger; do not delete it to reset allowance. The running isolated API is required for the private flow. If it has stopped, set `MONEYLENS_TEST_DATABASE_URL` privately to the dedicated loopback test administrator (not a personal database), then in another terminal:

```powershell
.venv/Scripts/python.exe scripts/run_guard_preview.py --test-only --port 33170 --api-port 18083 --dist .next/fresh-coach-33170 --coach-model live --classification-model off --api-only
```

Rerun the public real tests with `CONVERSATION_COACH_URL=http://127.0.0.1:33170` and `MONEY_COACH_REAL_CONVERSATION_TEST=true`, private tests with `PRIVATE_CONVERSATION_URL`, `PRIVATE_CONVERSATION_API_PORT=18083`, `PRIVATE_CONVERSATION_REAL=true`, and real speech with `FRESH_COACH_URL`, `MONEY_COACH_REAL_FRESH_TEST=true`. Commands use the corresponding `tests/config/playwright.*.config.ts`; select `--grep '@real'` for public conversation and `--grep 'real Gemini speech'` for speech. Expected: `source=model`, `provider=gemini-direct`, correct period/amount/evidence; speech must contain audio and completion with no error.

### Human review still required

Ask a few new users to open /demo, import the synthetic sample, find both transactions, ask October taxis, then identify their largest organizer1 basket and try the 20% dining scenario. Record task completion, confusing steps and whether they can name one next action. On an actual phone, separately check microphone permission/denial, editable transcript, one Send, audible playback/Stop and installation. Automated checks above do not substitute for either exercise.

Public publication, real Auth0/PSD2 credentials, physical-device approval and production security/backup/retention/billing controls remain outside this local sign-off. The app is a tested synthetic prototype, not a certified banking service.

## Local commit recovery

No new commit hash can truthfully be supplied. All pending modified/new/deleted paths are preserved and unstaged; HEAD stays `f5218e9`. After fixing the local Git write/launch permission, review `git status --short`, stage only the implementation/test/documentation files from these passes (never `.env`, `.cache`, logs or generated output), inspect `git diff --cached`, then:

```powershell
git status --short
git add -- .env.example README.md backend/api/app/coach_intent.py deploy/web.Dockerfile frontend/coach/src/coach/conversation-provider.ts frontend/coach/src/coach/conversation-provider.test.ts frontend/coach/src/coach/public-chat-route.test.ts frontend/coach/src/coach/public-executor.ts frontend/coach/src/coach/public-executor.test.ts frontend/coach/src/components/gen/missing-data.test.ts frontend/coach/src/components/gen/safe-to-spend-card.tsx frontend/coach/src/engine/planning.ts frontend/coach/src/engine/planning.test.ts frontend/coach/src/i18n/dictionaries.ts frontend/coach/src/i18n/planning-review.ts frontend/coach/src/voice/public-budget.ts frontend/coach/src/voice/public-budget.test.ts frontend/coach/src/voice/routes.ts frontend/coach/src/voice/routes.test.ts frontend/web/next.config.ts scripts/local_fresh_coach.mjs scripts/web_revision.mjs tests/README.md tests/api/test_coach_period_comparison.py tests/browser/challenge-acceptance.spec.ts tests/browser/demo-presentation.spec.ts tests/browser/planning-support.ts tests/browser/planning.spec.ts tests/browser/private-conversation.spec.ts tests/browser/signup-statements.spec.ts tests/browser/wise-statement.spec.ts tests/challenge-readiness-review.md tests/config/playwright.challenge.config.ts tests/config/playwright.planning-review.config.ts tests/structure/web-revision.test.mjs
git add -- .dockerignore package.json package-lock.json tests/browser/fresh-coach.spec.ts tests/identity-signup.md tests/structure/layout.test.mjs frontend/prototype/index.html frontend/prototype/public/icons/icon-192.svg frontend/prototype/public/icons/icon-512.svg frontend/prototype/public/manifest.webmanifest frontend/prototype/public/sw.js frontend/prototype/src/main.js frontend/prototype/src/styles.css tests/integration-review.md tests/ui-redesign-review.md tests/presentation-handoff.md
git add -- backend/api/app/amount_search.py backend/api/app/analysis_tools.py backend/api/app/coach_model.py backend/api/app/ledger.py backend/api/app/ledger_routes.py deploy/production-readiness.md fixtures/synthetic/amount-search.v1.json frontend/coach/src/coach/amount-search.ts frontend/coach/src/coach/amount-search.test.ts frontend/coach/src/coach/explore-question.ts frontend/coach/src/coach/intent.ts frontend/coach/src/coach/query-language.ts frontend/coach/src/coach/resolve-question.ts frontend/coach/src/coach/rule-provider.ts frontend/coach/src/engine/index.ts frontend/web/components/coach-evidence.tsx frontend/web/components/coach-query.tsx packages/contracts/openapi.json packages/contracts/api.d.ts scripts/release_readiness.mjs scripts/run_guard_preview.py tests/api/test_amount_search.py tests/api/test_coach_routes.py tests/api/test_unsupported_search_amount.py tests/browser/amount-search.spec.ts tests/browser/amount-guard.spec.ts tests/config/playwright.amount-search.config.ts tests/integration/test_amount_search_flow.py tests/integration/test_coach_amount_guard.py tests/structure/release-readiness.test.mjs
git diff --cached
git commit -m "feat: add exact amount search and release readiness"
```

Rebuild after committing so the build's HEAD prefix reflects the resulting commit. The source fingerprint remains stable if only tests/docs or Git metadata change.

### Earlier explicit commit/push request

The user's latest request authorizes committing these changes and pushing the current branch; it supersedes the earlier no-push instruction, but does not authorize a production deployment, public HTTPS change or ngrok update.

The retry still could not stage `README.md`: `.git/index.lock` creation returned `Permission denied`. The approved elevated `git add` process failed to launch with `Access is denied (os error 5)`. A non-interactive read-only `git ls-remote --heads origin refs/heads/integration/demo-import-first-next refs/heads/main` also failed to connect to `github.com:443`. Therefore no new commit exists and no push was attempted; pushing the old HEAD would not publish the pending work. All 51 paths remain unstaged, with an empty index and HEAD `f5218e9`. The local demo still responds HTTP 200 with build `f5218e9-131377e695625033-30db5c25696e`.

From an authorized terminal with Git write and GitHub HTTPS access, run the explicit staging, cached-diff review and commit commands above, check each command succeeds, then:

```powershell
git push -u origin integration/demo-import-first-next
```

Do not force-push. If the remote has moved, fetch and review its history before integrating it; do not overwrite remote work.

The earlier release gaps are superseded by the current follow-up above: exact EUR search bounds are implemented, while unrestricted analytics are not claimed. Successful live public/private Gemini/audio and Nemotron, real Auth0, physical-device and human-user checks remain blocked or manual. Complete safe-to-spend/safe-to-save guidance needs sufficient reviewed balances, bills and income; the synthetic dataset's incompleteness is deliberately disclosed, not treated as zero spending. PSD2 and population benchmarking remain separate optional challenge bonuses. A production banking rollout additionally needs deployment/security, backup, retention and provider billing controls beyond these local prototype tests.
