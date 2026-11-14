# Mobile interface and Learn checks

The shared mobile interface now uses consistent category colours, labelled basket rows, grouped settings, one selected simulator category, and clearer answer hierarchy. Both demo and private Learn pages provide six expandable lessons in English, Finnish and Estonian, with a practical next step and an explicit Coach action. Reading a lesson does not send a model request.

Demo lessons use the selected synthetic period and local reading markers. Basket evidence retains the basket and dates; the habit question uses its displayed category. Private Learn uses authenticated stored-record totals, an account selector and calendar-month navigation. Its transaction and Coach links preserve account and dates; reading progress stays in memory. Loading, retry and missing-data states do not manufacture a budget or saving allowance. Truncated category breakdowns do not become basket facts. Empty chart answers withhold the headline rather than implying zero spending.

## Repeatable checks

- `npm run typecheck`
- `npm test`
- `npm run build:coach`
- `npx playwright test --config frontend/coach/playwright.config.ts`
- `npm run test:structure`
- `npm run test:worker`
- Build the main web workspace, then `npm run test:web:redesign`.

`MONEYLENS_REDESIGN_TEST_ORIGIN` can attach the last command to an existing loopback production preview. Without it, the configuration allocates an unused loopback port and starts the main web build. `MONEYLENS_NEXT_DIST` selects an isolated build directory when needed. The suite covers Learn, keyboard focus, translated demo answers and evidence, Coach, classification, and mocked speech. Its visual/accessibility sweep covers 390px and 1280px, light/dark, and all four main demo tabs. The separate standalone browser suite also exercises offline installation and worker update behaviour.

The seven `wise-statement.spec.ts` cases require the opt-in `tests/integration/test_wise_browser.py` harness with temporary PostgreSQL, a production web build and signed synthetic OIDC. An ordinary UI run skips these rather than pretending to test persistence. That harness verifies CSV, selectable-text PDF, XLSX, CAMT.053 XML, MT940 and QIF, repeated/cross-format imports and owner isolation.

All financial fixtures in these checks are synthetic. Private UI-only tests mock HTTP responses; the Wise harness uses the real database and application server with a test identity provider. Speech and hosted audio tests mock browser/provider capabilities. No paid Gemini call or physical-device microphone test is claimed by this interface work. The existing `.env`, public presentation mode and signup worktree are unchanged.
