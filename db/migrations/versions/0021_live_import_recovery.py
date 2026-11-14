"""Durable owner-scoped live import cooldown and privacy-safe failure evidence."""
from alembic import op

revision = "0021_live_import_recovery"
down_revision = "0020_live_banking"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""ALTER TABLE moneylens.live_bank_sessions
        ADD COLUMN retry_not_before timestamptz,
        ADD COLUMN retry_after_known boolean NOT NULL DEFAULT false,
        ADD COLUMN limit_attempts integer NOT NULL DEFAULT 0 CHECK(limit_attempts BETWEEN 0 AND 3),
        ADD COLUMN last_error_stage text,
        ADD COLUMN provider_error_code text,
        ADD COLUMN provider_request_id uuid,
        ADD COLUMN error_observed_at timestamptz""")
    # Preserve the known historical throttle without inventing a provider deadline
    # or an ASPSP code that the old adapter did not retain.
    op.execute("""UPDATE moneylens.live_bank_sessions l SET
        retry_not_before=c.last_attempt_at+interval '15 minutes',limit_attempts=1,
        last_error_stage='legacy_unknown',error_observed_at=c.last_attempt_at
        FROM moneylens.connections c WHERE (l.tenant_id,l.owner_user_id,l.connection_id)=(c.tenant_id,c.owner_user_id,c.id)
        AND c.last_error_code='bank_provider_throttled' AND c.last_attempt_at IS NOT NULL""")


def downgrade():
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM moneylens.live_bank_sessions
        WHERE retry_not_before IS NOT NULL OR limit_attempts>0)
        THEN RAISE EXCEPTION 'Resolve active live-import waits before rollback'; END IF; END $$""")
    op.execute("""ALTER TABLE moneylens.live_bank_sessions
        DROP COLUMN retry_not_before, DROP COLUMN retry_after_known, DROP COLUMN limit_attempts,
        DROP COLUMN last_error_stage, DROP COLUMN provider_error_code,
        DROP COLUMN provider_request_id, DROP COLUMN error_observed_at""")
