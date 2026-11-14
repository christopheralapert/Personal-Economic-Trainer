# Main demo voice review

Run `npm run test:web:voice` from the repository root. The suite uses the main application's `/demo?dataset=organizer1` entry point at phone width, a free local server port, synthetic records, and mocked speech APIs. It checks editable drafts, exact visible read-aloud sentences, permission denial, absent recognition/local language support, remote-only or absent synthesis voices, cancellation, and privacy enforcement. It does not establish physical microphone accuracy, installed device language packs, sound quality, or live provider availability.

Verified commands:

- `npm run test:web:voice`: 33 browser tests passed; the server used a free loopback port and stopped after the suite.
- `npm exec --workspace @moneylens/coach -- vitest run src/voice/routes.test.ts src/coach/spoken-answer.test.ts`: 16 unit tests passed using a mocked provider transport.
- `npm run typecheck`: both applications passed.
- `npm run test:structure`: 8 tests passed.
- The new browser test, mock helper, and configuration also passed a separate TypeScript check.

## Interruption fix

Previously, interrupted browser speech and hosted audio could deliver late completion or error events after the user had started another reading. This changed the new reading's button back to idle and could show an incorrect failure message while audio was still playing. Browser playback now invalidates callbacks on stop, unmount, and completion; hosted playback accepts events only from the current uncancelled request. Regression tests start, stop, and restart both playback paths, deliver stale completion and error events, and check that only the current playback can finish.

## Coordinator reproduction: Estonian taxi inflection

The speech components accept the Estonian draft correctly, but the shared Coach grammar rejects the natural plural form **taksodele**. The voice suite uses the supported form **taksole** to exercise speech independently. No shared conversation or translation file was changed in this voice review.

1. Open the main web application's `/demo?dataset=organizer1` in a clean browser session.
2. Select Estonian in Settings, keep Privacy mode enabled, and return to Coach.
3. Type or dictate `Kui palju kulutasin taksodele eelmisel kuul?` and send it.
4. `/api/chat` returns HTTP 200 with `X-Money-Coach-Evaluation: privacy_rule`.
5. The visible `[data-spoken-answer]` is `Vali sobiv periood või vähendus 0–100%. Puuduvaid andmeid ei oletata.`

Expected: the answer identifies taxi spending for August 2026 as **30,97 €**, as it does for `Kui palju kulutasin taksole eelmisel kuul?` and Finnish `Paljonko käytin takseihin viime kuussa?`.

The relevant selector list is `categoryAliases` in `frontend/coach/src/coach/query-language.ts`: it contains `taksole` but lacks `taksodele`. Coordinate the alias and parser regression test with the Coach workstream. This is independent of the browser speech language setting (`et-EE`) and also reproduces with typed text.

The attempts to deliver this reproduction to the coordinator and Coach task through the task messaging tool returned `already has an active writer`; this document preserves the handoff in the local commit.
