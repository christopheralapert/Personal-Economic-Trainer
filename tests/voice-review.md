# Main demo voice review

The phone flow uses the main web entry point `/demo?dataset=organizer1`. This work starts at integrated commit `32c5877` in worktree `agent/voice-polish`. Changes cover voice controls, composer integration, translations and tests. The Gemini text route and the main checkout's `.env` remain coordinator work.

## Integrated coordinator verification — 14 November 2026

Voice commit `bb02609` is merged with the saved-import/private-Coach work on **`integration/voice-import-next`**, source merge **`0d49b43`**. The isolated production artifact is `frontend/web/.next/voice-import-20261114`, **build `0d49b43-131377e695625033`**. The `money-coach.tsx` changes only add capture cancellation on typing and submission; the integrated request scope, privacy, skip-link focus, disclosures and saved ledger path are preserved. The README merge retained all existing test commands. No push was made.

On the integrated production server, **74 voice, 15 demo and 5 Coach browser tests passed**. An initial voice pass had 12 disclosure assertion failures because the Gemini-text-enabled server correctly displayed the combined question/voice notice rather than the audio-only notice. The test now requires exactly one of those two complete translated notices, visible before microphone access, and neither when Privacy mode is enabled. All 74 cases then passed with the local Gemini-text configuration; **74 voice and 15 demo tests also passed against the public presentation's 33110 listener** with hosted text/audio disabled. The financial answers in these suites remain local; hosted audio, recognition, synthesis and capture are mocked, with no live voice upload.

Also passed: both workspace typechecks, the separate voice browser/config TypeScript check, **954 API tests**, **26 database integration tests** (private Coach, EN/FI/ET answers, statement publication and opted-in Wise browser journey), **169 Vitest + 15 Node AI/PWA tests**, **54 main PWA tests**, **9 structure tests**, and **7 web utility tests**. Database tests use real isolated PostgreSQL; model-provider transports there are injected. Existing dependency deprecation/intentional forged-value warnings did not fail a check. The earlier full 439-test integration run is recorded in [the import/Coach review](import-coach-review.md); it is not represented as rerun here.

Exactly **two live `gemini-3.5-flash` text requests** were made in this integration round, after the regression pass:

| Ordinary browser journey | Real result and evidence | UI time |
| --- | --- | --- |
| `http://127.0.0.1:33119/demo?dataset=organizer1`, Suomi, Privacy off, “Paljonko käytin takseihin viime kuussa?” | HTTP 200, `source=model`, `provider=gemini-direct`, `evaluation=model_tool`. **Käytit takseihin elokuussa 2026 yhteensä 30,97 €.** Opened actual **MRC-TRN-0063**, **26.8.2026**, **−30,97 €**. | Question → visible sentence **1,298 ms**. |
| `http://127.0.0.1:33120/banks` → test identity **model-review** → fresh synthetic Wise CSV → View transactions → review categories → Ask Coach, Suomi, Privacy off, “Paljonko käytin takseihin lokakuussa 2026?” | A new preview was required, not an existing receipt. Both same-reference purchases, **−15.00 and −15.97 EUR**, persisted separately; exact repeat reused the receipt and retained reviews. HTTP 200, `source=model`, `provider=gemini-direct`, no fallback diagnostic. **Kirjattu nettokulutus oli 30,97 EUR ajalta 2026-10-01–2026-10-31.** The result was exactly **3,097 cents**; both evidence rows appeared and a transaction detail opened. | Confirm → first two visible ledger rows **227 ms**; question → visible sentence **1,428 ms**. |

Times are single Chrome observations at 390×844, not statistical or physical-phone benchmarks. Confirmation timing includes clicking **View transactions**. Private `Server-Timing`: **1,347.4 ms model wait**, **39.5 ms application**, **1,386.9 ms server total**; model wait includes network and Google's processing. Private import/session/CSRF/ownership/RLS/BFF/API and Google inference run for real, but the identity issuer is **signed offline OIDC, not real Auth0**. CSV expense categories were explicitly reviewed through the normal UI before the taxi question; unreviewed imported rows are not silently treated as classified expenses. There were no page errors or real-call `EACCES` failures. Re-enabling Privacy mode on the main demo returned `source=rule`, `evaluation=privacy_rule`, without a provider.

The existing ignored root `.env` was loaded by both local launchers. Checks passed for `GEMINI_API_KEY`, `MONEY_COACH_PUBLIC_GEMINI_ENABLED`, `MONEY_COACH_PUBLIC_AI_ORIGINS` and `MONEY_COACH_MODEL_USAGE_PATH`; the key and other settings were preserved without displaying them. The signup worktree and its separate database work remain untouched.

The **phone link** is **https://trophy-ranged-precook.ngrok-free.dev/demo?dataset=organizer1**. It now serves the same build as 33119; actual local and HTTPS `X-MoneyLens-Build` headers match the artifact. An ordinary unmocked Chrome visit completed the ngrok visitor warning, opened transaction evidence and had no page errors. The public default is Privacy on/device voice; even Privacy off returns `source=rule`, `evaluation=public_configuration`, with no provider. **Public Gemini text and Gemini audio remain OFF**; `/api/voice/capabilities` returned `enabled=false` over HTTPS. Provider keys are removed from that presentation process. Do not treat the mocked Gemini voice passes as a live-audio pass. The physical phone can now test device/browser speech; Gemini audio needs a separately enabled and checked presentation mode. Ngrok itself and the separate 33118 demo were not changed. Later test/documentation commits do not alter this artifact's source build ID.

A bounded screenshot review covered phone recording/playback in light/dark appearance and desktop; visible Stop/Cancel controls retain 48 px targets, the draft stays editable, and tested phone layouts had no horizontal document overflow. Actual phone microphone behavior, local language packs and acoustic quality are still unverified.

## Behavior

- The microphone sits beside the question field. Recording exposes visible Stop and Cancel buttons with at least 48 px touch targets: **Lõpeta** and **Tühista** in Estonian.
- Stop finishes capture and places the transcript in the editable field. Cancel preserves the previous draft, including when recognition already produced a result. Only Send submits the question.
- Typing or sending cancels pending capture/transcription. Old results cannot overwrite a newer draft. A microphone stream granted after cancellation is immediately released.
- Each answer has one **Kuula vastust** / **Listen to answer** / **Kuuntele vastaus** button, changing to **Peata** / **Stop** / **Pysäytä** during playback. Listening after Stop restarts the sentence. Recording interrupts playback; playback cancels capture.
- Privacy mode requires confirmed on-device recognition for the chosen language and a synthesis voice with `localService === true`. Missing support produces a short reason and leaves typing available. A saved Gemini preference cannot override Privacy mode.
- Outside Privacy mode, Gemini voice shows the recording disclosure before microphone access. `/api/voice/transcribe` fills the editable draft. `/api/voice/speak` derives speech from the authored financial sentence also used on screen. Changed answer selectors invalidate cached audio.

## Automated review

Run from the repository root after `npm ci`:

```powershell
npm run test:web:voice
npm run typecheck
npm run test:structure
npm exec --workspace @moneylens/coach -- vitest run src/voice/routes.test.ts src/coach/spoken-answer.test.ts
node node_modules/typescript/bin/tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --esModuleInterop --skipLibCheck --types node tests/browser/demo-voice.spec.ts tests/browser/voice-support.ts tests/config/playwright.voice.config.ts
```

The runner starts this worktree's main Next application on an OS-selected free loopback port, disables hosted services and provider keys, and stops its server afterward. It does not read the main checkout's `.env`. Chrome is used locally; CI uses Playwright Chromium.

Verified on 2026-11-14:

- Before changes: **33 browser tests passed**.
- Final voice journey: **74 browser tests passed**, including 24 EN/ET/FI × device/Gemini × 360/390 px × light/dark cases. Also covered playback restarts, cancellation, denied microphone permission, missing local languages/voices, stale events, pending permission and edited answer selectors. Final port: **12195**.
- Voice routes and spoken answers: **16 unit tests passed** with fake provider transport, checking EN/ET/FI language codes, exact sentences, privacy refusal, bounded uploads and provider errors. On Windows the successful command was `node ../../node_modules/vitest/vitest.mjs run src/voice/routes.test.ts src/coach/spoken-answer.test.ts` from `frontend/coach`, using cmd outside the filesystem sandbox because esbuild could not read its config there.
- Both application typechecks and the separate browser/config TypeScript check passed. **9 structure tests passed**.
- Recording and playback screenshots for all 24 phone combinations were visually reviewed, together with a 1440 px desktop capture. Phone captures are ignored under `.cache/voice-review/`; failures go to `test-results/voice/`.

The normal demo page, synthetic dataset, local financial tools, chat stream and rendered sentences run for real. Browser speech recognition, synthesis, microphone capture, playback and Gemini endpoint replies are mocked. Voice-handler tests use fake provider transport. **No physical microphone, real device voice, physical phone or live Gemini audio was used.** Accuracy, sound quality, language packs, mobile browser media behavior and live Gemini availability require the phone check.

## Physical phone check after integration

Use the coordinator's HTTPS preview with this commit integrated. Open `/demo?dataset=organizer1` in the phone's browser. Plain LAN HTTP is unsuitable for microphone access. The coordinator configures real Gemini audio; this work does not change `.env`. Before the Gemini pass, `/api/voice/capabilities` must report `enabled: true` and Settings must allow the Gemini voice choice.

Repeat for EN/ET/FI, in the phone's light and dark appearance. Check 360/390 CSS px where the device permits; automated tests cover both exact widths.

| Language | Dictate, then correct manually before sending |
| --- | --- |
| EN | How much did I spend on taxis last month? |
| ET | Kui palju kulutasin taksodele eelmisel kuul? |
| FI | Paljonko käytin takseihin viime kuussa? |

1. In Settings choose the language, enable Privacy mode and return to Coach. Tap the microphone beside the question field. If local recognition cannot be confirmed, expect the unavailable reason and verify that typing and sending still work. Do not count that as successful local dictation.
2. Where supported, allow the microphone, dictate the table's question and tap Stop. Confirm that the draft is editable and no new user message appears yet. Change a word, correct it, then Send. The August 2026 taxi answer must show **30,97 €**. Open the keyboard again and check that the composer and recording controls remain reachable.
3. Tap Listen to answer. Compare the heard sentence with the financial sentence visible on screen, including amount and month. Stop midway, then Listen again: the sentence must restart. Start dictation during playback: playback must stop.
4. Type a draft, record different words and Cancel. The typed draft must remain. Record again, then type while capture/transcription is pending. The recording must cancel and its late result must not replace the typed text. Repeat with a fresh dictation immediately afterward.
5. Deny microphone access in the phone's site permissions. Retry capture: expect a short denial message and usable typing. Restore permission for the next pass.
6. Turn Privacy mode off and select Gemini voice in Settings. Confirm that the notice about sending the recording to Gemini is visible **before** tapping the microphone. Record the same question, Stop, edit the returned transcript and explicitly Send. Compare Gemini playback to the visible sentence; stop and restart it. Cancel another recording and verify it creates no transcript request. Use remote browser debugging to inspect `/api/voice/transcribe` and `/api/voice/speak` traffic.
7. With Gemini selected, enable Privacy mode again. Hosted capture/playback must stop. Retrying speech must use confirmed device support or show the local-language reason, with no call to either audio endpoint. Typing must remain usable.
8. Ask `What if I cut taxis by 20% last month?`, listen once, then move the answer slider to 50%. The visible saving must change to **15,49 €**. Listen again and confirm the updated sentence is spoken. Record device, OS, browser version, language, provider, actual heard sentence and failures separately for device and Gemini audio.

If Gemini returns an unavailable/busy/allowance error, expect one short message and usable typing/reading. Record that as a live-integration failure; the mocked pass does not establish hosted-service availability.
