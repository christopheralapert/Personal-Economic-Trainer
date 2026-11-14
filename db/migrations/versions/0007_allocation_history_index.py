"""Support bounded owned receipt history in stable acceptance order."""
from alembic import op

revision = "0007_allocation_history_index"
down_revision = "0006_planning_source_indexes"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("CREATE INDEX allocation_history ON moneylens.allocations (tenant_id,owner_user_id,plan_id,accepted_at DESC,id DESC)")


def downgrade():
    op.execute("DROP INDEX moneylens.allocation_history")
