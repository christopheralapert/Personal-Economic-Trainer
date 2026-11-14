# Agent integration verification

Local branch: `integration/agent-results`, based on `4c2202e`. No push was performed; `main` was not changed.

Reviewed and merged with ancestry preserved:

| Workstream | Commit | Result |
| --- | --- | --- |
| Demo | `7d5f401` | Organizer entry links and Finnish presentation regressions |
| Coach | `b831788` | Bounded execution failures, visible transaction scope, multilingual chat tests |
| Imports | `e4ef3d8` | Wise file reselection and isolated signed-OIDC integration fixture |
| Voice | `ada0837` | Ignore stale playback events; multilingual mocked speech tests |

Merge conflicts were confined to `package.json` and `tests/README.md`; both sides' commands and guidance were retained.

## Coordinator fixes

The root skip link targets a focusable `main#main` in loading, error, and ready states. The main element stays mounted within MoneyCoach. Dataset planning can still remount the entire coach when its source clock changes; the persistent skip-link component restores only focus lost with a removed landmark. Keyboard and pointer choices made afterwards are not overridden. Six production-browser regressions cover ready and pre-hydration loading at 360px and 1280px, including a later keyboard focus choice.

The voice handoff's Estonian `taksodele` reproduction is fixed with an explicit category alias, a unit regression, and updated Coach/voice browser cases. Unsupported extra clauses remain rejected.

## Combined verification

Both production applications built with `npm run build`; `npm run typecheck` passed for both. Hosted services were disabled. Browser tests used local synthetic data and mocked speech, not real microphones or paid providers.

| Command or selection | Passed |
| --- | ---: |
| `npm test` | 168 Vitest + 15 Node tests |
| `npm run test:worker` | 54 |
| `npm run test:structure` | 9 |
| `npm run test:web-money` | 7 |
| `npm run test:release --workspace @moneylens/coach` | 5 |
| `npm run test:demo -- --reporter=line` | 15 |
| `npm run test:web -- tests/browser/foundation.spec.ts tests/browser/public-coach.spec.ts tests/browser/demo-voice.spec.ts --workers=1 --reporter=line` | 45 |
| Standalone coach Playwright selection `public PWA boots cold offline` | 1 |
| Database-free API pytest suite | 833 |

Total: **1,152 selected tests passed**, not a claim that every opt-in repository suite ran. Browser test/config files also passed a separate strict TypeScript check. API tests initially encountered shared Windows temporary-directory permissions; rerunning with `--basetemp=.cache/integration-api-tests -o cache_dir=.cache/integration-pytest-cache` passed. Existing deprecation/serializer warnings remain.

The merged Wise integration fixture collected successfully, but its database-backed execution was **not** repeated here: `MONEYLENS_TEST_DATABASE_URL` is unset. The workstream's prior verification is documented separately in the test guide. No real bank, identity provider, or model integration was exercised in this combined run.

## Instructions and hook diagnostics

`git ls-tree -r --name-only 4c2202e -- AGENTS.md .agents .codex` returned no tracked instruction files. `.agents/AGENTS.md` is local and ignored, so Git worktrees do not receive it. Integration includes `frontend/web/AGENTS.md` from the Coach commit: it is the Next.js-generated guide, not a root instruction file.

No active Git hooks or configured `core.hooksPath` were found; `.git/hooks` contains sample files only. Codex has Impeccable post-tool/stop hooks configured. Its launcher failed locally because engine `0.1.5` is absent and the external cache is not writable. This is a plausible source of the reported generic warning, but the original hook event was not available to attribute conclusively. Existing project guidance was read directly; no plugin configuration was changed. Git merges, builds, type checks, and the tests above completed independently of that optional tooling failure.
