"""Real PostgreSQL checks for atomic batches, ambiguity and same-tenant isolation."""
import base64
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
