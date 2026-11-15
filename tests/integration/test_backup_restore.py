"""Opt-in disposable PostgreSQL recovery; credentials and rows never enter output."""
import hashlib
import json
import os
import re
import subprocess
from time import perf_counter
from uuid import uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict,make_conninfo
import pytest

from app.database import TrustedScope,tenant_transaction
from test_ledger import put


def snapshot(url):
    with psycopg.connect(url) as connection:
        tables=connection.execute("SELECT schemaname,tablename FROM pg_tables WHERE schemaname='moneylens' OR schemaname='public' AND tablename='alembic_version' ORDER BY 1,2").fetchall()
        rows={}
        for schema,name in tables:
            data=connection.execute(sql.SQL('SELECT row_to_json(t)::text FROM {}.{} t').format(sql.Identifier(schema),sql.Identifier(name))).fetchall()
            rows[schema+'.'+name]=hashlib.sha256('\n'.join(sorted(row[0] for row in data)).encode()).hexdigest()
        policies=connection.execute("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='moneylens' ORDER BY 1,2").fetchall()
        head=connection.execute('SELECT version_num FROM alembic_version ORDER BY version_num').fetchall()
        return rows,policies,head


def container_command(container,arguments,**kwargs):
    result=subprocess.run(['docker','exec',*(['-i'] if 'input' in kwargs else []),'--user','postgres',container,*arguments],capture_output=True,timeout=60,**kwargs)
    if result.returncode:
        # Provider/driver diagnostics may contain private values; expose only a code.
        raise RuntimeError('Disposable PostgreSQL '+arguments[0]+' failed; exit '+str(result.returncode))
    return result.stdout


@pytest.mark.skipif(not os.environ.get('MONEYLENS_BACKUP_CONTAINER'),reason='Explicit disposable-container restore opt-in required')
def test_synthetic_backup_restores_exact_rows_and_runtime_rls(database,owners):
    container=os.environ.get('MONEYLENS_BACKUP_CONTAINER')
    if not container:pytest.skip('Set MONEYLENS_BACKUP_CONTAINER to the dedicated test PostgreSQL container')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',container):raise RuntimeError('Invalid container name')
    params=conninfo_to_dict(database['admin'])
    if params.get('host')!='127.0.0.1':raise RuntimeError('Restore drill requires an isolated loopback administrator')
    port=subprocess.run(['docker','port',container,'5432'],capture_output=True,timeout=15)
    if port.returncode or port.stdout.decode().strip()!='127.0.0.1:'+params['port']:
        raise RuntimeError('Container must own exactly the isolated loopback administrator port')
    source=params['dbname']
    if not re.fullmatch(r'moneylens_test_[a-f0-9]{32}',source):raise RuntimeError('Source is not a disposable test fixture')
    destination='moneylens_restore_'+uuid4().hex
    created=False
    try:
        with psycopg.connect(database['admin']) as connection:
            first={put(connection,owners[0],amount=-1500,category='taxi'),put(connection,owners[0],amount=-1597,category='taxi')}
            second={put(connection,owners[1],amount=-700,category='taxi')}
            foreign={put(connection,owners[2],amount=-9999,category='coffee')}
        before=snapshot(database['admin'])
        began=perf_counter()
        dumped=container_command(container,['pg_dump','--username',params['user'],'--format=custom','--dbname',source])
        assert dumped.startswith(b'PGDMP')
        dump_ms=round((perf_counter()-began)*1000,1)
        key=AESGCM.generate_key(bit_length=256);nonce=os.urandom(12)
        sealed=AESGCM(key).encrypt(nonce,dumped,b'synthetic-restore-drill')
        recovered=AESGCM(key).decrypt(nonce,sealed,b'synthetic-restore-drill')
        assert recovered==dumped
        destination_url=make_conninfo(database['admin'],dbname=destination)
        with psycopg.connect(database['admin'],autocommit=True) as admin:
            admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(destination)));created=True
        began=perf_counter()
        container_command(container,['pg_restore','--username',params['user'],'--exit-on-error','--dbname',destination],input=recovered)
        restore_ms=round((perf_counter()-began)*1000,1)
        assert snapshot(destination_url)==before,'Restored rows, policies or migration head differ'
        assert snapshot(database['admin'])==before,'Source database changed during restore'
        runtime_url=make_conninfo(database['runtime'],dbname=destination)
        for owner,expected,total in [(owners[0],first,-3097),(owners[1],second,-700),(owners[2],foreign,-9999)]:
            with psycopg.connect(runtime_url,autocommit=True) as connection:
                with tenant_transaction(connection,TrustedScope(owner[0],owner[1])):
                    rows=connection.execute('SELECT id,amount_minor FROM moneylens.transactions').fetchall()
                    assert {str(row[0]) for row in rows}==expected
                    assert sum(row[1] for row in rows)==total
        print(json.dumps({'status':'passed','syntheticTransactions':4,'owners':3,'exactTableSnapshotsMatch':True,'rlsPoliciesMatch':True,'restrictedRoleIsolation':True,'sourceUnchanged':True,'migrationHeads':[row[0] for row in before[2]],'dumpMs':dump_ms,'restoreMs':restore_ms,'encryptedRoundTripInMemory':True,'retainedBackup':False,'productionKeyRecoveryVerified':False}))
    finally:
        if created:
            if not re.fullmatch(r'moneylens_restore_[a-f0-9]{32}',destination):raise RuntimeError('Invalid cleanup target')
            with psycopg.connect(database['admin'],autocommit=True) as admin:
                admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(destination)))
