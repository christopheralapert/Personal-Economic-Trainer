# Production presentation handoff — 14 November 2026

## Coordinator update — 14 November 2026, 15:13 EET

The current presentation is now the integrated main web build, not the old target described in the original handoff below. Source branch: `integration/presentation-next`; source commit: `2fc4c66` (includes presentation `735b822` and environment guide `78a43ab`). The separate production artifact is `frontend/web/.next/presentation-next-20261114`, with **build ID `2fc4c66-131377e695625033`**. The build passed; its isolated output did not replace the existing 33118 preview's artifact.

| Running endpoint | Verified behavior |
| --- | --- |
| `http://127.0.0.1:33119/demo?dataset=organizer1` | Gemini enabled for this loopback origin. The normal browser Settings → Suomi → Privacy mode off journey made one real synthetic model request: HTTP 200, `source=model`, `provider=gemini-direct`, `evaluation=model_tool`. |
| `https://trophy-ranged-precook.ngrok-free.dev/demo?dataset=organizer1` | Existing ngrok tunnel still targets `http://127.0.0.1:33110`. Gemini chat and hosted voice are explicitly disabled in this server's runtime; provider keys are removed from its child environment. Browser/device voice remains selected. |

Both local servers and the actual HTTPS response returned HTTP 200 and the same `X-MoneyLens-Build: 2fc4c66-131377e695625033`. An ordinary fresh Chrome session completed ngrok's **Visit Site** warning and exercised public chat without request interception. Default Privacy mode returned `source=rule`, `evaluation=privacy_rule`; deliberately disabling Privacy mode still returned `source=rule`, `evaluation=public_configuration`, without a provider. The public `/api/voice/capabilities` response confirmed `enabled=false`. Browser speech controls were present, and there were no page errors. This confirms public local-answer configuration, not physical microphone or audio playback.

The visible sentence in both real browser journeys was **Käytit takseihin elokuussa 2026 yhteensä 30,97 €.** Its evidence button opened **MRC-TRN-0063**, **26.8.2026**, **−30,97 €**, taxi. Turning Privacy mode back on at the Gemini-enabled local endpoint also returned the local `privacy_rule` response without a provider. No extra paid model call was used for that check.

The root ignored `.env` was loaded explicitly by the local Gemini launcher. Checks passed for `GEMINI_API_KEY`, `MONEY_COACH_PUBLIC_GEMINI_ENABLED`, `MONEY_COACH_PUBLIC_AI_ORIGINS` and `MONEY_COACH_MODEL_USAGE_PATH`. The key was not displayed; a fingerprint excluding only the three requested configuration lines confirmed all other settings were preserved. The earlier local model network failure came from the sandboxed server process; running the same build through the approved external Command Prompt resolved it without application changes.

Verification on this artifact:

- Production web build: passed.
- `npm run typecheck`: both web and Coach passed, including a repeat after removing generated custom-dist TypeScript configuration changes.
- Demo Playwright configuration: **15 passed on 33119 and 15 passed on 33110**, including Finnish evidence/scenario and loading/loaded skip-link focus.
- Voice Playwright configuration: **33 passed on each server**. Recognition, synthesis, audio and hosted voice remain mocked; the browser journeys above use real chat routes.
- `npm test`: **168 Vitest + 15 AI/PWA Node tests passed**, without live providers.
- `npm run test:web-money`: **7 passed**, including native import-file validation.
- `npm run test:worker`: **54 passed**, including privacy, offline fallback and ngrok warning handling.

For the production browser suites, set `MONEYLENS_DEMO_TEST_ORIGIN` to the local origin and `MONEYLENS_VOICE_TEST_PORT` to its port, then invoke `node node_modules/@playwright/test/cli.js test --config tests/config/playwright.demo.config.ts` and the corresponding `playwright.voice.config.ts`. These checks attach to the existing production server rather than regenerating its build.

The ngrok process and 33118 demo were left alone. `agent/voice-polish` still has no new commit beyond `32c5877`; its future changes are not part of this presentation. Uncommitted `pet-signup-next` files were preserved; their database check remains separate and was not run here. No push was made. The physical-phone trial below is still pending and must not be inferred from mocked voice results. Documentation-only commits after `2fc4c66` do not change the running artifact's build ID.

## Original agent verification

At 14:37–14:41 EET, the integrated source was commit `32c5877b4ef07df5c6d009c168fb13fa571fcfdb`, with production build ID `32c5877-131377e695625033`. An additional main-web `next start` server was started on an OS-selected free loopback port, **53612**. It remains running for the coordinator at `http://127.0.0.1:53612/demo?dataset=organizer1`. No build was regenerated and the existing presentation server was left running.

| Check | Result and boundary |
| --- | --- |
| Production HTML | Real HTTP 200; `X-MoneyLens-Build: 32c5877-131377e695625033`; `X-MoneyLens-UI: authenticated-home.v1`. |
| Finnish presentation at 390px and 360px | Passed. Settings → Suomi; visible answer: **Käytit takseihin elokuussa 2026 yhteensä 30,97 €.** Evidence opens **MRC-TRN-0063**, **26.8.2026**, **−30,97 €**, taxi. September dining reduction of 20% produces **159,58 €**. |
| Public entry and keyboard | Passed for `/`, `/access`, `/demo/banks`, the four bank-rehearsal tabs, and skip-link focus before/after hydration. Private session responses and the bank list are mocked; external requests are blocked. |
| Separate browser journey without request interception | Passed on `/demo?dataset=organizer1`, using actual Settings, Finnish selection, default enabled Privacy mode, submission and evidence dialog. Actual `/api/chat` returned 200, `source: rule`, `evaluation: privacy_rule`, and the matching build revision. No page errors. This used bundled organizer records, not a bank connection or hosted model. |
| Production voice regression | **33 passed** in Finnish, Estonian and English, on the same production server. Recognition, microphone, synthesis, audio playback and hosted voice responses are **mocked**. Actual local-rule chat supplies the visible answers. Editable drafts, denial/missing support, cancellation, late events and privacy behavior passed. No physical phone, acoustic input/output or live provider was tested. |
| HTTPS presentation | Local ngrok API reports `https://trophy-ranged-precook.ngrok-free.dev` → `http://127.0.0.1:33110`. Both the local target and the actual public HTTPS URL return HTTP 200 with **old build `67ac6e2-ed13e83c7106f026`**. The external response was confirmed at **14:52:19 EET** using curl outside the sandbox, with `ngrok-skip-browser-warning: 1`. |
| External availability boundary | **Confirmed for application HTML over HTTPS**, including its build header. Initial sandbox curl/Chrome and the external web reader were blocked; the successful retry used elevated Windows Command Prompt. A physical phone, an ordinary browser's ngrok visitor-warning flow, and public chat/voice calls were not tested. |

Commands actually run from the test checkout, against the integrated production server:

```powershell
$env:MONEYLENS_DEMO_TEST_ORIGIN = 'http://127.0.0.1:53612'
npx playwright test --config tests/config/playwright.demo.config.ts
# 15 passed
$env:MONEYLENS_VOICE_TEST_PORT = '53612'
npx playwright test --config tests/config/playwright.voice.config.ts
# 33 passed; this directly selects the production server, not the dev-server runner
```

Screenshots and the additional unmocked browser probe are ignored under `test-results/presentation/`; presentation-suite screenshots are under `test-results/demo/`. Dependencies were reused through an ignored local `node_modules` junction. No keys, bank, database or identity service were needed.

The successful external check was `curl.exe --max-time 25 -sS -H ngrok-skip-browser-warning:1 -D - -o NUL https://trophy-ranged-precook.ngrok-free.dev/demo?dataset=organizer1`, executed outside the sandbox through Windows Command Prompt. The coordinator message tool rejected delivery with `already has an active writer`; this file preserves the full handoff.

## Coordinator: serve the integrated build through the existing HTTPS link

Keep the existing ngrok tunnel targeting **33110**. Replace its old local server with the integrated main web application. Run these commands in the integrated repository root, not in `frontend/coach` or the prototype directory.

1. Identify the current listener before stopping it. At verification time PID 39116 owned 33110; PIDs can change. Prefer Ctrl+C in the terminal that owns the old presentation server. If that terminal is unavailable, inspect the current listener and its command before using `Stop-Process -Id $presentationPid`. Do not stop the ngrok agent or unrelated Node processes.

   ```powershell
   $presentationPid = (Get-NetTCPConnection -State Listen -LocalPort 33110).OwningProcess
   Get-CimInstance Win32_Process -Filter "ProcessId = $presentationPid" |
     Select-Object ProcessId, ParentProcessId, CommandLine
   # Only after confirming this is the old presentation server:
   # Stop-Process -Id $presentationPid
   ```

2. With that listener stopped, prepare and serve the main web production build in a separate build directory. This leaves the tested artifact and other integrated previews intact. The named directory below was unused at verification time; choose another unused name for a later rehearsal.

   ```powershell
   $env:MONEYLENS_NEXT_DIST = '.next/presentation-20261114'
   if (Test-Path "frontend/web/$env:MONEYLENS_NEXT_DIST") { throw 'Choose an unused presentation build directory' }
   $env:MONEYLENS_API_URL = 'http://127.0.0.1:9'
   $env:MONEY_COACH_PUBLIC_GEMINI_ENABLED = 'false'
   $env:MONEY_COACH_LOCAL_AI_EVALUATION = 'false'
   $env:MONEY_COACH_GEMINI_VOICE_ENABLED = 'false'
   npm run build:web
   if ($LASTEXITCODE -ne 0) { throw 'Web production build failed' }
   Get-Content "frontend/web/$env:MONEYLENS_NEXT_DIST/BUILD_ID"
   node node_modules/next/dist/bin/next start frontend/web --hostname 127.0.0.1 --port 33110
   ```

   The explicit disabled flags keep this rehearsal on local rules and browser speech. This command does not load the root `.env`. If no source or build changed, the already tested production artifact can instead be started directly with the same server command and environment, after stopping the old listener and removing `Env:MONEYLENS_NEXT_DIST`; no rebuild is required. Never use the standalone Coach build for the main `/demo` route.

3. In a second terminal, compare the **running HTTP response** with the build artifact and the public HTTPS response. A changed commit or generated worker can produce a different expected ID; read it rather than hardcoding the old verified ID.

   ```powershell
   $presentationDist = '.next/presentation-20261114' # Must match the server terminal; '.next' for the existing tested artifact
   $expectedBuild = (Get-Content "frontend/web/$presentationDist/BUILD_ID" -Raw).Trim()
   $local = Invoke-WebRequest 'http://127.0.0.1:33110/demo?dataset=organizer1'
   if ($local.Headers['X-MoneyLens-Build'] -ne $expectedBuild) { throw 'Wrong local build' }
   $tunnels = Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels'
   $tunnels.tunnels | Select-Object public_url, @{Name='target';Expression={$_.config.addr}}
   $public = Invoke-WebRequest 'https://trophy-ranged-precook.ngrok-free.dev/demo?dataset=organizer1' -Headers @{'ngrok-skip-browser-warning'='1'}
   if ($public.Headers['X-MoneyLens-Build'] -ne $expectedBuild) { throw 'Wrong public build or tunnel warning page' }
   $public.StatusCode
   $public.Headers['X-MoneyLens-Build']
   ```

   Both responses must be 200 with the same expected build. If the tunnel URL/target changed, use the current ngrok API values and correct the target before sharing the link. A warning/interstitial page is not application availability. Header bypass above checks the application; also open the ordinary phone link and complete any ngrok visitor warning.

4. Repeat the two test commands above with origin `http://127.0.0.1:33110` and voice port `33110`, then perform the physical phone trial below. Close old app tabs and use a fresh browser session; if an installed app still shows an older version, close its windows and clear this site's stored data/service worker before retrying. Saved language/profile and offline assets can otherwise obscure a server change. Keep the final expected build ID with the rehearsal result.

## One-minute physical phone trial

1. Open `https://trophy-ranged-precook.ngrok-free.dev/demo?dataset=organizer1` in the phone browser after the coordinator verifies the build. Choose **Settings → Suomi**. Keep **Yksityisyystila** enabled, choose browser speech if a voice provider selector appears, then return with **Takaisin**. Overview must show September 2026, snapshot **30.9.2026**.
2. Open **Coach**, tap **Puhesyöte**, allow the microphone and say **Paljonko käytin takseihin viime kuussa?** Tap **Lopeta kuuntelu** if needed. Confirm the transcript remains editable and has not sent itself; correct it, then send. Expect **Käytit takseihin elokuussa 2026 yhteensä 30,97 €.**
3. Tap **Lue ääneen**. Listen for the same visible sentence in Finnish, then test **Lopeta lukeminen** and start reading again. Tap **MRC-TRN-0063** and check **26.8.2026**, **−30,97 €**, taxi.
4. If local Finnish recognition or a suitable local voice is unavailable, record that result and the phone/browser version. Type the question to finish the evidence check. Optionally try the keyboard's Finnish dictation, recording it separately as OS/keyboard dictation; it does not verify the app microphone button. Keep Privacy mode enabled for this trial.

This phone trial is a procedure to execute, not a claimed device result.
