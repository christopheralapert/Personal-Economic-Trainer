"""Versioned reviewed inputs and replayable allocation acceptance/release receipts."""
from alembic import op

revision = "0005_planning_receipts"
down_revision = "0004_membership_fence"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""ALTER TABLE moneylens.plans
        ADD COLUMN reviewed_inputs jsonb,
        ADD COLUMN planning_policy jsonb,
        ADD COLUMN permission_version bigint CHECK (permission_version>0),
        ADD COLUMN quote_expires_at timestamptz,
        ADD COLUMN creation_key text,
        ADD COLUMN creation_fingerprint text CHECK (creation_fingerprint ~ '^[0-9a-f]{64}$'),
        ADD CONSTRAINT bounded_reviewed_inputs CHECK (reviewed_inputs IS NULL OR
            (jsonb_typeof(reviewed_inputs)='object' AND octet_length(reviewed_inputs::text)<=262144)),
        ADD CONSTRAINT bounded_planning_policy CHECK (planning_policy IS NULL OR
            (jsonb_typeof(planning_policy)='object' AND octet_length(planning_policy::text)<=16384)),
        ADD CONSTRAINT complete_planning_review CHECK ((reviewed_inputs IS NULL AND planning_policy IS NULL AND creation_key IS NULL)
            OR (reviewed_inputs IS NOT NULL AND planning_policy IS NOT NULL AND permission_version IS NOT NULL
                AND quote_expires_at IS NOT NULL AND creation_key IS NOT NULL AND creation_fingerprint IS NOT NULL)),
        ADD CONSTRAINT scoped_plan_creation_key UNIQUE (tenant_id,owner_user_id,creation_key)""")
    op.execute("CREATE UNIQUE INDEX one_reviewed_active_plan ON moneylens.plans (tenant_id,owner_user_id) WHERE state='active' AND reviewed_inputs IS NOT NULL")
    op.execute("""ALTER TABLE moneylens.reserves
        ADD COLUMN released_minor moneylens.minor NOT NULL DEFAULT 0,
        ADD CONSTRAINT valid_released_reserve CHECK (released_minor>=0 AND consumed_minor+released_minor<=amount_minor)""")
    op.execute("""ALTER TABLE moneylens.allocations
        ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','released')),
        ADD COLUMN request_fingerprint text CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
        ADD COLUMN acceptance_snapshot jsonb CHECK (acceptance_snapshot IS NULL OR
            (jsonb_typeof(acceptance_snapshot)='object' AND octet_length(acceptance_snapshot::text)<=16384)),
        ADD COLUMN accepted_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN released_at timestamptz,
        ADD COLUMN release_key text,
        ADD COLUMN release_fingerprint text CHECK (release_fingerprint ~ '^[0-9a-f]{64}$'),
        ADD CONSTRAINT complete_allocation_release CHECK ((state='active' AND released_at IS NULL AND release_key IS NULL AND release_fingerprint IS NULL)
            OR (state='released' AND released_at IS NOT NULL AND release_key IS NOT NULL AND release_fingerprint IS NOT NULL)),
        ADD CONSTRAINT scoped_allocation_release_key UNIQUE (tenant_id,owner_user_id,plan_id,release_key)""")


def downgrade():
    op.execute("""ALTER TABLE moneylens.allocations DROP CONSTRAINT scoped_allocation_release_key,
        DROP CONSTRAINT complete_allocation_release,DROP COLUMN release_fingerprint,DROP COLUMN release_key,
        DROP COLUMN released_at,DROP COLUMN accepted_at,DROP COLUMN acceptance_snapshot,
        DROP COLUMN request_fingerprint,DROP COLUMN state""")
    op.execute("ALTER TABLE moneylens.reserves DROP CONSTRAINT valid_released_reserve,DROP COLUMN released_minor")
    op.execute("DROP INDEX moneylens.one_reviewed_active_plan")
    op.execute("""ALTER TABLE moneylens.plans DROP CONSTRAINT scoped_plan_creation_key,
        DROP CONSTRAINT complete_planning_review,DROP CONSTRAINT bounded_planning_policy,DROP CONSTRAINT bounded_reviewed_inputs,
        DROP COLUMN creation_fingerprint,DROP COLUMN creation_key,DROP COLUMN quote_expires_at,
        DROP COLUMN permission_version,DROP COLUMN planning_policy,DROP COLUMN reviewed_inputs""")
