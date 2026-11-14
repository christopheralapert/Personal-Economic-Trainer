"""Resumable native CSV staging and private rejection provenance."""
from alembic import op

revision="0017_import_validation"
down_revision="0016_import_intake"
branch_labels=None
depends_on=None


def upgrade():
    op.execute("""CREATE TABLE moneylens.import_validation_runs (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,import_id uuid NOT NULL,
        parser_version text NOT NULL CHECK (parser_version='moneylens.csv-parser.v1'),
        state text NOT NULL CHECK (state IN ('queued','validated','invalid','failed','cancelled')),
        generation bigint NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 9007199254740991),
        sequence bigint NOT NULL DEFAULT 0 CHECK (sequence BETWEEN 0 AND 9007199254740991),job_id uuid NOT NULL,
        checkpoints jsonb NOT NULL CHECK (jsonb_typeof(checkpoints)='object' AND octet_length(checkpoints::text)<=4096),
        processed_rows bigint NOT NULL DEFAULT 0 CHECK (processed_rows BETWEEN 0 AND 30000000),
        accepted_rows bigint NOT NULL DEFAULT 0 CHECK (accepted_rows BETWEEN 0 AND 30000000),
        rejected_rows bigint NOT NULL DEFAULT 0 CHECK (rejected_rows BETWEEN 0 AND 30000000),
        created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,finished_at timestamptz,
        last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
        CHECK (processed_rows=accepted_rows+rejected_rows),
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id,import_id),
        FOREIGN KEY (tenant_id,owner_user_id,import_id) REFERENCES moneylens.import_batches(tenant_id,owner_user_id,id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id,owner_user_id,job_id) REFERENCES moneylens.jobs(tenant_id,owner_user_id,id))""")
    op.execute("""CREATE TABLE moneylens.import_stage_rows (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,run_id uuid NOT NULL,
        role text NOT NULL CHECK (role IN ('accounts','transactions','balances')),
        ordinal bigint NOT NULL CHECK (ordinal BETWEEN 1 AND 10000000),
        position bigint NOT NULL CHECK (position BETWEEN 1 AND 30000000),
        byte_start bigint NOT NULL CHECK (byte_start>=0),byte_end bigint NOT NULL CHECK (byte_end>byte_start),
        raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[a-f0-9]{64}$'),
        source_reference text NOT NULL CHECK (source_reference ~ '^[A-Za-z0-9._:-]{1,100}$'),
        account_reference text CHECK (account_reference IS NULL OR account_reference ~ '^[A-Za-z0-9._:-]{1,100}$'),
        amount_minor moneylens.minor,currency moneylens.currency NOT NULL,
        booked_on date,observed_at timestamptz,
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=131072),
        PRIMARY KEY (tenant_id,owner_user_id,run_id,role,ordinal),
        UNIQUE NULLS NOT DISTINCT (tenant_id,owner_user_id,run_id,role,account_reference,source_reference),
        UNIQUE (tenant_id,owner_user_id,run_id,position),
        CHECK ((role='accounts')=(account_reference IS NULL)),
        FOREIGN KEY (tenant_id,owner_user_id,run_id) REFERENCES moneylens.import_validation_runs(tenant_id,owner_user_id,id) ON DELETE CASCADE)""")
    op.execute("""CREATE INDEX import_stage_account_totals ON moneylens.import_stage_rows
        (tenant_id,owner_user_id,run_id,role,account_reference) INCLUDE (amount_minor)""")
    op.execute("""CREATE TABLE moneylens.import_rejected_rows (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,run_id uuid NOT NULL,
        role text NOT NULL CHECK (role IN ('accounts','transactions','balances')),
        ordinal bigint NOT NULL CHECK (ordinal BETWEEN 1 AND 10000000),
        position bigint NOT NULL CHECK (position BETWEEN 1 AND 30000000),
        byte_start bigint NOT NULL CHECK (byte_start>=0),byte_end bigint NOT NULL CHECK (byte_end>byte_start),
        raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[a-f0-9]{64}$'),
        reasons text[] NOT NULL CHECK (cardinality(reasons) BETWEEN 1 AND 5),fields text[] NOT NULL CHECK (cardinality(fields)<=8),
        PRIMARY KEY (tenant_id,owner_user_id,run_id,role,ordinal),UNIQUE (tenant_id,owner_user_id,run_id,position),
        FOREIGN KEY (tenant_id,owner_user_id,run_id) REFERENCES moneylens.import_validation_runs(tenant_id,owner_user_id,id) ON DELETE CASCADE)""")
    op.execute("""CREATE TABLE moneylens.import_validation_commands (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,
        command_key text NOT NULL CHECK (command_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
        request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),applied_at timestamptz NOT NULL,
        receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192),
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id,command_key),
        FOREIGN KEY (tenant_id,owner_user_id,run_id) REFERENCES moneylens.import_validation_runs(tenant_id,owner_user_id,id) ON DELETE CASCADE)""")
    op.execute("CREATE INDEX import_validation_command_budget ON moneylens.import_validation_commands (tenant_id,owner_user_id,applied_at DESC)")
    for table in ("import_validation_runs","import_stage_rows","import_rejected_rows","import_validation_commands"):
        op.execute(f"ALTER TABLE moneylens.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE moneylens.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""CREATE POLICY {table}_owner ON moneylens.{table} TO moneylens_runtime
            USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
                AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
            WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
                AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)""")
        privileges="SELECT,INSERT,DELETE" if table in ("import_validation_commands","import_rejected_rows","import_stage_rows") else "SELECT,INSERT,UPDATE,DELETE"
        op.execute(f"GRANT {privileges} ON moneylens.{table} TO moneylens_runtime")


def downgrade():
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM moneylens.import_validation_runs)
        THEN RAISE EXCEPTION 'Archive or remove owned validation records explicitly before this downgrade'; END IF; END $$""")
    for table in ("import_validation_commands","import_rejected_rows","import_stage_rows","import_validation_runs"):
        op.execute(f"DROP TABLE moneylens.{table}")
