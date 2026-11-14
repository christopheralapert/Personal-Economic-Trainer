"""Opt-in forward-migration check using a uniquely created disposable database."""
from pathlib import Path
import base64
import hashlib
from uuid import uuid4

from alembic import command
from alembic.config import Config
import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool
from identity_support import authenticated_app, login, ORIGIN


def test_statement_provenance_migration_preserves_legacy_rows_and_classification(database):
    name = 'moneylens_statement_migration_' + uuid4().hex
    params = conninfo_to_dict(database['admin'])
    params['dbname'] = name
    url = make_conninfo(**params)
    admin = psycopg.connect(database['admin'], autocommit=True)
    admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    engine = create_engine('postgresql+psycopg://', creator=lambda: psycopg.connect(url), poolclass=NullPool)
    root = Path(__file__).resolve().parents[2]
    config = Config(str(root / 'backend/db/alembic.ini'))
    tenant, owner, account, receipt, transaction = (uuid4() for _ in range(5))
    content=b'TransferWise ID,Date,Amount,Currency,Description\nlegacy-ref,03-10-2026,-12.34,EUR,Synthetic reviewed purchase\n'
    digest=hashlib.sha256(content).hexdigest()
    try:
        with engine.begin() as connection:
            config.attributes['connection'] = connection
            command.upgrade(config, '0024_statement_staging')
        with psycopg.connect(url, autocommit=True) as connection:
            connection.execute("INSERT INTO moneylens.tenants(id,name) VALUES (%s,'Synthetic migration')", (tenant,))
            connection.execute("""INSERT INTO moneylens.users(tenant_id,id,subject_issuer,subject_id)
                VALUES (%s,%s,'synthetic-migration','synthetic-owner')""", (tenant, owner))
            connection.execute("""INSERT INTO moneylens.accounts(tenant_id,owner_user_id,id,name,currency,account_type)
                VALUES (%s,%s,%s,'Wise CSV','EUR','current')""", (tenant, owner, account))
            connection.execute('''INSERT INTO moneylens.user_state(tenant_id,owner_user_id,id,data_version)
                VALUES (%s,%s,%s,7)''', (tenant, owner, uuid4()))
            connection.execute('''INSERT INTO moneylens.statement_import_receipts
                (tenant_id,owner_user_id,id,account_id,file_sha256,period_from,period_to_exclusive,row_count)
                VALUES (%s,%s,%s,%s,%s,'2026-10-03','2026-10-04',1)''', (tenant, owner, receipt, account, digest))
            connection.execute('''INSERT INTO moneylens.transactions
                (tenant_id,owner_user_id,id,account_id,source_id,amount_minor,currency,booked_on,
                    status,merchant,category,basket,economic_flow)
                VALUES (%s,%s,%s,%s,%s,-1234,'EUR','2026-10-03','booked',
                    'Synthetic reviewed purchase','groceries','everyday','expense')''',
                (tenant, owner, transaction, account, digest+':0'))
        with engine.begin() as connection:
            config.attributes['connection'] = connection
            command.upgrade(config, 'head')
        with psycopg.connect(url) as connection:
            assert connection.execute('''SELECT id,account_id,statement_receipt_id,source_id,amount_minor,
                category,basket,economic_flow FROM moneylens.transactions''').fetchone() == (
                    transaction, account, receipt, digest+':0', -1234, 'groceries', 'everyday', 'expense')
            assert connection.execute('SELECT source_format,normalized_sha256 FROM moneylens.statement_import_receipts').fetchone() == ('wise_csv', None)
            assert connection.execute('SELECT data_version FROM moneylens.user_state').fetchone() == (7,)
        scratch={'admin':url,'runtime':make_conninfo(database['runtime'],dbname=name),
            'auth':make_conninfo(database['auth'],dbname=name)}
        with authenticated_app(scratch,[(tenant,owner,account)],statement_imports_enabled=True) as (client,app,settings):
            session=login(client).json();headers={'Origin':ORIGIN,'X-CSRF-Token':session['csrf_token']}
            preview=client.post('/v1/statements/wise/preview',headers=headers,json={
                'format':'csv','content_base64':base64.b64encode(content).decode()})
            assert preview.status_code==200,preview.text
            result=client.post('/v1/statements/wise/confirm',headers=headers,json={'previews':[
                {'preview_id':preview.json()['id'],'account_id':str(account)}]})
            assert result.status_code==200,result.text
            assert result.json()['added_count']==0
        with psycopg.connect(url) as connection:
            assert connection.execute('''SELECT id,statement_receipt_id,amount_minor,category,basket,economic_flow
                FROM moneylens.transactions''').fetchall()==[
                    (transaction,receipt,-1234,'groceries','everyday','expense')]
            assert connection.execute('SELECT data_version FROM moneylens.user_state').fetchone()==(7,)
    finally:
        config.attributes.pop('connection', None)
        engine.dispose()
        # Only the exact unique database created by this test is removed.
        admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
        admin.close()
