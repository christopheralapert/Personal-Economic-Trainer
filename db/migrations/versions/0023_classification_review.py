"""Extend the existing owned correction journal with explicit economic purpose."""
from alembic import op

revision = "0023_classification_review"
down_revision = "0022_repair_ai_privacy_column"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""ALTER TABLE moneylens.classification_corrections ADD COLUMN economic_flow text
        CHECK (economic_flow IN ('expense','refund','income','internal_transfer','liability_settlement','unknown'))""")
    op.execute("""CREATE INDEX correction_transaction ON moneylens.classification_corrections
        (tenant_id,owner_user_id,transaction_id,created_at DESC)""")


def downgrade():
    op.execute("DROP INDEX moneylens.correction_transaction")
    op.execute("ALTER TABLE moneylens.classification_corrections DROP COLUMN economic_flow")
