"""Owned opt-in and quiet-hour preferences with immutable command receipts."""
from alembic import op

revision="0014_coaching_preferences"
down_revision="0013_goal_lifecycle"
branch_labels=None
depends_on=None


def upgrade():
    op.execute("""CREATE TABLE moneylens.coaching_preferences (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,
        version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
        coaching_enabled boolean NOT NULL,bill_insights boolean NOT NULL,headroom_insights boolean NOT NULL,spending_insights boolean NOT NULL,
        timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 100),
        quiet_start text,quiet_end text,paused_until timestamptz,
        delivery_mode text NOT NULL CHECK (delivery_mode='in_app_only'),created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id),
        CHECK ((quiet_start IS NULL AND quiet_end IS NULL) OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL
            AND quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND quiet_start<>quiet_end)),
        FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE)""")
    op.execute("""CREATE TABLE moneylens.coaching_commands (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,preferences_id uuid NOT NULL,
        command_key text NOT NULL CHECK (command_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
        request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),applied_at timestamptz NOT NULL,
        receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192),
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id,command_key),
        FOREIGN KEY (tenant_id,owner_user_id,preferences_id) REFERENCES moneylens.coaching_preferences(tenant_id,owner_user_id,id) ON DELETE CASCADE)""")
    op.execute("CREATE INDEX coaching_command_budget ON moneylens.coaching_commands (tenant_id,owner_user_id,applied_at DESC)")
    for table in ("coaching_preferences","coaching_commands"):
        op.execute(f"ALTER TABLE moneylens.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE moneylens.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""CREATE POLICY {table}_owner ON moneylens.{table} TO moneylens_runtime
            USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
                AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
            WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
                AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)""")
    op.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON moneylens.coaching_preferences TO moneylens_runtime")
    op.execute("GRANT SELECT,INSERT,DELETE ON moneylens.coaching_commands TO moneylens_runtime")


def downgrade():
    op.execute("DROP TABLE moneylens.coaching_commands")
    op.execute("DROP TABLE moneylens.coaching_preferences")
