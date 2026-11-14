"""Versioned owned goals and immutable replay receipts; no new money effects."""
from alembic import op

revision = "0013_goal_lifecycle"
down_revision = "0012_bank_publication_receipts"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE moneylens.user_state ADD COLUMN goal_version bigint NOT NULL DEFAULT 1 CHECK (goal_version BETWEEN 1 AND 9007199254740991)")
    op.execute("""ALTER TABLE moneylens.goals
        ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
        ADD COLUMN priority integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
        ADD COLUMN created_at timestamptz,
        ADD COLUMN updated_at timestamptz,
        DROP CONSTRAINT goals_state_check,
        ADD CONSTRAINT goals_state_check CHECK (state IN ('active','paused','completed','removed'))""")
    op.execute("CREATE INDEX goals_owned_order ON moneylens.goals (tenant_id,owner_user_id,priority,deadline,id)")
    op.execute("CREATE INDEX allocations_goal_progress ON moneylens.allocations (tenant_id,owner_user_id,goal_id,state) WHERE goal_id IS NOT NULL")
    op.execute("""CREATE TABLE moneylens.goal_commands (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,
        goal_id uuid NOT NULL,command_key text NOT NULL CHECK (command_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
        action text NOT NULL CHECK (action ~ '^[a-z_]{1,40}$'),
        request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL,
        receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192),
        PRIMARY KEY (tenant_id,owner_user_id,id),
        UNIQUE (tenant_id,owner_user_id,command_key),
        FOREIGN KEY (tenant_id,owner_user_id,goal_id) REFERENCES moneylens.goals(tenant_id,owner_user_id,id) ON DELETE CASCADE)""")
    op.execute("CREATE INDEX goal_command_budget ON moneylens.goal_commands (tenant_id,owner_user_id,applied_at DESC)")
    op.execute("ALTER TABLE moneylens.goal_commands ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE moneylens.goal_commands FORCE ROW LEVEL SECURITY")
    op.execute("""CREATE POLICY goal_commands_owner ON moneylens.goal_commands TO moneylens_runtime
        USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
            AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
        WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
            AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)""")
    op.execute("GRANT SELECT,INSERT,DELETE ON moneylens.goal_commands TO moneylens_runtime")


def downgrade():
    # Do not silently turn removed goals back into active/paused targets.
    op.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM moneylens.goals WHERE state='removed') THEN
            RAISE EXCEPTION 'Review removed goals before downgrading the goal lifecycle';
        END IF;
    END $$""")
    op.execute("DROP TABLE moneylens.goal_commands")
    op.execute("DROP INDEX moneylens.allocations_goal_progress")
    op.execute("DROP INDEX moneylens.goals_owned_order")
    op.execute("""ALTER TABLE moneylens.goals DROP CONSTRAINT goals_state_check,
        ADD CONSTRAINT goals_state_check CHECK (state IN ('active','paused','completed')),
        DROP COLUMN updated_at,DROP COLUMN created_at,DROP COLUMN priority,DROP COLUMN version""")
    op.execute("ALTER TABLE moneylens.user_state DROP COLUMN goal_version")
