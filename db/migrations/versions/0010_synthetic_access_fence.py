"""Serialize changes to synthetic-only source eligibility with active readers."""
from alembic import op

revision = "0010_synthetic_access_fence"
down_revision = "0009_bank_fetch"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("DROP TRIGGER membership_change_fence ON moneylens.users")
    op.execute("""CREATE TRIGGER membership_change_fence BEFORE UPDATE OF active,permission_version,is_synthetic ON moneylens.users
        FOR EACH ROW WHEN (OLD.active IS DISTINCT FROM NEW.active OR OLD.permission_version IS DISTINCT FROM NEW.permission_version
            OR OLD.is_synthetic IS DISTINCT FROM NEW.is_synthetic) EXECUTE FUNCTION moneylens.fence_membership_change()""")


def downgrade():
    op.execute("DROP TRIGGER membership_change_fence ON moneylens.users")
    op.execute("""CREATE TRIGGER membership_change_fence BEFORE UPDATE OF active,permission_version ON moneylens.users
        FOR EACH ROW WHEN (OLD.active IS DISTINCT FROM NEW.active OR OLD.permission_version IS DISTINCT FROM NEW.permission_version)
        EXECUTE FUNCTION moneylens.fence_membership_change()""")
