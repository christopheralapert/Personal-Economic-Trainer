"""Atomic native snapshot pointers and invoker-secured analysis projections."""
from alembic import op

revision="0018_import_publication"
down_revision="0017_import_validation"
branch_labels=None
depends_on=None


def upgrade():
    op.execute("""CREATE FUNCTION moneylens.native_id(parent uuid,kind text,reference text) RETURNS uuid
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SECURITY INVOKER AS $$
        SELECT substring(encode(sha256(convert_to('moneylens.import.' || kind || '.v1:' || parent::text || ':' || reference,'UTF8')),'hex'),1,32)::uuid $$""")
    op.execute("REVOKE ALL ON FUNCTION moneylens.native_id(uuid,text,text) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION moneylens.native_id(uuid,text,text) TO moneylens_runtime")
    op.execute("""CREATE FUNCTION moneylens.guard_sealed_import_rows() RETURNS trigger
        LANGUAGE plpgsql SECURITY INVOKER AS $$ DECLARE sealed boolean; BEGIN
        IF TG_OP='INSERT' THEN
            SELECT state='validated' INTO sealed FROM moneylens.import_validation_runs
                WHERE tenant_id=NEW.tenant_id AND owner_user_id=NEW.owner_user_id AND id=NEW.run_id;
        ELSE
            SELECT state='validated' INTO sealed FROM moneylens.import_validation_runs
                WHERE tenant_id=OLD.tenant_id AND owner_user_id=OLD.owner_user_id AND id=OLD.run_id;
        END IF;
        IF sealed THEN RAISE EXCEPTION 'Validated source rows are sealed' USING ERRCODE='23514'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$""")
    op.execute("""CREATE TRIGGER sealed_import_rows BEFORE INSERT OR UPDATE OR DELETE ON moneylens.import_stage_rows
        FOR EACH ROW EXECUTE FUNCTION moneylens.guard_sealed_import_rows()""")
    op.execute("""CREATE FUNCTION moneylens.guard_import_source_identity() RETURNS trigger
        LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN
        IF TG_TABLE_NAME='import_validation_runs' THEN
            IF OLD.state='validated' AND NEW IS DISTINCT FROM OLD THEN
                RAISE EXCEPTION 'Validated source runs are sealed' USING ERRCODE='23514'; END IF;
        ELSE
            IF OLD.manifest IS NOT NULL AND (NEW.tenant_id,NEW.owner_user_id,NEW.id,NEW.manifest,NEW.source_sha256,
                NEW.mapping_version,NEW.source_version,NEW.object_key) IS DISTINCT FROM
                (OLD.tenant_id,OLD.owner_user_id,OLD.id,OLD.manifest,OLD.source_sha256,OLD.mapping_version,OLD.source_version,OLD.object_key) THEN
                RAISE EXCEPTION 'Import source identity is immutable' USING ERRCODE='23514'; END IF;
        END IF; RETURN NEW; END $$""")
    op.execute("""CREATE TRIGGER sealed_validation_run BEFORE UPDATE ON moneylens.import_validation_runs
        FOR EACH ROW EXECUTE FUNCTION moneylens.guard_import_source_identity()""")
    op.execute("""CREATE TRIGGER immutable_import_manifest BEFORE UPDATE ON moneylens.import_batches
        FOR EACH ROW EXECUTE FUNCTION moneylens.guard_import_source_identity()""")
    for function in ("guard_sealed_import_rows","guard_import_source_identity"):
        op.execute(f"REVOKE ALL ON FUNCTION moneylens.{function}() FROM PUBLIC")
        op.execute(f"GRANT EXECUTE ON FUNCTION moneylens.{function}() TO moneylens_runtime")
    op.execute("""CREATE TABLE moneylens.native_feeds (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,
        namespace_sha256 text NOT NULL CHECK (namespace_sha256 ~ '^[a-f0-9]{64}$'),
        mapping_version text NOT NULL CHECK (mapping_version='moneylens.synthetic-csv.v1'),
        source_customer_ref text NOT NULL CHECK (source_customer_ref ~ '^[A-Za-z0-9._:-]{1,100}$'),
        currency moneylens.currency NOT NULL,active_publication_id uuid,
        created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id,namespace_sha256),
        FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE)""")
    op.execute("""ALTER TABLE moneylens.import_validation_runs ADD CONSTRAINT import_run_batch_identity
        UNIQUE (tenant_id,owner_user_id,id,import_id)""")
    op.execute("""CREATE TABLE moneylens.import_publications (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,import_id uuid NOT NULL,run_id uuid NOT NULL,
        feed_id uuid NOT NULL,expected_previous_id uuid,
        state text NOT NULL CHECK (state IN ('queued','published','failed','cancelled')),
        generation bigint NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 9007199254740991),job_id uuid NOT NULL,
        account_count bigint NOT NULL CHECK (account_count BETWEEN 1 AND 1000),
        transaction_count bigint NOT NULL CHECK (transaction_count BETWEEN 0 AND 10000000),
        balance_count bigint NOT NULL CHECK (balance_count BETWEEN 0 AND 10000),
        created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,published_at timestamptz,published_data_version bigint,
        last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
        CHECK ((published_at IS NULL)=(published_data_version IS NULL)),
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id,import_id),
        UNIQUE (tenant_id,owner_user_id,id,feed_id),
        FOREIGN KEY (tenant_id,owner_user_id,run_id,import_id) REFERENCES moneylens.import_validation_runs(tenant_id,owner_user_id,id,import_id) DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (tenant_id,owner_user_id,feed_id) REFERENCES moneylens.native_feeds(tenant_id,owner_user_id,id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id,owner_user_id,job_id) REFERENCES moneylens.jobs(tenant_id,owner_user_id,id) DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (tenant_id,owner_user_id,expected_previous_id,feed_id) REFERENCES moneylens.import_publications(tenant_id,owner_user_id,id,feed_id) DEFERRABLE INITIALLY DEFERRED)""")
    op.execute("""ALTER TABLE moneylens.native_feeds ADD CONSTRAINT native_feed_active_publication
        FOREIGN KEY (tenant_id,owner_user_id,active_publication_id,id) REFERENCES moneylens.import_publications(tenant_id,owner_user_id,id,feed_id)
        DEFERRABLE INITIALLY DEFERRED""")
    op.execute("""ALTER TABLE moneylens.accounts ADD COLUMN native_feed_id uuid,ADD COLUMN native_reference text,
        ADD CHECK ((native_feed_id IS NULL)=(native_reference IS NULL)),
        ADD CHECK (native_reference IS NULL OR native_reference ~ '^[A-Za-z0-9._:-]{1,100}$'),
        ADD CONSTRAINT native_account_feed FOREIGN KEY (tenant_id,owner_user_id,native_feed_id)
            REFERENCES moneylens.native_feeds(tenant_id,owner_user_id,id) DEFERRABLE INITIALLY DEFERRED,
        ADD UNIQUE (tenant_id,owner_user_id,native_feed_id,native_reference)""")
    op.execute("""CREATE TABLE moneylens.import_publication_commands (
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,id uuid NOT NULL,publication_id uuid NOT NULL,
        command_key text NOT NULL CHECK (command_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
        request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),applied_at timestamptz NOT NULL,
        receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192),
        PRIMARY KEY (tenant_id,owner_user_id,id),UNIQUE (tenant_id,owner_user_id,command_key),
        FOREIGN KEY (tenant_id,owner_user_id,publication_id) REFERENCES moneylens.import_publications(tenant_id,owner_user_id,id) ON DELETE CASCADE)""")
    op.execute("CREATE INDEX import_publication_command_budget ON moneylens.import_publication_commands (tenant_id,owner_user_id,applied_at DESC)")
    op.execute("""CREATE INDEX native_transaction_window ON moneylens.import_stage_rows
        (tenant_id,owner_user_id,run_id,account_reference,booked_on DESC,ordinal DESC) WHERE role='transactions'""")
    op.execute("""CREATE INDEX native_balance_latest ON moneylens.import_stage_rows
        (tenant_id,owner_user_id,run_id,account_reference,observed_at DESC,ordinal DESC) WHERE role='balances'""")
    for table in ("native_feeds","import_publications","import_publication_commands"):
        op.execute(f"ALTER TABLE moneylens.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE moneylens.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""CREATE POLICY {table}_owner ON moneylens.{table} TO moneylens_runtime
            USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
                AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
            WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
                AND owner_user_id=nullif(current_setting('app.user_id',true),'')::uuid)""")
        privileges="SELECT,INSERT,DELETE" if table=="import_publication_commands" else "SELECT,INSERT,UPDATE,DELETE"
        op.execute(f"GRANT {privileges} ON moneylens.{table} TO moneylens_runtime")
    op.execute("""CREATE VIEW moneylens.analysis_transactions WITH (security_invoker=true) AS
        WITH native_rows AS (
            SELECT s.tenant_id,s.owner_user_id,moneylens.native_id(a.id,'transaction',s.source_reference) AS id,a.id AS account_id,
                a.name AS account_name,s.amount_minor,s.currency,s.booked_on,s.payload->>'status' AS status,
                s.payload->>'merchant' AS merchant,s.payload->>'category' AS category,s.payload->>'basket' AS basket,
                s.payload->>'economic_flow' AS source_flow
            FROM moneylens.native_feeds f JOIN moneylens.import_publications p
                ON (p.tenant_id,p.owner_user_id,p.id)=(f.tenant_id,f.owner_user_id,f.active_publication_id)
            JOIN moneylens.import_stage_rows s ON (s.tenant_id,s.owner_user_id,s.run_id)=(p.tenant_id,p.owner_user_id,p.run_id)
            JOIN moneylens.accounts a ON (a.tenant_id,a.owner_user_id,a.native_feed_id,a.native_reference)=(f.tenant_id,f.owner_user_id,f.id,s.account_reference)
            JOIN moneylens.users member ON (member.tenant_id,member.id)=(f.tenant_id,f.owner_user_id) AND member.active AND member.is_synthetic
            WHERE s.role='transactions' AND p.state='published'
        )
        SELECT tenant_id,owner_user_id,id,account_id,amount_minor,currency,booked_on,status,merchant,category,basket,economic_flow
            FROM moneylens.transactions
        UNION ALL
        SELECT n.tenant_id,n.owner_user_id,n.id,n.account_id,
            n.amount_minor,n.currency,n.booked_on,n.status,n.merchant,n.category,n.basket,
            CASE WHEN lower(n.merchant)=lower(n.account_name) OR EXISTS (
                SELECT 1 FROM native_rows other
                WHERE other.tenant_id=n.tenant_id AND other.owner_user_id=n.owner_user_id
                    AND other.account_id<>n.account_id AND other.currency=n.currency
                    AND other.amount_minor=-n.amount_minor AND abs(other.booked_on-n.booked_on)<=3
            ) THEN 'internal_transfer'
            WHEN n.source_flow='expense' AND n.amount_minor<=0 THEN 'expense' ELSE 'unknown' END AS economic_flow
        FROM native_rows n""")
    op.execute("""CREATE VIEW moneylens.analysis_balances WITH (security_invoker=true) AS
        SELECT tenant_id,owner_user_id,id,account_id,amount_minor,currency,balance_kind,pending_reflection,
            included_credit_minor,observed_at,connection_id,source_version FROM moneylens.balance_snapshots
        UNION ALL
        SELECT s.tenant_id,s.owner_user_id,moneylens.native_id(a.id,'balance',s.source_reference) AS id,a.id AS account_id,
            s.amount_minor,s.currency,s.payload->>'balance_kind' AS balance_kind,s.payload->>'pending_reflection' AS pending_reflection,
            (s.payload->>'included_credit_minor')::bigint,s.observed_at,NULL::uuid,b.source_version
        FROM moneylens.native_feeds f JOIN moneylens.import_publications p
            ON (p.tenant_id,p.owner_user_id,p.id)=(f.tenant_id,f.owner_user_id,f.active_publication_id)
        JOIN moneylens.import_batches b ON (b.tenant_id,b.owner_user_id,b.id)=(p.tenant_id,p.owner_user_id,p.import_id)
        JOIN moneylens.import_stage_rows s ON (s.tenant_id,s.owner_user_id,s.run_id)=(p.tenant_id,p.owner_user_id,p.run_id)
        JOIN moneylens.accounts a ON (a.tenant_id,a.owner_user_id,a.native_feed_id,a.native_reference)=(f.tenant_id,f.owner_user_id,f.id,s.account_reference)
        JOIN moneylens.users member ON (member.tenant_id,member.id)=(f.tenant_id,f.owner_user_id) AND member.active AND member.is_synthetic
        WHERE s.role='balances' AND p.state='published'""")
    op.execute("GRANT SELECT ON moneylens.analysis_transactions,moneylens.analysis_balances TO moneylens_runtime")


def downgrade():
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM moneylens.import_publications)
        THEN RAISE EXCEPTION 'Archive or remove owned publications explicitly before this downgrade'; END IF; END $$""")
    op.execute("DROP VIEW moneylens.analysis_balances,moneylens.analysis_transactions")
    op.execute("DROP TRIGGER sealed_import_rows ON moneylens.import_stage_rows")
    op.execute("DROP TRIGGER sealed_validation_run ON moneylens.import_validation_runs")
    op.execute("DROP TRIGGER immutable_import_manifest ON moneylens.import_batches")
    op.execute("DROP FUNCTION moneylens.guard_sealed_import_rows(),moneylens.guard_import_source_identity()")
    op.execute("DROP INDEX moneylens.native_balance_latest,moneylens.native_transaction_window")
    op.execute("ALTER TABLE moneylens.accounts DROP COLUMN native_reference,DROP COLUMN native_feed_id")
    op.execute("ALTER TABLE moneylens.native_feeds DROP CONSTRAINT native_feed_active_publication")
    op.execute("DROP TABLE moneylens.import_publication_commands,moneylens.import_publications,moneylens.native_feeds")
    op.execute("ALTER TABLE moneylens.import_validation_runs DROP CONSTRAINT import_run_batch_identity")
    op.execute("DROP FUNCTION moneylens.native_id(uuid,text,text)")
