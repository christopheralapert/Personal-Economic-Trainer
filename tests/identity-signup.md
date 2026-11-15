# Identity self-service signup

`MONEYLENS_OIDC_SELF_SIGNUP_ENABLED` defaults to `false`. With the flag off, existing invitation-only behavior remains in effect. With it on, a successful server-verified OIDC code exchange can create an empty private tenant, member and user state before issuing the opaque session cookie. The exact configured issuer and verified `sub` identify the member; email, browser-supplied owner IDs and profile claims do not select a workspace.

Apply all migrations with `alembic -c backend/db/alembic.ini upgrade head` before enabling the flag; the current single head is `0029_automatic_classification`, which includes the identity/statements merge. The identity database role can execute a narrow function, without direct tenant/user/state write privileges or financial read access. Creation and session insertion share one transaction. The function serializes with all membership writers, including the administrator invitation script; its table lock lasts until the short login transaction commits. Existing disabled, synthetic, ambiguous or incomplete mappings are rejected without repair or reactivation. Blocking a previously created member continues to invalidate its existing sessions.

## Deployment opt-in

The disabled placeholder is included in `.env.example`; enable it only for the API after applying the integrated migrations:

```dotenv
# Create a private empty workspace after server-verified OIDC login.
MONEYLENS_OIDC_SELF_SIGNUP_ENABLED=false
```

The API process reads this setting. Enabling it requires `MONEYLENS_AUTH_ENABLED=true`, both restricted database URLs, the session secret and all six pinned OIDC endpoint/client settings. The usual issuer, audience, RS256 signature, freshness, nonce, PKCE and single-use browser-bound state checks run before creation. The frontend does not read or control this flag. Never place migration credentials in the API or frontend environment.

## Verification

From the repository root, with Docker available and the Python requirements installed:

```powershell
./scripts/test_identity_self_signup.ps1 -Python ./.venv/Scripts/python.exe
```

The runner starts its own PostgreSQL 17.6 container on an automatically assigned loopback port and removes that exact container in `finally`. The existing database fixture migrates a unique database, uses separate restricted identity/runtime roles and removes them afterwards. The OIDC test provider uses an offline HTTP transport with real RSA-signed tokens, PKCE, nonce and single-use authorization codes; it does not contact Auth0. Backend HTTP login/callback, session, account and dashboard routes execute through FastAPI's test client. No browser or live provider is exercised by this suite.

The suite checks repeated and simultaneous first login, a concurrent administrator invitation, disabled-member denial and existing-session rejection, legacy conflicts, opt-in behavior, invalid signatures/claims, state binding/replay, exact issuer separation, database privilege boundaries, rollback after state/session insert failures and two new members' account/data isolation under RLS.

The integrated API intentionally returns its existing generic HTTP 500 `INTERNAL_ERROR` for the injected database-write failures. Tests assert that response, no session and no partial workspace; they do not expect a raw PostgreSQL exception to escape the middleware.

## Integrated browser verification

See [the combined signup and statements report](../docs/verification/signup-statements-review.md). `tests/browser/signup-statements.spec.ts` runs against a fresh loopback-only self-signup rehearsal with two non-provisioned signed test identities; it never targets Auth0. Set `MONEYLENS_SIGNUP_BROWSER_ORIGIN` to that server and `MONEYLENS_SIGNUP_STATEMENT_FIXTURES` to generated synthetic fixture files, then run `npx playwright test --config tests/config/playwright.signup-statements.config.ts`. Hosted calls remain opt-in via `MONEYLENS_SIGNUP_LIVE_GEMINI=true`; without it, answers use Privacy mode's local rules. This is a destructive-data-free test setup, not a production identity provider.

To use an already isolated administrator database instead, set `MONEYLENS_TEST_DATABASE_URL` in the current process and run:

```powershell
python -m pytest -c backend/api/pyproject.toml tests/api/test_self_signup_settings.py tests/api/test_oidc.py tests/integration/test_self_signup.py tests/integration/test_identity.py tests/integration/test_invited_members.py tests/integration/test_membership_fence.py
```
