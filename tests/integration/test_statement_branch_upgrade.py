"""Upgrade existing statement branches forward on freshly created PostgreSQL databases."""
import psycopg
import pytest
from alembic import command


@pytest.mark.parametrize('prior',['0024_statement_staging','0025_statement_provenance','0025_statement_formats'])
def test_either_statement_branch_upgrades_to_one_head(migration_database,prior):
    with migration_database(prior) as database:
        with database['engine'].begin() as connection:
            database['config'].attributes['connection']=connection
            command.upgrade(database['config'],'head')
        with psycopg.connect(database['admin']) as connection:
            assert connection.execute('SELECT version_num FROM alembic_version').fetchall()==[
                ('0027_statement_file_provenance',)]
            assert connection.execute("SELECT to_regclass('moneylens.statement_accounts')").fetchone()[0]
            assert connection.execute("""SELECT count(*) FROM information_schema.columns
                WHERE table_schema='moneylens' AND (table_name,column_name) IN
                    (('transactions','statement_receipt_id'),('statement_import_receipts','canonical_sha256'))""").fetchone()==(2,)
