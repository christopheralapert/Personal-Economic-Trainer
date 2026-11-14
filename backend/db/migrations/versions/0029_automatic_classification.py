"""Persist classification provenance and explicitly opted-in private merchant rules."""
from alembic import op
revision='0029_automatic_classification'
down_revision='0028_merge_identity_statements'
branch_labels=None
depends_on=None

def upgrade():
    # Earlier provenance revisions can queue deferred FK events in this same
    # Alembic transaction. Validate them before altering the populated table.
    op.execute('SET CONSTRAINTS ALL IMMEDIATE')
    op.execute("""ALTER TABLE moneylens.transactions ADD COLUMN classification_basis text NOT NULL DEFAULT 'needs_review'
        CHECK(classification_basis IN ('source_rule','user_rule','gemini','needs_review'))""")
    op.execute("""UPDATE moneylens.transactions SET classification_basis='source_rule'
        WHERE economic_flow IN ('expense','refund') AND category!='unclassified' AND basket!='unresolved'""")
    op.execute("""UPDATE moneylens.transactions t SET classification_basis='user_rule'
        WHERE EXISTS(SELECT 1 FROM moneylens.classification_corrections c
        WHERE (c.tenant_id,c.owner_user_id,c.transaction_id)=(t.tenant_id,t.owner_user_id,t.id))""")
    op.execute("""CREATE TABLE moneylens.merchant_rules(
        tenant_id uuid NOT NULL,owner_user_id uuid NOT NULL,merchant_key text NOT NULL CHECK(merchant_key ~ '^[0-9a-f]{64}$'),
        economic_flow text NOT NULL CHECK(economic_flow IN ('expense','refund')),category text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,owner_user_id,merchant_key,economic_flow),
        FOREIGN KEY(tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE)""")
    op.execute('ALTER TABLE moneylens.merchant_rules ENABLE ROW LEVEL SECURITY')
    op.execute('ALTER TABLE moneylens.merchant_rules FORCE ROW LEVEL SECURITY')
    op.execute("""CREATE POLICY personal_scope ON moneylens.merchant_rules TO moneylens_runtime
        USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid AND owner_user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
        WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid AND owner_user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)""")
    op.execute('GRANT SELECT,INSERT,UPDATE,DELETE ON moneylens.merchant_rules TO moneylens_runtime')
    op.execute('SET CONSTRAINTS ALL DEFERRED')

def downgrade():
    raise RuntimeError('Downgrade requires an explicit retention and archive plan for confirmed classifications and merchant rules')
