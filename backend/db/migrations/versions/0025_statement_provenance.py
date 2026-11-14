"""Account-bound statement provenance and normalized content identity."""
from alembic import op

revision = '0025_statement_provenance'
down_revision = '0024_statement_staging'
branch_labels = None
depends_on = None


def upgrade():
    for table in ('statement_previews', 'statement_import_receipts'):
        op.execute(f'''ALTER TABLE moneylens.{table}
            ADD COLUMN source_format text NOT NULL DEFAULT 'wise_csv'
                CHECK (source_format IN ('wise_csv','canonical_csv','lhv_csv')),
            ADD COLUMN normalized_sha256 text
                CHECK (normalized_sha256 IS NULL OR normalized_sha256 ~ '^[0-9a-f]{{64}}$')''')
    op.execute('''ALTER TABLE moneylens.statement_import_receipts
        ADD CONSTRAINT statement_normalized_identity UNIQUE
            (tenant_id,owner_user_id,normalized_sha256),
        ADD CONSTRAINT statement_receipt_account_identity UNIQUE
            (tenant_id,owner_user_id,id,account_id)''')
    op.execute('''ALTER TABLE moneylens.transactions ADD COLUMN statement_receipt_id uuid,
        ADD CONSTRAINT statement_transaction_receipt FOREIGN KEY
            (tenant_id,owner_user_id,statement_receipt_id,account_id)
            REFERENCES moneylens.statement_import_receipts(tenant_id,owner_user_id,id,account_id)
            DEFERRABLE INITIALLY DEFERRED,
        ADD CONSTRAINT statement_source_exclusive CHECK
            (statement_receipt_id IS NULL OR (connection_id IS NULL AND import_batch_id IS NULL))''')
    # Create the index before backfill queues deferred foreign-key checks.
    op.execute('''CREATE INDEX statement_transaction_provenance
        ON moneylens.transactions(tenant_id,owner_user_id,statement_receipt_id)
        WHERE statement_receipt_id IS NOT NULL''')
    # Old Wise rows used file hash + ordinal. Preserve their IDs and classifications.
    op.execute('''UPDATE moneylens.transactions t SET statement_receipt_id=r.id
        FROM moneylens.statement_import_receipts r
        WHERE (t.tenant_id,t.owner_user_id,t.account_id)=(r.tenant_id,r.owner_user_id,r.account_id)
          AND t.connection_id IS NULL AND t.import_batch_id IS NULL
          AND t.source_id ~ ('^' || r.file_sha256 || ':[0-9]+$')''')


def downgrade():
    raise RuntimeError('Statement provenance requires an explicit retention and archive plan before downgrade')
