"""Encrypted read-only live AIS session ids with strict per-user RLS.

The application cannot create this table at runtime. No raw bank access token,
provider session ID or OAuth code is stored in plaintext.
"""
from alembic import op

revision="0020_live_banking"
down_revision="0019_merge_import_privacy"
branch_labels=None
depends_on=None


def upgrade():
    op.execute("""CREATE TABLE moneylens.live_bank_sessions (
        tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, connection_id uuid NOT NULL,
        encrypted_session_id text NOT NULL CHECK(length(encrypted_session_id) BETWEEN 50 AND 4096),
        refresh_token uuid, refresh_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(tenant_id,owner_user_id,connection_id),
        FOREIGN KEY(tenant_id,owner_user_id,connection_id) REFERENCES moneylens.connections(tenant_id,owner_user_id,id) ON DELETE CASCADE
    )""")
    op.execute("""CREATE UNIQUE INDEX one_open_live_bank ON moneylens.connections
        (tenant_id,owner_user_id,provider) WHERE provider_mode IN ('sandbox','live') AND provider LIKE 'enable:%'
        AND consent_state IN ('requested','authorizing','active')""")
    op.execute("ALTER TABLE moneylens.live_bank_sessions ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE moneylens.live_bank_sessions FORCE ROW LEVEL SECURITY")
    op.execute("""CREATE POLICY live_bank_session_owner ON moneylens.live_bank_sessions TO moneylens_runtime
        USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
        AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
        WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
        AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)""")
    op.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON moneylens.live_bank_sessions TO moneylens_runtime")


def downgrade():
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM moneylens.live_bank_sessions)
        THEN RAISE EXCEPTION 'Explicitly revoke and erase live bank sessions before rollback'; END IF; END $$""")
    op.execute("DROP INDEX moneylens.one_open_live_bank")
    op.execute("DROP TABLE moneylens.live_bank_sessions")
