"""Administrator-only invitation setup. Never imported by the web/API runtime."""
import argparse
import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from dotenv import dotenv_values
import psycopg

ROOT = Path(__file__).resolve().parents[1]


class ProvisioningError(Exception):
    """Fixed operator guidance; never a connection string or identity payload."""


def provision_member(connection, *, issuer, user_id, expected_issuer):
    """Return created/already_ready; all changes commit or roll back together."""
    parsed = urlsplit(issuer)
    if (issuer != expected_issuer or parsed.scheme != "https" or not parsed.netloc
        or parsed.username or parsed.password or parsed.query or parsed.fragment
        or not isinstance(user_id, str) or not 1 <= len(user_id) <= 2000
        or any(ord(c) < 32 or ord(c) == 127 for c in issuer + user_id)):
        raise ProvisioningError("Use the exact configured HTTPS issuer and verified Auth0 User ID; do not use an email address or token.")
    with connection.transaction():
        role = connection.execute("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user").fetchone()
        if not role or not role[0]:
            raise ProvisioningError("Use the existing administrator migration connection, never a web runtime or identity login.")
        if connection.execute("SHOW transaction_isolation").fetchone()[0] != "read committed":
            raise ProvisioningError("Use a fresh read-committed administrator connection for safe invitation setup.")
        connection.execute("SET LOCAL lock_timeout='5s'")
        connection.execute("SET LOCAL statement_timeout='15s'")
        # Global identity lookup must not hide disabled rows behind RLS. This
        # table lock also serializes concurrent provisioning/manual INSERTs.
        connection.execute("LOCK TABLE moneylens.users IN SHARE ROW EXCLUSIVE MODE")
        rows = connection.execute("""SELECT tenant_id,id,active,is_synthetic FROM moneylens.users
            WHERE subject_issuer=%s AND subject_id=%s LIMIT 2""", (issuer,user_id)).fetchall()
        if rows:
            if len(rows) != 1 or not rows[0][2] or rows[0][3]:
                raise ProvisioningError("Conflicting, disabled or synthetic membership exists. No changes made; administrator review required.")
            state = connection.execute("SELECT count(*) FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s", rows[0][:2]).fetchone()[0]
            if state != 1:
                raise ProvisioningError("Existing membership has incomplete state. No changes made; administrator review required.")
            return "already_ready"
        tenant, member = uuid4(), uuid4()
        connection.execute("INSERT INTO moneylens.tenants (id,name) VALUES (%s,'Money Coach private')", (tenant,))
        connection.execute("""INSERT INTO moneylens.users
            (tenant_id,id,subject_issuer,subject_id,is_synthetic,display_name)
            VALUES (%s,%s,%s,%s,false,'Money Coach member')""", (tenant,member,issuer,user_id))
        connection.execute("INSERT INTO moneylens.user_state (tenant_id,owner_user_id,id) VALUES (%s,%s,%s)", (tenant,member,uuid4()))
        return "created"


def main():
    parser = argparse.ArgumentParser(description="Set up one invited Money Coach member from a verified Auth0 identity. No bank access is granted.")
    parser.add_argument("--issuer", required=True, help="Exact configured OIDC issuer, including any trailing slash")
    parser.add_argument("--user-id", required=True, help="Exact verified User ID from Auth0 User Management, not an email or token")
    parser.add_argument("--admin-env-file", type=Path, default=ROOT / ".cache/admin-invitations.env",
        help="Administrator-only env file; default is the ignored .cache/admin-invitations.env, never loaded by the web runtime")
    args = parser.parse_args()
    # Only the non-secret issuer comes from the shared application .env.
    # Migration credentials must not be inherited by frontend/API launchers.
    url = os.environ.get("MONEYLENS_MIGRATION_DATABASE_URL")
    if not url and args.admin_env_file.is_file():
        url = dotenv_values(args.admin_env_file).get("MONEYLENS_MIGRATION_DATABASE_URL")
    expected = os.environ.get("MONEYLENS_OIDC_ISSUER")
    if not expected:
        expected = dotenv_values(ROOT / ".env").get("MONEYLENS_OIDC_ISSUER")
    if not url or not expected:
        parser.exit(1, "Configure the migration URL in the separate administrator env file/process, and the pinned issuer in the existing application settings.\n")
    try:
        with psycopg.connect(url) as connection:
            outcome = provision_member(connection, issuer=args.issuer, user_id=args.user_id, expected_issuer=expected)
    except ProvisioningError as exc:
        parser.exit(1, str(exc) + "\n")
    except Exception:
        parser.exit(1, "Access setup failed and was rolled back. Check administrator connectivity and migrated schema; credential details withheld.\n")
    print("Money Coach access created." if outcome == "created" else "Money Coach access is already set up. No changes made.")


if __name__ == "__main__":
    main()
