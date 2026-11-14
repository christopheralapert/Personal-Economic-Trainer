"""Real PostgreSQL checks for atomic batches, ambiguity and same-tenant isolation."""
import base64
import psycopg
import pytest
from app import statement_files
from app.identity import AuthError
from uuid import uuid4
from scripts.generate_wise_fixtures import bundle, ROWS
from identity_support import authenticated_app, login, ORIGIN


def headers(client,profile='aino'):
    session=login(client,profile).json()
    return {'Origin':ORIGIN,'X-CSRF-Token':session['csrf_token']}


def stage(client,h,format='csv',source=None):
    response=client.post('/v1/statements/wise/preview',headers=h,json={'format':format,
        'content_base64':base64.b64encode((source or bundle())[format]).decode(),'date_order':'day_first'})
    assert response.status_code==200,response.text
    return response.json()


def selection(preview,**options):
    return dict(preview_id=preview['id'],**options)


def test_batch_rolls_back_before_foreign_or_missing_preview(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        a=headers(client);first=stage(client,a)
        response=client.post('/v1/statements/wise/confirm',headers=a,json={'previews':[
            selection(first,new_account_label='Synthetic first'),dict(preview_id=str(uuid4()))]})
        assert response.status_code==404
        assert client.get('/v1/accounts').json()==[dict(id=str(owners[0][2]),name='Synthetic account',currency='EUR',account_type='current',included=True)]
        assert client.get('/v1/statements/wise/accounts').json()==[]
        b=headers(client,'mika')
        assert client.post('/v1/statements/wise/confirm',headers=b,json={'previews':[selection(first,new_account_label='Other')]}).status_code==404
        assert client.get('/v1/statements/wise/accounts').json()==[]


def test_batch_write_failure_preserves_both_previews_and_retry_publishes_once(database,owners,monkeypatch):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h=headers(client); first=stage(client,h); second=stage(client,h,'xml')
        command={'previews':[selection(first,new_account_label='Synthetic atomic first'),
            selection(second,new_account_label='Synthetic atomic second')]}
        original=statement_files.publish_rows
        calls=[]
        def fail_second(*args):
            original(*args)
            calls.append(True)
            if len(calls)==2: raise AuthError('INVALID_IMPORT_COMMAND',409)
        monkeypatch.setattr(statement_files,'publish_rows',fail_second)
        assert client.post('/v1/statements/wise/confirm',headers=h,json=command).status_code==409
        with psycopg.connect(database['admin']) as connection:
            assert connection.execute('SELECT count(*) FROM moneylens.transactions WHERE owner_user_id=%s',(owners[0][1],)).fetchone()==(0,)
            assert connection.execute('SELECT count(*) FROM moneylens.statement_import_receipts WHERE owner_user_id=%s',(owners[0][1],)).fetchone()==(0,)
            assert connection.execute('SELECT count(*) FROM moneylens.statement_previews WHERE owner_user_id=%s',(owners[0][1],)).fetchone()==(2,)
            assert connection.execute('SELECT count(*) FROM moneylens.accounts WHERE owner_user_id=%s',(owners[0][1],)).fetchone()==(1,)
        monkeypatch.setattr(statement_files,'publish_rows',original)
        saved=client.post('/v1/statements/wise/confirm',headers=h,json=command)
        assert saved.status_code==200 and saved.json()['added_count']==6
        assert client.post('/v1/statements/wise/confirm',headers=h,json=command).json()['added_count']==0
        with psycopg.connect(database['admin']) as connection:
            assert connection.execute('SELECT count(*),sum(amount_minor) FROM moneylens.transactions WHERE owner_user_id=%s',(owners[0][1],)).fetchone()==(6,500)


def test_cross_format_dedup_and_ambiguous_repeated_reference(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h=headers(client); previews=[stage(client,h,f) for f in ('csv','pdf','xlsx')]
        response=client.post('/v1/statements/wise/confirm',headers=h,json={'previews':[selection(p,new_account_label='Synthetic main') for p in previews]})
        assert response.status_code==200,response.text
        data=response.json();assert data['added_count']==3
        account=data['files'][0]['account_id'];assert {f['account_id'] for f in data['files']}=={account}
        assert [f['added_count'] for f in data['files']]==[3,0,0]
        # A changed occurrence count cannot be collapsed using reference/date/amount.
        ambiguous=stage(client,h,source=bundle(rows=ROWS+(ROWS[0],)))
        command={'previews':[selection(ambiguous,account_id=account)]}
        assert client.post('/v1/statements/wise/confirm',headers=h,json=command).status_code==409
        query={'start':'2026-10-01','end_exclusive':'2026-11-01','account_id':account}
        assert len(client.get('/v1/ledger/transactions',params=query).json()['rows'])==3
        command['previews'][0]['keep_separate']=True
        assert client.post('/v1/statements/wise/confirm',headers=h,json=command).json()['added_count']==4
        assert len(client.get('/v1/ledger/transactions',params=query).json()['rows'])==7


def test_qif_needs_explicit_currency_and_account(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h=headers(client);p=stage(client,h,'qif')
        assert p['requires_currency'] and p['requires_account']
        command={'previews':[selection(p)]}
        assert client.post('/v1/statements/wise/confirm',headers=h,json=command).json()['error']['code']=='STATEMENT_CURRENCY_REQUIRED'
        command['previews'][0]['currency']='EUR'
        assert client.post('/v1/statements/wise/confirm',headers=h,json=command).json()['error']['code']=='STATEMENT_ACCOUNT_REQUIRED'
        command['previews'][0]['new_account_label']='Synthetic QIF'
        assert client.post('/v1/statements/wise/confirm',headers=h,json=command).json()['added_count']==3


@pytest.mark.parametrize('format',['csv','pdf','xlsx','xml','mt940','qif'])
def test_file_rows_retain_exact_receipt_source_and_row_hash(database,owners,format):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h=headers(client); p=stage(client,h,format)
        response=client.post('/v1/statements/wise/confirm',headers=h,json={'previews':[
            selection(p,new_account_label='Synthetic provenance',currency='EUR')]})
        assert response.status_code==200,response.text
        with psycopg.connect(database['admin']) as connection:
            assert connection.execute('''SELECT count(*),count(t.statement_receipt_id),
                count(t.source_payload_hash),sum(t.amount_minor),min(r.source_format)
                FROM moneylens.transactions t JOIN moneylens.statement_import_receipts r
                ON (t.tenant_id,t.owner_user_id,t.statement_receipt_id,t.account_id)=
                   (r.tenant_id,r.owner_user_id,r.id,r.account_id)
                WHERE t.tenant_id=%s AND t.owner_user_id=%s''',owners[0][:2]).fetchone()==(
                    3,3,3,250,'wise_'+format)


def test_legacy_csv_then_pdf_uses_the_same_complete_statement_identity(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h=headers(client)
        p=client.post('/v1/statements/wise/preview',headers=h,json={'csv':bundle()['csv'].decode()}).json()
        legacy=client.post('/v1/statements/wise/confirm',headers=h,json={'preview_id':p['id']})
        assert legacy.status_code==200,legacy.text
        pdf=stage(client,h,'pdf')
        result=client.post('/v1/statements/wise/confirm',headers=h,json={'previews':[
            selection(pdf,account_id=legacy.json()['account_id'])]})
        assert result.status_code==200,result.text
        assert result.json()['added_count']==0


def test_identical_keyless_files_can_belong_to_two_distinct_accounts(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h=headers(client); accounts=[]
        for label in ('Synthetic first','Synthetic second'):
            p=stage(client,h)
            assert p['state']=='preview'
            result=client.post('/v1/statements/wise/confirm',headers=h,json={'previews':[
                selection(p,new_account_label=label)]})
            assert result.status_code==200,result.text
            assert result.json()['added_count']==3
            accounts.append(result.json()['files'][0]['account_id'])
        assert accounts[0]!=accounts[1]
        for account in accounts:
            p=stage(client,h)
            result=client.post('/v1/statements/wise/confirm',headers=h,json={'previews':[selection(p,account_id=account)]})
            assert result.status_code==200,result.text
            assert result.json()['added_count']==0


def test_qif_date_order_cannot_silently_reuse_a_different_interpretation(database,owners):
    content=b'!Type:Bank\nD03/04/2026\nT-5.00\nPSynthetic shop\n^\n'
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h=headers(client)
        def preview(order):
            response=client.post('/v1/statements/wise/preview',headers=h,json={'format':'qif',
                'content_base64':base64.b64encode(content).decode(),'date_order':order})
            assert response.status_code==200
            return response.json()
        p=preview('day_first')
        result=client.post('/v1/statements/wise/confirm',headers=h,json={'previews':[
            selection(p,new_account_label='Synthetic dates',currency='EUR')]})
        assert result.status_code==200
        account=result.json()['files'][0]['account_id']
        p=preview('month_first');assert p['state']=='preview'
        result=client.post('/v1/statements/wise/confirm',headers=h,json={'previews':[
            selection(p,account_id=account,currency='EUR')]})
        assert result.status_code==409
