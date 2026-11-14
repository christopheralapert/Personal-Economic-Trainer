"""Owner-scoped statement previews and publication receipts; no source files."""
from alembic import op

revision = '0024_statement_staging'
down_revision = '0023_classification_review'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('''CREATE TABLE moneylens.statement_previews (
        tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
        session_id uuid NOT NULL, file_sha256 text NOT NULL CHECK(file_sha256 ~ '^[0-9a-f]{64}$'),
        account_id uuid, account_label text NOT NULL CHECK(length(account_label) BETWEEN 1 AND 100),
        period_from date NOT NULL, period_to_exclusive date NOT NULL CHECK(period_to_exclusive > period_from),
        encrypted_rows bytea NOT NULL CHECK(octet_length(encrypted_rows) BETWEEN 1 AND 500000),
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id,owner_user_id,id),
        FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id,owner_user_id,account_id) REFERENCES moneylens.accounts(tenant_id,owner_user_id,id) ON DELETE CASCADE,
        CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes')
    )''')
    op.execute('''CREATE TABLE moneylens.statement_import_receipts (
        tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
        account_id uuid NOT NULL, file_sha256 text NOT NULL CHECK(file_sha256 ~ '^[0-9a-f]{64}$'),
        period_from date NOT NULL, period_to_exclusive date NOT NULL CHECK(period_to_exclusive > period_from),
        row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 20000),
        published_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id,owner_user_id,id), UNIQUE(tenant_id,owner_user_id,file_sha256),
        FOREIGN KEY (tenant_id,owner_user_id,account_id) REFERENCES moneylens.accounts(tenant_id,owner_user_id,id) ON DELETE CASCADE
    )''')
    for table in ('statement_previews', 'statement_import_receipts'):
        op.execute(f'ALTER TABLE moneylens.{table} ENABLE ROW LEVEL SECURITY')
        op.execute(f'ALTER TABLE moneylens.{table} FORCE ROW LEVEL SECURITY')
        op.execute(f'''CREATE POLICY personal_scope ON moneylens.{table} TO moneylens_runtime
            USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
               AND owner_user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
            WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
               AND owner_user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)''')
    op.execute('GRANT SELECT,INSERT,DELETE ON moneylens.statement_previews TO moneylens_runtime')
    op.execute('GRANT SELECT,INSERT ON moneylens.statement_import_receipts TO moneylens_runtime')
    op.execute('CREATE INDEX statement_preview_expiry ON moneylens.statement_previews(tenant_id,owner_user_id,expires_at)')
    op.execute('CREATE INDEX statement_receipt_window ON moneylens.statement_import_receipts(tenant_id,owner_user_id,account_id,period_from,period_to_exclusive)')


def downgrade():
    raise RuntimeError('Statement provenance requires an explicit retention and archive plan before downgrade')
