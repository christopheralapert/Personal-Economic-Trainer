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

The merged Wise integration fixture collected successfully. A subsequent recheck explicitly enabled `MONEYLENS_STATEMENT_BROWSER_TEST=true` and invoked it: **1 skipped**, because `MONEYLENS_TEST_DATABASE_URL` is unset. Its database-backed execution was therefore **not** repeated here. No dedicated PostgreSQL runtime was found; Docker's local service was stopped and was not started. The workstream's prior verification is documented separately in the test guide. No real bank, identity provider, or model integration was exercised in this combined run.

## Recheck of the completed agent branches

All four requested commits passed `git merge-base --is-ancestor <commit> HEAD`; no additional merge was necessary. `package.json` still contains `test:demo`, `test:web-coach`, and `test:web:voice`, with the merged test guide documenting all three workflows plus the separate Wise fixture. `frontend/web/AGENTS.md` is byte-for-byte unchanged from `b831788`.

Both builds and application type checks were repeated successfully on the integrated code at `96ba2d3`. The 1,152 selected checks in the table were rerun successfully, including all six keyboard regressions, the natural Estonian taxi question with `X-Money-Coach-Evaluation: privacy_rule`, 33 mocked voice cases, and main/standalone offline PWA checks. The explicitly attempted database-backed Wise test is the separate skip above, not included in that pass total. Browser test and configuration files were also checked with strict TypeScript independently of the app projects.

Local demo preview: `http://127.0.0.1:33118/demo?dataset=organizer1`. Start the production web build with `node node_modules/next/dist/bin/next start frontend/web --hostname 127.0.0.1 --port 33118`, keeping hosted chat/voice/evaluation disabled and provider keys empty. This synthetic demo does not require the private API or PostgreSQL. The URL is loopback-only, not a public deployment. Port 33110 was occupied; its existing service was left untouched.

## Instructions and hook diagnostics

`git ls-tree -r --name-only 4c2202e -- AGENTS.md .agents .codex` returned no tracked instruction files. `.agents/AGENTS.md` is local and ignored, so Git worktrees do not receive it. Integration includes `frontend/web/AGENTS.md` from the Coach commit: it is the Next.js-generated guide, not a root instruction file.

No active Git hooks or configured `core.hooksPath` were found; `.git/hooks` contains sample files only. Codex has Impeccable post-tool/stop hooks configured in the installed plugin's `hooks/hooks.json`. Plugin lifecycle hooks are separate tooling, documented in [OpenAI's plugin guide](https://developers.openai.com/plugins/build/plugins).

The configured launcher's actual `hook` subcommand was invoked locally, not just inferred from the context-loader failure. It exited **127** with:

```text
impeccable: engine 0.1.5 is not installed; cannot create cache directory:
"C:\Users\chris\.impeccable\bin\0.1.5"
```

The launcher requires the missing engine and write/network permission for first-time setup. Existing project guidance was read directly instead. No engine was installed, hook disabled, or plugin configuration changed. The effect is that the automatic Impeccable design detector did **not** run; builds, type checks, and the explicit application tests above all ran independently and passed. Relevant Codex SQLite/daemon logs were inspected read-only; the original reported warning's individual event was not retained there, so this reproduction establishes the current configured-hook failure without claiming every historical warning had the same cause.
