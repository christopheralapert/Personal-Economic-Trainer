"""Owned current/historical insights, collection versions and dismissal receipts."""
from alembic import op

revision="0015_durable_insights"
down_revision="0014_coaching_preferences"
branch_labels=None
depends_on=None


def upgrade():
    op.execute("""CREATE TABLE moneylens.insight_collections (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,
        version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id),
        FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE)""")
    op.execute("""CREATE TABLE moneylens.insights (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,
        kind text NOT NULL CHECK (kind IN ('upcoming_bill','low_headroom','higher_observed_spending')),
        status text NOT NULL CHECK (status IN ('active','superseded','dismissed')),
        version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
        data_version bigint NOT NULL CHECK (data_version>0),plan_version bigint NOT NULL CHECK (plan_version>0),
        preferences_version bigint NOT NULL CHECK (preferences_version>0),permission_version bigint NOT NULL CHECK (permission_version>0),
        candidate jsonb NOT NULL CHECK (jsonb_typeof(candidate)='object' AND octet_length(candidate::text)<=16384),
        evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=262144),
        fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
        generated_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
        dismissed_at timestamptz,CHECK (status<>'dismissed' OR dismissed_at IS NOT NULL),
        PRIMARY KEY (tenant_id,owner_user_id,id),
        FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE)""")
    op.execute("CREATE INDEX insights_owned_page ON moneylens.insights (tenant_id,owner_user_id,status,updated_at DESC,id DESC)")
    op.execute("""CREATE TABLE moneylens.insight_commands (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,insight_id uuid NOT NULL,
        command_key text NOT NULL CHECK (command_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
        request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),applied_at timestamptz NOT NULL,
        receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192),
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id,command_key),
        FOREIGN KEY (tenant_id,owner_user_id,insight_id) REFERENCES moneylens.insights(tenant_id,owner_user_id,id) ON DELETE CASCADE)""")
    op.execute("CREATE INDEX insight_command_budget ON moneylens.insight_commands (tenant_id,owner_user_id,applied_at DESC)")
    op.execute("CREATE INDEX insight_refresh_budget ON moneylens.jobs (tenant_id,owner_user_id,created_at DESC) WHERE type='coaching.refresh'")
    for table in ("insight_collections","insights","insight_commands"):
        op.execute(f"ALTER TABLE moneylens.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE moneylens.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""CREATE POLICY {table}_owner ON moneylens.{table} TO moneylens_runtime
            USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
                AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
            WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
                AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)""")
    op.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON moneylens.insight_collections,moneylens.insights TO moneylens_runtime")
    op.execute("GRANT SELECT,INSERT,DELETE ON moneylens.insight_commands TO moneylens_runtime")


def downgrade():
    op.execute("DROP INDEX moneylens.insight_refresh_budget")
    op.execute("DROP TABLE moneylens.insight_commands")
    op.execute("DROP TABLE moneylens.insights")
    op.execute("DROP TABLE moneylens.insight_collections")
