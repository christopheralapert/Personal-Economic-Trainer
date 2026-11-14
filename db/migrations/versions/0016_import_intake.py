"""Private manifest intake, scoped upload metadata and immutable command receipts."""
from alembic import op

revision="0016_import_intake"
down_revision="0015_durable_insights"
branch_labels=None
depends_on=None


def upgrade():
    op.execute("ALTER TABLE moneylens.import_batches DROP CONSTRAINT import_batches_state_check")
    op.execute("""ALTER TABLE moneylens.import_batches ADD CONSTRAINT import_batches_state_check
        CHECK (state IN ('awaiting_uploads','queued','source_ready','staging','validating','published','failed','cancelled'))""")
    op.execute("""ALTER TABLE moneylens.import_batches
        ADD COLUMN manifest jsonb CHECK (manifest IS NULL OR (jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=8192)),
        ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        ADD COLUMN upload_expires_at timestamptz,
        ADD COLUMN verification_job_id uuid,
        ADD CONSTRAINT import_verification_job_owner FOREIGN KEY (tenant_id,owner_user_id,verification_job_id)
            REFERENCES moneylens.jobs(tenant_id,owner_user_id,id)""")
    op.execute("CREATE INDEX import_intake_budget ON moneylens.import_batches (tenant_id,owner_user_id,created_at DESC)")
    op.execute("""CREATE TABLE moneylens.import_files (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,import_id uuid NOT NULL,
        role text NOT NULL CHECK (role IN ('accounts','transactions','balances')),
        size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 5368709120),
        sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        verified_at timestamptz,etag text CHECK (etag IS NULL OR length(etag) BETWEEN 1 AND 200),
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id,import_id,role),
        FOREIGN KEY (tenant_id,owner_user_id,import_id) REFERENCES moneylens.import_batches(tenant_id,owner_user_id,id) ON DELETE CASCADE,
        CHECK ((verified_at IS NULL)=(etag IS NULL)))""")
    op.execute("""CREATE TABLE moneylens.import_commands (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,import_id uuid NOT NULL,
        command_key text NOT NULL CHECK (command_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
        request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),applied_at timestamptz NOT NULL,
        receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192),
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id,command_key),
        FOREIGN KEY (tenant_id,owner_user_id,import_id) REFERENCES moneylens.import_batches(tenant_id,owner_user_id,id) ON DELETE CASCADE)""")
    op.execute("CREATE INDEX import_command_budget ON moneylens.import_commands (tenant_id,owner_user_id,applied_at DESC)")
    op.execute("""CREATE INDEX import_link_budget ON moneylens.audit_events (tenant_id,owner_user_id,created_at DESC)
        WHERE action='import.upload_links'""")
    for table in ("import_files","import_commands"):
        op.execute(f"ALTER TABLE moneylens.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE moneylens.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""CREATE POLICY {table}_owner ON moneylens.{table} TO moneylens_runtime
            USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
                AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
            WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
                AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)""")
    op.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON moneylens.import_files TO moneylens_runtime")
    op.execute("GRANT SELECT,INSERT,DELETE ON moneylens.import_commands TO moneylens_runtime")


def downgrade():
    # Refuse destructive DDL before discarding any intake metadata.
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM moneylens.import_batches WHERE manifest IS NOT NULL)
        THEN RAISE EXCEPTION 'Archive or remove owned intake records explicitly before this downgrade'; END IF; END $$""")
    op.execute("DROP INDEX moneylens.import_link_budget")
    op.execute("DROP TABLE moneylens.import_commands")
    op.execute("DROP TABLE moneylens.import_files")
    op.execute("DROP INDEX moneylens.import_intake_budget")
    op.execute("""ALTER TABLE moneylens.import_batches DROP CONSTRAINT import_verification_job_owner,
        DROP COLUMN verification_job_id,DROP COLUMN upload_expires_at,DROP COLUMN updated_at,DROP COLUMN created_at,DROP COLUMN manifest""")
    op.execute("ALTER TABLE moneylens.import_batches DROP CONSTRAINT import_batches_state_check")
    op.execute("""ALTER TABLE moneylens.import_batches ADD CONSTRAINT import_batches_state_check
        CHECK (state IN ('staging','validating','published','failed','cancelled'))""")
