"""Durable simulated authorization, exact grants and independent sync health."""
from alembic import op

revision = "0008_bank_consent"
down_revision = "0007_allocation_history_index"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""ALTER TABLE moneylens.connections
        ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN authorization_session_id uuid,
        ADD COLUMN authorization_expires_at timestamptz,
        ADD COLUMN callback_hash text CHECK (callback_hash ~ '^[0-9a-f]{64}$'),
        ADD COLUMN callback_consumed_at timestamptz,
        ADD COLUMN start_key text,
        ADD COLUMN start_fingerprint text CHECK (start_fingerprint ~ '^[0-9a-f]{64}$'),
        ADD COLUMN complete_key text,
        ADD COLUMN complete_fingerprint text CHECK (complete_fingerprint ~ '^[0-9a-f]{64}$'),
        ADD COLUMN sync_health text NOT NULL DEFAULT 'never_synced' CHECK (sync_health IN ('never_synced','syncing','fresh','stale','partial','error')),
        ADD COLUMN last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
        ADD COLUMN synthetic_fault text NOT NULL DEFAULT 'healthy' CHECK (synthetic_fault IN ('healthy','unavailable','throttled','expired','stale','partial','pending','booked')),
        ADD CONSTRAINT scoped_connection_start_key UNIQUE (tenant_id,owner_user_id,start_key),
        ADD CONSTRAINT bounded_connection_grants CHECK (jsonb_array_length(scopes)<=50)""")
    op.execute("""CREATE UNIQUE INDEX one_open_synthetic_bank ON moneylens.connections (tenant_id,owner_user_id,provider)
        WHERE provider_mode='synthetic' AND consent_state IN ('requested','authorizing','active')""")


def downgrade():
    op.execute("DROP INDEX moneylens.one_open_synthetic_bank")
    op.execute("""ALTER TABLE moneylens.connections DROP CONSTRAINT bounded_connection_grants,
        DROP CONSTRAINT scoped_connection_start_key,DROP COLUMN synthetic_fault,DROP COLUMN last_error_code,
        DROP COLUMN sync_health,DROP COLUMN complete_fingerprint,DROP COLUMN complete_key,
        DROP COLUMN start_fingerprint,DROP COLUMN start_key,DROP COLUMN callback_consumed_at,DROP COLUMN callback_hash,
        DROP COLUMN authorization_expires_at,DROP COLUMN authorization_session_id,DROP COLUMN created_at""")
