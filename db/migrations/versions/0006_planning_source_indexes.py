"""Bound review reads by current source facts rather than full ledger history."""
from alembic import op

revision = "0006_planning_source_indexes"
down_revision = "0005_planning_receipts"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("CREATE INDEX planning_balance_latest ON moneylens.balance_snapshots (tenant_id,owner_user_id,account_id,observed_at DESC,id DESC)")
    op.execute("CREATE INDEX planning_pending ON moneylens.transactions (tenant_id,owner_user_id,id) WHERE status='pending'")
    op.execute("CREATE INDEX planning_obligations ON moneylens.obligations (tenant_id,owner_user_id,id) WHERE state='planned'")
    op.execute("CREATE INDEX planning_unspent_reserves ON moneylens.reserves (tenant_id,owner_user_id,id) WHERE amount_minor>consumed_minor+released_minor")


def downgrade():
    for name in ("planning_unspent_reserves", "planning_obligations", "planning_pending", "planning_balance_latest"):
        op.execute("DROP INDEX moneylens."+name)
