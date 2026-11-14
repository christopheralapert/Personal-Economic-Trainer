"""Statement account bindings and cross-format whole-statement fingerprints."""
from alembic import op

revision = '0025_statement_formats'
down_revision = '0024_statement_staging'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('ALTER TABLE moneylens.statement_import_receipts ADD COLUMN canonical_sha256 text CHECK(canonical_sha256 IS NULL OR canonical_sha256 ~ \'^[0-9a-f]{64}$\')')
    op.execute('''CREATE TABLE moneylens.statement_accounts (
        tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, account_id uuid NOT NULL,
        key_digest text CHECK(key_digest IS NULL OR key_digest ~ '^[0-9a-f]{64}$'),
        last_statement_on date NOT NULL,
        PRIMARY KEY(tenant_id,owner_user_id,account_id),
        UNIQUE(tenant_id,owner_user_id,key_digest),
        FOREIGN KEY(tenant_id,owner_user_id,account_id) REFERENCES moneylens.accounts(tenant_id,owner_user_id,id) ON DELETE CASCADE
    )''')
    op.execute('''INSERT INTO moneylens.statement_accounts(tenant_id,owner_user_id,account_id,last_statement_on)
        SELECT tenant_id,owner_user_id,account_id,max(period_to_exclusive)-1
        FROM moneylens.statement_import_receipts GROUP BY tenant_id,owner_user_id,account_id''')
    op.execute('ALTER TABLE moneylens.statement_accounts ENABLE ROW LEVEL SECURITY')
    op.execute('ALTER TABLE moneylens.statement_accounts FORCE ROW LEVEL SECURITY')
    op.execute('''CREATE POLICY personal_scope ON moneylens.statement_accounts TO moneylens_runtime
        USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
            AND owner_user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
        WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
            AND owner_user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)''')
    op.execute('GRANT SELECT,INSERT,UPDATE ON moneylens.statement_accounts TO moneylens_runtime')
    op.execute('CREATE INDEX statement_canonical ON moneylens.statement_import_receipts(tenant_id,owner_user_id,account_id,canonical_sha256)')


def downgrade():
    raise RuntimeError('Statement account provenance requires an explicit retention plan')
