"""Retain each refresh receipt's completed publication across later refreshes."""
from alembic import op

revision = "0012_bank_publication_receipts"
down_revision = "0011_bank_publication"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE moneylens.bank_refresh_requests ADD COLUMN published_at timestamptz")
    op.execute("""UPDATE moneylens.bank_refresh_requests request SET published_at=consent.last_success_at
        FROM moneylens.connections consent WHERE (consent.tenant_id,consent.owner_user_id,consent.id,consent.published_job_id)
            =(request.tenant_id,request.owner_user_id,request.connection_id,request.job_id)
            AND consent.last_success_at IS NOT NULL""")


def downgrade():
    op.execute("ALTER TABLE moneylens.bank_refresh_requests DROP COLUMN published_at")
