"""Retain the actual adapter for all bounded statement-file variants."""
from alembic import op
from sqlalchemy import inspect

revision = '0027_statement_file_provenance'
down_revision = '0026_merge_statement_branches'
branch_labels = None
depends_on = None


def upgrade():
    for constraint in inspect(op.get_bind()).get_unique_constraints('statement_import_receipts',schema='moneylens'):
        if constraint['column_names'] in (['tenant_id','owner_user_id','file_sha256'],
                ['tenant_id','owner_user_id','normalized_sha256']):
            op.drop_constraint(constraint['name'],'statement_import_receipts',schema='moneylens',type_='unique')
    op.create_unique_constraint('statement_file_account_identity','statement_import_receipts',
        ['tenant_id','owner_user_id','account_id','file_sha256'],schema='moneylens')
    op.create_unique_constraint('statement_normalized_identity','statement_import_receipts',
        ['tenant_id','owner_user_id','account_id','normalized_sha256'],schema='moneylens')
    for table in ('statement_previews', 'statement_import_receipts'):
        op.execute(f'ALTER TABLE moneylens.{table} DROP CONSTRAINT {table}_source_format_check')
        op.execute(f'''ALTER TABLE moneylens.{table} ADD CONSTRAINT {table}_source_format_check
            CHECK(source_format IN ('wise_csv','canonical_csv','lhv_csv','wise_pdf',
                'wise_xlsx','wise_xml','wise_mt940','wise_qif'))''')


def downgrade():
    raise RuntimeError('Statement format provenance requires an explicit retention and archive plan')
