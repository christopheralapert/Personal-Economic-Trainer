"""Canonical source provenance and atomic publication receipts."""
from alembic import op

revision = "0011_bank_publication"
down_revision = "0010_synthetic_access_fence"
branch_labels = None
depends_on = None


def upgrade():
    # Owner deletion cascades through both accounts and connections. Check their
    # cross-references at commit, after both owned branches have been removed.
    op.execute("""ALTER TABLE moneylens.transactions ALTER CONSTRAINT
        transactions_tenant_id_owner_user_id_connection_id_fkey DEFERRABLE INITIALLY DEFERRED""")
    op.execute("""ALTER TABLE moneylens.connections ADD COLUMN published_job_id uuid,
        ADD COLUMN published_source_version text,
        ADD FOREIGN KEY (tenant_id,owner_user_id,published_job_id) REFERENCES moneylens.jobs(tenant_id,owner_user_id,id) DEFERRABLE INITIALLY DEFERRED""")
    op.execute("""ALTER TABLE moneylens.account_source_aliases ADD COLUMN canonical_reference text,
        ADD COLUMN source_version text,ADD COLUMN observed_at timestamptz,
        ADD COLUMN coverage_from date,ADD COLUMN coverage_to_exclusive date,
        ADD CHECK (coverage_to_exclusive IS NULL OR coverage_from IS NULL OR coverage_from<coverage_to_exclusive)""")
    op.execute("CREATE INDEX account_consent_lookup ON moneylens.account_source_aliases (tenant_id,owner_user_id,account_id,connection_id)")
    op.execute("""ALTER TABLE moneylens.balance_snapshots ADD COLUMN connection_id uuid,ADD COLUMN source_version text,
        ADD FOREIGN KEY (tenant_id,owner_user_id,connection_id) REFERENCES moneylens.connections(tenant_id,owner_user_id,id) DEFERRABLE INITIALLY DEFERRED""")
    op.execute("""ALTER TABLE moneylens.transactions ADD COLUMN provider_related_reference text,
        ADD COLUMN provider_related_institution text,ADD COLUMN source_economic_flow text""")


def downgrade():
    op.execute("""ALTER TABLE moneylens.transactions ALTER CONSTRAINT
        transactions_tenant_id_owner_user_id_connection_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE""")
    op.execute("ALTER TABLE moneylens.transactions DROP COLUMN source_economic_flow,DROP COLUMN provider_related_institution,DROP COLUMN provider_related_reference")
    op.execute("ALTER TABLE moneylens.balance_snapshots DROP COLUMN source_version,DROP COLUMN connection_id")
    op.execute("DROP INDEX moneylens.account_consent_lookup")
    op.execute("""ALTER TABLE moneylens.account_source_aliases DROP COLUMN coverage_to_exclusive,DROP COLUMN coverage_from,
        DROP COLUMN observed_at,DROP COLUMN source_version,DROP COLUMN canonical_reference""")
    op.execute("ALTER TABLE moneylens.connections DROP COLUMN published_source_version,DROP COLUMN published_job_id")
