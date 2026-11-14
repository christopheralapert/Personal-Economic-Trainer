"""Repair installations that reached 0021 before the privacy branch was merged.

Fresh databases already receive this column from 0019_ai_privacy_preferences.
An existing revision stamp does not prove a subsequently edited ancestor ran.
"""
from alembic import op

revision = "0022_repair_ai_privacy_column"
down_revision = "0021_live_import_recovery"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE moneylens.user_state ADD COLUMN IF NOT EXISTS allow_ai_payment_descriptions boolean NOT NULL DEFAULT false")


def downgrade():
    # The column belongs to 0019. Never erase existing users' privacy preferences
    # when rolling back this idempotent compatibility repair.
    pass
