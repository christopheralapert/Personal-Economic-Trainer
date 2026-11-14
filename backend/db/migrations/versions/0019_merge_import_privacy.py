"""Join the import identity and AI privacy migration branches."""
from alembic import op

revision = "0019_merge_import_privacy"
down_revision = ("0019_ai_privacy_preferences", "0019_source_fingerprints")
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
