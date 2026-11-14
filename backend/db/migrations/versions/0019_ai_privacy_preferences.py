"""Per-user AI privacy preference, disabled by default."""
from alembic import op

revision="0019_ai_privacy_preferences"
down_revision="0018_import_publication"
branch_labels=None
depends_on=None


def upgrade():
    op.execute("ALTER TABLE moneylens.user_state ADD COLUMN allow_ai_payment_descriptions boolean NOT NULL DEFAULT false")


def downgrade():
    op.execute("ALTER TABLE moneylens.user_state DROP COLUMN allow_ai_payment_descriptions")
