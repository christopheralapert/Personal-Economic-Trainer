"""Scoped refresh receipts and bounded resumable source staging."""
from alembic import op

revision = "0009_bank_fetch"
down_revision = "0008_bank_consent"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""ALTER TABLE moneylens.connections
        ADD COLUMN refresh_job_id uuid,
        ADD COLUMN last_requested_at timestamptz,
        ADD COLUMN last_attempt_at timestamptz,
        ADD COLUMN source_observed_at timestamptz,
        ADD COLUMN staged_at timestamptz,
        ADD COLUMN sync_checkpoint jsonb CHECK (jsonb_typeof(sync_checkpoint)='object' AND octet_length(sync_checkpoint::text)<=262144),
        ADD FOREIGN KEY (tenant_id,owner_user_id,refresh_job_id) REFERENCES moneylens.jobs(tenant_id,owner_user_id,id),
        DROP CONSTRAINT connections_sync_health_check,
        ADD CONSTRAINT connections_sync_health_check CHECK (sync_health IN ('never_synced','syncing','staged','fresh','stale','partial','error'))""")
    op.execute("""CREATE TABLE moneylens.bank_refresh_requests (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,
        connection_id uuid NOT NULL,job_id uuid NOT NULL,
        command_key text NOT NULL CHECK (command_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
        requested_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id,owner_user_id,id),
        UNIQUE (tenant_id,owner_user_id,connection_id,command_key),
        FOREIGN KEY (tenant_id,owner_user_id,connection_id) REFERENCES moneylens.connections(tenant_id,owner_user_id,id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id,owner_user_id,job_id) REFERENCES moneylens.jobs(tenant_id,owner_user_id,id) ON DELETE CASCADE)""")
    op.execute("CREATE INDEX bank_refresh_budget ON moneylens.bank_refresh_requests (tenant_id,owner_user_id,requested_at DESC)")
    op.execute("ALTER TABLE moneylens.bank_refresh_requests ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE moneylens.bank_refresh_requests FORCE ROW LEVEL SECURITY")
    op.execute("""CREATE POLICY bank_refresh_owner ON moneylens.bank_refresh_requests
        USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
            AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
        WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
            AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)""")
    op.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON moneylens.bank_refresh_requests TO moneylens_runtime")


def downgrade():
    op.execute("DROP TABLE moneylens.bank_refresh_requests")
    op.execute("UPDATE moneylens.connections SET sync_health='stale' WHERE sync_health='staged'")
    op.execute("""ALTER TABLE moneylens.connections DROP COLUMN sync_checkpoint,DROP COLUMN staged_at,
        DROP COLUMN source_observed_at,DROP COLUMN last_attempt_at,DROP COLUMN last_requested_at,DROP COLUMN refresh_job_id,
        DROP CONSTRAINT connections_sync_health_check,
        ADD CONSTRAINT connections_sync_health_check CHECK (sync_health IN ('never_synced','syncing','fresh','stale','partial','error'))""")
