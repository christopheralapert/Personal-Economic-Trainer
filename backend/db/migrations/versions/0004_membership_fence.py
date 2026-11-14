"""Serialize membership revocation with already-authorized financial transactions."""
from alembic import op

revision = "0004_membership_fence"
down_revision = "0003_sessions"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE moneylens.user_state ADD COLUMN authorization_fence bigint NOT NULL DEFAULT 1 CHECK (authorization_fence>0)")
    # Invoker security: no new elevated function or runtime user-write privilege.
    op.execute("""CREATE FUNCTION moneylens.fence_membership_change() RETURNS trigger
        LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
        BEGIN
            UPDATE moneylens.user_state SET authorization_fence=authorization_fence+1
            WHERE tenant_id=OLD.tenant_id AND owner_user_id=OLD.id;
            RETURN NEW;
        END $$""")
    op.execute("REVOKE ALL ON FUNCTION moneylens.fence_membership_change() FROM PUBLIC")
    op.execute("""CREATE TRIGGER membership_change_fence BEFORE UPDATE OF active,permission_version ON moneylens.users
        FOR EACH ROW WHEN (OLD.active IS DISTINCT FROM NEW.active OR OLD.permission_version IS DISTINCT FROM NEW.permission_version)
        EXECUTE FUNCTION moneylens.fence_membership_change()""")


def downgrade():
    op.execute("DROP TRIGGER membership_change_fence ON moneylens.users")
    op.execute("DROP FUNCTION moneylens.fence_membership_change()")
    op.execute("ALTER TABLE moneylens.user_state DROP COLUMN authorization_fence")
