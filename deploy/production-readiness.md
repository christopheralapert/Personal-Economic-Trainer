# Release checks, not a production sign-off

The application is a synthetic financial-coaching prototype. Passing builds or
mocked provider tests does not certify a banking service. Keep personal bank
files out of the public demo and never expose the signed local test issuer.

## Safe configuration and connectivity check

From the repository root in an authorized PowerShell terminal:

```powershell
node --env-file-if-exists=.env scripts/release_readiness.mjs
# Optional credential-free HTTPS HEAD probes; no inference or audio is generated.
node --env-file-if-exists=.env scripts/release_readiness.mjs --probe
```

The output contains setting names and sanitized statuses, not setting values,
keys, statements or provider response bodies. A configured key is explicitly
`configured_not_verified`. Exit 1 means a configuration/connectivity blocker;
exit 0 is not approval of manual checks. This evaluates the supplied environment,
not a running process: preview launchers supply additional admission settings.

Real Auth0 needs the actual server-only `MONEYLENS_OIDC_ISSUER`,
`MONEYLENS_OIDC_CLIENT_ID`, `MONEYLENS_OIDC_CLIENT_SECRET`,
`MONEYLENS_OIDC_AUTHORIZATION_URL`, `MONEYLENS_OIDC_TOKEN_URL` and
`MONEYLENS_OIDC_JWKS_URL`. Configure the tenant's allowed callback as
`<approved app origin>/api/v1/auth/callback` and its logout/allowed origins for
that same app. Keep restricted finance/identity database connections, session
secret and ordinary authentication enabled. Use `deploy/local-setup.md` for the
existing readers and production configuration checks. Add credentials directly
to ignored configuration, never to a ticket, screenshot or test artifact.

After configuration, verify normal login with two actual Auth0 users, repeat
login, logout/session expiry and owner isolation; record the build and issuer
configuration privately without tokens. The offline signed test issuer proves
protocol and provisioning behavior, not Auth0 tenant configuration.

## Before exposing a deployment

| Control | Required evidence |
| --- | --- |
| Real identity and session boundary | Normal sign-in, signature/issuer/audience/nonce/PKCE rejection, blocked-member denial; secure cookies, CSRF and logout on the approved HTTPS origin |
| Workspace isolation | Two real users; account switching, Back/reload, transaction URLs and import previews never expose the previous user |
| Test features disabled | Ordinary server must not expose the test chooser, `/rehearsal/*`, or a development demo session |
| Privacy and data minimization | Zero hosted chat/transcription/audio/translation under Privacy, including cancellation; no raw bank rows, account IDs or statements in provider payloads/logs |
| Public inference limits | Finite durable operation/rate caps, private absolute ledgers, origin allowlist and server-only keys; verify denial without a configured allowance. Multiple replicas need one correctly shared admission store or a single-instance deployment; independent local files are not a global cap |
| Actual billing protection | Configure provider-side project quotas/billing limits and alerts. Local reservations are not the provider's invoice and do not guarantee a spend ceiling |
| Secrets and dependencies | Secret scan, credential rotation procedure, dependency review, TLS termination and least-privilege database identities |
| Retention and recovery | Approved statement/preview retention and deletion policy, encrypted backups, tested restore, key custody and recovery owner |
| Operational ownership | Health/error monitoring without financial payloads, incident contacts, rollback and restore drills, explicit deployment approval |

Never delete usage ledgers to reset allowance. Review abandoned locks after a
process failure rather than clearing them automatically. Keep Gemini default;
the separate Nemotron experiment previously failed repeatability/correctness and
is not approved as the production default.

## Backup and restore rehearsal

Do not test a restore against the running app database. Use a disposable
PostgreSQL database and synthetic rows only. PostgreSQL client tools or a
controlled PostgreSQL container must be available. Keep credentials in a private
PostgreSQL service/password configuration; do not put connection URLs/passwords
in command arguments, logs or Git.

1. Create a uniquely named synthetic source database, apply `alembic upgrade head`,
   and import two accounts under two signed test identities using the existing
   isolated fixture. Keep the source app online while measuring backup impact.
2. With the operator's private service configuration, make a custom-format
   `pg_dump --format=custom --file <private backup path> --dbname <test source service>`.
   Use an access-restricted encrypted destination, outside tracked source.
   Include database roles/grants and the encryption/session key recovery plan;
   a schema-only export is not a complete backup.
3. Create a fresh, uniquely named destination and run
   `pg_restore --exit-on-error --dbname <empty test destination service> <backup>`.
   Never use `--clean` or restore to the source. Recreate required global roles
   through the approved migration/role procedure, without logging password hashes.
4. Compare migration head, row counts, exact cent totals, account ownership,
   confirmed category corrections and re-import receipts. Run RLS checks using
   restricted runtime roles, not the administrator. Verify blocked users remain
   blocked and the second user cannot read the first user's rows.
5. Record backup and restore durations, recovery point/time objectives, backup
   checksum, key recovery and the retained backup's expiry privately. Remove only
   the exact disposable destination and fixture resources after reviewing targets.

The local migration tests are not a backup/restore proof. No restore, retention
policy or production security certification is claimed by this guide.

## Physical-device and user review

Use the exact final build through an approved secure context on a real device;
emulated WebKit and mocked audio do not qualify. The existing public HTTPS demo
is intentionally not updated by this work. Localhost on a phone means the phone
itself: use an approved device port-forward or separately authorized HTTPS
preview rather than guessing the PC's localhost URL.

Record device, OS, browser, build ID, language and selected voice provider:

- With Privacy off, dictate an organizer taxi question, stop, edit the draft and
  Send once. Check amount, period, actual provider attribution and open evidence.
- Tap Listen explicitly, measure first audible playback, stop during preparation
  and playback, and verify the audio refers to the pressed answer. Record Gemini
  audio separately from device synthesis. A successful HTTP envelope is not audio.
- Enable Privacy during pending text/audio. Verify no further hosted calls,
  no late answer/audio application and usable text input. If confirmed on-device
  recognition/synthesis is absent, expect the explanation, not silent cloud use.
- Deny microphone permission, retry where the OS permits, background/foreground
  the app, install through the browser's native PWA option, then relaunch. Check
  offline shell behavior without caching private pages or generated model replies.

For a short user study, ask at least three new participants to complete:
anonymous sample import, find both October transactions, ask taxis (€30.97),
open organizer1 and identify the biggest spending category, and try September's
20% dining scenario (€159.58). Record completion/time/confusion and ask each
person to explain one next action and why incomplete records are not a complete
budget. Obtain consent and keep notes anonymous and outside Git. Record actual
observations; this protocol is not a completed user study.
