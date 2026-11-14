from app.database import tenant_transaction,TrustedScope
from identity_support import authenticated_app,login,ORIGIN
from uuid import UUID

CSV='TransferWise ID,Date,Amount,Currency,Description\nref-one,03-10-2026,-5.00,EUR,Synthetic shop\nref-one,03-10-2026,-5.00,EUR,Synthetic shop\n'


def test_wise_preview_publish_repeat_and_owner_isolation(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        first=login(client).json(); h={'Origin':ORIGIN,'X-CSRF-Token':first['csrf_token']}
        assert client.post('/v1/statements/wise/preview',json={'csv':CSV}).status_code==403
        response=client.post('/v1/statements/wise/preview',json={'csv':CSV},headers=h)
        assert response.status_code==200,response.text
        preview=response.json(); assert preview['count']==2 and preview['repeated_reference_groups']==1
        with app.state.pools.finance.connection() as conn:
            with tenant_transaction(conn,TrustedScope(owners[0][0],owners[0][1])):
                stored=conn.execute('SELECT encrypted_rows FROM moneylens.statement_previews WHERE id=%s',(UUID(preview['id']),)).fetchone()[0]
                assert b'Synthetic shop' not in bytes(stored)
        second=login(client,'mika').json(); other={'Origin':ORIGIN,'X-CSRF-Token':second['csrf_token']}
        assert client.post('/v1/statements/wise/confirm',json={'preview_id':preview['id']},headers=other).status_code==404
        first=login(client).json();h={'Origin':ORIGIN,'X-CSRF-Token':first['csrf_token']}
        preview=client.post('/v1/statements/wise/preview',json={'csv':CSV},headers=h).json()
        response=client.post('/v1/statements/wise/confirm',json={'preview_id':preview['id']},headers=h)
        assert response.status_code==200,response.text
        result=response.json(); assert result['count']==2
        again=client.post('/v1/statements/wise/confirm',json={'preview_id':preview['id']},headers=h)
        assert again.status_code==200 and again.json()==result
        replay=client.post('/v1/statements/wise/preview',json={'csv':CSV},headers=h)
        assert replay.status_code==200 and replay.json()['state']=='published'
        ledger=client.get('/v1/ledger/transactions',params={'start':'2026-10-01','end_exclusive':'2026-11-01','account_id':result['account_id']})
        assert ledger.status_code==200,ledger.text
        assert len(ledger.json()['rows'])==2 and all(row['economic_flow']=='unknown' for row in ledger.json()['rows'])
        answer=client.post('/v1/coach/query',headers=h,json={'question':'Show transactions from 2026-10-01 until 2026-11-01','account_ids':[result['account_id']]})
        assert answer.status_code==200,answer.text
        found=answer.json()['transactions']['rows']
        assert len(found)==2 and all(row['amount_minor']==-500 and row['booked_on']=='2026-10-03' for row in found)
        overlap=client.post('/v1/statements/wise/preview',json={'csv':CSV.replace('ref-one','another-ref')},headers=h)
        assert overlap.status_code==409
        second=login(client,'mika').json()
        hidden=client.get('/v1/ledger/transactions',params={'start':'2026-10-01','end_exclusive':'2026-11-01'})
        assert hidden.status_code==200 and not any(row['merchant']=='Synthetic shop' for row in hidden.json()['rows'])


def test_expired_preview_cleanup_uses_each_owner_scope(database,owners):
    from datetime import datetime,timedelta,timezone,date
    from uuid import uuid4
    from app.statement_routes import purge_expired_batch
    import psycopg
    now=datetime.now(timezone.utc)
    with authenticated_app(database,owners) as (client,app,config):
        with psycopg.connect(database['admin'],autocommit=True) as conn:
            for owner in owners[:2]:
                conn.execute("""INSERT INTO moneylens.statement_previews
                    (tenant_id,owner_user_id,id,session_id,file_sha256,account_label,period_from,period_to_exclusive,encrypted_rows,created_at,expires_at)
                    VALUES (%s,%s,%s,%s,%s,'Synthetic',%s,%s,%s,%s,%s)""",(*owner[:2],uuid4(),uuid4(),'f'*64,date(2026,1,1),date(2026,2,1),b'cipher',now-timedelta(minutes=20),now-timedelta(minutes=1)))
        assert purge_expired_batch(app.state.pools) is None
        with psycopg.connect(database['admin'],autocommit=True) as conn:
            assert conn.execute("SELECT count(*) FROM moneylens.statement_previews WHERE file_sha256=%s",('f'*64,)).fetchone()[0]==0


def test_existing_wise_connection_blocks_uncertain_account_link(database,owners):
    import psycopg
    from uuid import uuid4
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        with psycopg.connect(database['admin'],autocommit=True) as conn:
            conn.execute("""INSERT INTO moneylens.connections
                (tenant_id,owner_user_id,id,provider,provider_mode,consent_state)
                VALUES (%s,%s,%s,'enable:EE:Wise','live','active')""",(*owners[0][:2],uuid4()))
        session=login(client).json();headers={'Origin':ORIGIN,'X-CSRF-Token':session['csrf_token']}
        response=client.post('/v1/statements/wise/preview',json={'csv':CSV},headers=headers)
        assert response.status_code==409 and response.json()['error']['code']=='STATEMENT_OVERLAP'


def test_unconfirmed_previews_are_bounded_per_owner(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        session=login(client).json();headers={'Origin':ORIGIN,'X-CSRF-Token':session['csrf_token']}
        for _ in range(10):
            assert client.post('/v1/statements/wise/preview',json={'csv':CSV},headers=headers).status_code==200
        assert client.post('/v1/statements/wise/preview',json={'csv':CSV},headers=headers).status_code==429
