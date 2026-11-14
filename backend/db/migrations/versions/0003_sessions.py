"""Separate identity authority from scoped financial database access."""
from alembic import op

revision = "0003_sessions"
down_revision = "0002_durable_jobs"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='moneylens_auth') THEN
        CREATE ROLE moneylens_auth NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='moneylens_auth' AND
          (rolsuper OR rolinherit OR rolcanlogin OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
          OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='moneylens_auth') THEN
        RAISE EXCEPTION 'moneylens_auth must be an unprivileged NOLOGIN group without memberships';
      END IF;
    END $$""")
    op.execute("ALTER TABLE moneylens.users ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false, ADD COLUMN display_name text NOT NULL DEFAULT 'Member'")
    op.execute("CREATE INDEX identity_subject ON moneylens.users (subject_issuer,subject_id) WHERE active")
    op.execute("GRANT USAGE ON SCHEMA moneylens TO moneylens_auth")
    op.execute("GRANT SELECT ON moneylens.users TO moneylens_auth")
    op.execute("CREATE POLICY identity_authority_read ON moneylens.users FOR SELECT TO moneylens_auth USING (true)")
    op.execute("CREATE SCHEMA moneylens_identity")
    op.execute("REVOKE ALL ON SCHEMA moneylens_identity FROM PUBLIC")
    op.execute("GRANT USAGE ON SCHEMA moneylens_identity TO moneylens_auth")
    op.execute("""CREATE TABLE moneylens_identity.sessions (
      token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      id uuid NOT NULL UNIQUE, tenant_id uuid NOT NULL, user_id uuid NOT NULL,
      permission_version bigint NOT NULL CHECK (permission_version>0),
      created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL, revoked_at timestamptz,
      FOREIGN KEY (tenant_id,user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE,
      CHECK (expires_at>created_at)
    )""")
    op.execute("CREATE INDEX sessions_expiry ON moneylens_identity.sessions (expires_at)")
    op.execute("CREATE INDEX sessions_owner ON moneylens_identity.sessions (tenant_id,user_id)")
    op.execute("""CREATE TABLE moneylens_identity.login_states (
      state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
      binding_hash text NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
      issuer text NOT NULL, client_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
    )""")
    op.execute("CREATE INDEX login_states_expiry ON moneylens_identity.login_states (expires_at)")
    for table in ("sessions", "login_states"):
        op.execute(f"ALTER TABLE moneylens_identity.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE moneylens_identity.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY identity_authority ON moneylens_identity.{table} TO moneylens_auth USING (true) WITH CHECK (true)")
        op.execute(f"GRANT SELECT,INSERT,UPDATE,DELETE ON moneylens_identity.{table} TO moneylens_auth")


def downgrade():
    op.execute("DROP SCHEMA moneylens_identity CASCADE")
    op.execute("DROP POLICY identity_authority_read ON moneylens.users")
    op.execute("REVOKE SELECT ON moneylens.users FROM moneylens_auth")
    op.execute("REVOKE USAGE ON SCHEMA moneylens FROM moneylens_auth")
    op.execute("DROP INDEX moneylens.identity_subject")
    op.execute("ALTER TABLE moneylens.users DROP COLUMN is_synthetic,DROP COLUMN display_name")
