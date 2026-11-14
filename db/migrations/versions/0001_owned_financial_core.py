"""Owned canonical core, scoped foreign keys, and forced row-level security."""
from pathlib import Path

from alembic import op

revision = "0001_owned_core"
down_revision = None
branch_labels = None
depends_on = None

OWNED_TABLES = (
    "user_state", "connections", "accounts", "account_source_aliases", "balance_snapshots",
    "import_batches", "transactions", "classification_corrections", "transfer_links",
    "obligations", "reserves", "plans", "plan_accounts", "goals", "allocations",
    "calculation_snapshots", "conversation_turns", "jobs", "outbox_events", "audit_events",
)


def upgrade():
    # This is a reviewed repository SQL artifact, never request/model-generated SQL.
    sql = (Path(__file__).resolve().parents[1] / "sql/0001_owned_core.sql").read_text(encoding="utf-8")
    op.execute(sql)
    tenant = "tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid"
    user = "owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid"
    for table in OWNED_TABLES:
        op.execute(f"ALTER TABLE moneylens.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE moneylens.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY personal_scope ON moneylens.{table} TO moneylens_runtime USING ({tenant} AND {user}) WITH CHECK ({tenant} AND {user})")
        privileges = "SELECT, INSERT" if table == "audit_events" else "SELECT, INSERT, UPDATE, DELETE"
        op.execute(f"GRANT {privileges} ON moneylens.{table} TO moneylens_runtime")
    for table, predicate in (
        ("tenants", "id = NULLIF(current_setting('app.tenant_id', true), '')::uuid AND EXISTS (SELECT 1 FROM moneylens.users u WHERE u.tenant_id = tenants.id AND u.id = NULLIF(current_setting('app.user_id', true), '')::uuid AND u.active)"),
        ("users", f"{tenant} AND id = NULLIF(current_setting('app.user_id', true), '')::uuid"),
    ):
        op.execute(f"ALTER TABLE moneylens.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE moneylens.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY identity_read_scope ON moneylens.{table} FOR SELECT TO moneylens_runtime USING ({predicate})")
        op.execute(f"GRANT SELECT ON moneylens.{table} TO moneylens_runtime")
    op.execute("GRANT SELECT ON moneylens.public_benchmark_releases TO moneylens_runtime")


def downgrade():
    # Destructive: explicit operator command only; no application startup downgrades.
    op.execute("DROP SCHEMA moneylens CASCADE")
    # Keep the cluster-level group: another database may use it. It has no login.
