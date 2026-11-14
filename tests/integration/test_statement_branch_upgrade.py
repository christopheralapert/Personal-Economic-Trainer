"""Upgrade existing statement branches forward on freshly created PostgreSQL databases."""
import psycopg
import pytest
from alembic import command


@pytest.mark.parametrize('prior',['0024_statement_staging','0025_statement_provenance','0025_statement_formats',
    '0027_statement_file_provenance','0025_identity_self_signup'])
def test_either_statement_branch_upgrades_to_one_head(migration_database,prior):
    with migration_database(prior) as database:
        with database['engine'].begin() as connection:
            database['config'].attributes['connection']=connection
            command.upgrade(database['config'],'head')
        with psycopg.connect(database['admin']) as connection:
            assert connection.execute('SELECT version_num FROM alembic_version').fetchall()==[
                ('0028_merge_identity_statements',)]
            assert connection.execute("SELECT to_regprocedure('moneylens_identity.ensure_workspace(text,text)')").fetchone()[0]
            assert connection.execute("SELECT to_regclass('moneylens.statement_accounts')").fetchone()[0]
            assert connection.execute("""SELECT count(*) FROM information_schema.columns
                WHERE table_schema='moneylens' AND (table_name,column_name) IN
                    (('transactions','statement_receipt_id'),('statement_import_receipts','canonical_sha256'))""").fetchone()==(2,)


def test_populated_current_statement_schema_keeps_owned_records_on_signup_upgrade(migration_database):
    from uuid import uuid4
    from identity_support import authenticated_app,login,ORIGIN
    from test_wise_flow import CSV
    tenant,owner,account=(uuid4() for _ in range(3))
    with migration_database('0027_statement_file_provenance') as database:
        with psycopg.connect(database['admin'],autocommit=True) as connection:
            connection.execute("INSERT INTO moneylens.tenants(id,name) VALUES (%s,'Synthetic upgrade tenant')",(tenant,))
            connection.execute("INSERT INTO moneylens.users(tenant_id,id,subject_issuer,subject_id) VALUES (%s,%s,'upgrade','existing')",(tenant,owner))
            connection.execute("INSERT INTO moneylens.user_state(tenant_id,owner_user_id,id) VALUES (%s,%s,%s)",(tenant,owner,uuid4()))
        with authenticated_app(database,[(tenant,owner,account)],statement_imports_enabled=True) as (client,app,config):
            session=login(client).json();headers={'Origin':ORIGIN,'X-CSRF-Token':session['csrf_token']}
            preview=client.post('/v1/statements/wise/preview',headers=headers,json={'csv':CSV})
            assert preview.status_code==200
            saved=client.post('/v1/statements/wise/confirm',headers=headers,json={'preview_id':preview.json()['id']})
            assert saved.status_code==200 and saved.json()['count']==2
        with psycopg.connect(database['admin']) as connection:
            rows=connection.execute('SELECT id,account_id,amount_minor,statement_receipt_id FROM moneylens.transactions ORDER BY id').fetchall()
            state=connection.execute('SELECT data_version FROM moneylens.user_state').fetchall()
            members=connection.execute('SELECT tenant_id,id,subject_issuer,subject_id FROM moneylens.users ORDER BY id').fetchall()
            accounts=connection.execute('SELECT tenant_id,owner_user_id,id FROM moneylens.accounts ORDER BY id').fetchall()
            workspaces=connection.execute('SELECT tenant_id,owner_user_id,id FROM moneylens.user_state ORDER BY id').fetchall()
        for _ in range(2):
            with database['engine'].begin() as connection:
                database['config'].attributes['connection']=connection
                command.upgrade(database['config'],'head')
        with psycopg.connect(database['admin']) as connection:
            assert connection.execute('SELECT id,account_id,amount_minor,statement_receipt_id FROM moneylens.transactions ORDER BY id').fetchall()==rows
            assert connection.execute('SELECT data_version FROM moneylens.user_state').fetchall()==state
            assert connection.execute('SELECT tenant_id,id,subject_issuer,subject_id FROM moneylens.users ORDER BY id').fetchall()==members
            assert connection.execute('SELECT tenant_id,owner_user_id,id FROM moneylens.accounts ORDER BY id').fetchall()==accounts
            assert connection.execute('SELECT tenant_id,owner_user_id,id FROM moneylens.user_state ORDER BY id').fetchall()==workspaces
            assert sum(row[2] for row in rows)==-1000
            assert connection.execute('SELECT version_num FROM alembic_version').fetchall()==[('0028_merge_identity_statements',)]
