"""Retain source payload identity independently from future user classifications."""
from alembic import op

revision="0019_source_fingerprints"
down_revision="0018_import_publication"
branch_labels=None
depends_on=None


def upgrade():
    op.execute("""ALTER TABLE moneylens.transactions ADD COLUMN source_payload_hash text
        CHECK (source_payload_hash IS NULL OR source_payload_hash ~ '^[a-f0-9]{64}$')""")


def downgrade():
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM moneylens.transactions WHERE source_payload_hash IS NOT NULL)
        THEN RAISE EXCEPTION 'Archive or remove source revision evidence explicitly before this downgrade'; END IF; END $$""")
    op.execute("ALTER TABLE moneylens.transactions DROP COLUMN source_payload_hash")
