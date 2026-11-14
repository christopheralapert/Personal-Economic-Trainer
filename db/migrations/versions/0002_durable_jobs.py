"""Bounded attempts, lease fencing and inspectable terminal state."""
from alembic import op

revision = "0002_durable_jobs"
down_revision = "0001_owned_core"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""ALTER TABLE moneylens.jobs
        ADD COLUMN max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
        ADD COLUMN lease_token uuid,
        ADD COLUMN finished_at timestamptz,
        ADD COLUMN last_error_code text,
        ADD COLUMN permission_version bigint NOT NULL DEFAULT 1 CHECK (permission_version > 0)""")
    op.execute("""ALTER TABLE moneylens.outbox_events
        ADD COLUMN schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
        ADD COLUMN permission_version bigint NOT NULL DEFAULT 1 CHECK (permission_version > 0),
        ADD COLUMN discarded_at timestamptz,
        ADD COLUMN discard_reason text""")
    op.execute("CREATE INDEX jobs_expired ON moneylens.jobs (tenant_id,owner_user_id,type,lease_until) WHERE state='running'")
    op.execute("CREATE INDEX jobs_queued ON moneylens.jobs (tenant_id,owner_user_id,type,available_at,id) WHERE state='queued'")
    op.execute("CREATE INDEX outbox_unpublished ON moneylens.outbox_events (tenant_id,owner_user_id,created_at,id) WHERE published_at IS NULL AND discarded_at IS NULL")


def downgrade():
    op.execute("DROP INDEX moneylens.outbox_unpublished")
    op.execute("DROP INDEX moneylens.jobs_expired")
    op.execute("DROP INDEX moneylens.jobs_queued")
    op.execute("ALTER TABLE moneylens.outbox_events DROP COLUMN schema_version, DROP COLUMN permission_version, DROP COLUMN discarded_at, DROP COLUMN discard_reason")
    op.execute("ALTER TABLE moneylens.jobs DROP COLUMN max_attempts, DROP COLUMN lease_token, DROP COLUMN finished_at, DROP COLUMN last_error_code, DROP COLUMN permission_version")
