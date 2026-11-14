"""Owned corrections use real PostgreSQL/RLS and HTTP; never personal records."""
from uuid import UUID

import psycopg

from identity_support import authenticated_app
from test_bank_routes import headers, NOW
from test_ledger import put, PERIOD
from test_live_banking import live, connect, reset_refresh


def change(client, auth, identifier, version, flow="expense", category="taxi", basket="everyday"):
    return client.post(f"/v1/ledger/transactions/{identifier}/classification", headers=auth,
        json={"expected_data_version":version,"economic_flow":flow,"category":category,"basket":basket})


def test_review_recomputes_history_tools_coach_and_survives_new_session(database, owners):
    with psycopg.connect(database["admin"]) as db:
        expense=put(db,owners[0],amount=-1234,flow="unknown",category="unclassified")
        transfer=put(db,owners[0],amount=-5000,flow="unknown",category="unclassified")
    with authenticated_app(database,owners) as (client,app,config):
        app.state.coach_clock=lambda:NOW
        auth=headers(client)
        before=client.get('/v1/analysis/spending',params=PERIOD).json()
        assert client.get('/v1/ledger/inventory',params=PERIOD).json()['period_unreviewed_outgoing_minor']==6234
        version=before['scope']['data_version']
        response=change(client,auth,expense,version)
        assert response.status_code==200,response.text
        version=response.json()['data_version']
        assert response.json()['row']['amount_minor']==-1234
        response=change(client,auth,transfer,version,'internal_transfer',None,'unresolved')
        assert response.status_code==200,response.text
        version=response.json()['data_version']
        totals=client.get('/v1/analysis/spending',params=PERIOD).json()
        assert (totals['net_minor'],totals['expense_count'],totals['nonconsumption_count'],totals['unresolved_flow_count'])==(1234,1,1,0)
        inventory=client.get('/v1/ledger/inventory',params=PERIOD).json()
        assert inventory['period_booked_count']==2 and inventory['period_unresolved_count']==0
        assert inventory['period_unreviewed_outgoing_minor']==0
        assert client.get('/v1/ledger/transactions',params={**PERIOD,'needs_review':True}).json()['rows']==[]
        tool=client.post('/v1/analysis/tools/execute',headers=auth,json={'name':'spending_totals','arguments':{**PERIOD,'currency':'EUR','account_ids':None,'category':None,'merchant':None,'expected_data_version':version}})
        assert tool.status_code==200,tool.text
        assert tool.json()['result']['net_minor']==1234
        coach=client.post('/v1/coach/query',headers=auth,json={'question':'How much did I spend on taxis last month?'})
        assert coach.status_code==200,coach.text
        result=coach.json()['card']['answer']['artifact']['result']
        assert (result['net_minor'],result['expense_count'])==(1234,1)
        # A later correction invalidates old cursors/plans and all consumers use the same row.
        response=change(client,auth,expense,version,'internal_transfer',None,'unresolved')
        assert response.status_code==200,response.text
        assert client.get('/v1/analysis/spending',params=PERIOD).json()['net_minor']==0
        assert change(client,auth,expense,version).status_code==409
        auth=headers(client)
        rows=client.get('/v1/ledger/transactions',params=PERIOD).json()['rows']
        assert len(rows)==2 and all(r['economic_flow']=='internal_transfer' for r in rows)
    with psycopg.connect(database['admin']) as db:
        assert db.execute('SELECT count(*) FROM moneylens.classification_corrections WHERE tenant_id=%s AND owner_user_id=%s',owners[0][:2]).fetchone()[0]==3


def test_review_owner_csrf_direction_and_unknown_guards(database,owners):
    with psycopg.connect(database['admin']) as db:
        own=put(db,owners[0],flow='unknown',category='unclassified')
        foreign=[put(db,o) for o in owners[1:]]
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        version=client.get('/v1/analysis/spending',params=PERIOD).json()['scope']['data_version']
        assert change(client,{**auth,'X-CSRF-Token':'wrong'},own,version).status_code==403
        assert change(client,{**auth,'Origin':'https://foreign.invalid'},own,version).status_code==403
        for identifier in foreign:
            assert change(client,auth,identifier,version).status_code==404
        assert change(client,auth,own,version,'income',None,'unresolved').status_code==422
        assert change(client,auth,own,version,'expense',None,'unresolved').status_code==422
        response=change(client,auth,own,version,'unknown',None,'unresolved')
        assert response.status_code==200,response.text
        assert client.get('/v1/ledger/inventory',params=PERIOD).json()['period_unresolved_count']==1
        assert len(client.get('/v1/ledger/transactions',params={**PERIOD,'needs_review':True}).json()['rows'])==1
        with psycopg.connect(database['admin']) as db:
            db.execute('UPDATE moneylens.accounts SET included=false WHERE tenant_id=%s AND owner_user_id=%s AND id=%s',owners[0])
        assert change(client,auth,own,response.json()['data_version']).status_code==404


def test_live_reimport_preserves_review_and_source_facts(live):
    client,app,provider,login,database,owners=live
    auth,bank=connect(live)
    url=f"/v1/live-banking/connections/{bank}"
    first=client.post(url+'/refresh',headers=auth,json={})
    assert first.status_code==200,first.text
    period={'start':'2026-01-01','end_exclusive':'2027-01-01'}
    page=client.get('/v1/ledger/transactions',params=period).json()
    row=page['rows'][0];version=page['scope']['data_version']
    response=change(client,auth,row['id'],version,'expense','housing','mandatory_regular')
    assert response.status_code==200,response.text
    # Force offline transfer detection to propose a different purpose on replay.
    from app import live_banking_publication
    original=live_banking_publication.internal_transfer_ids
    live_banking_publication.internal_transfer_ids=lambda rows:{UUID(row['id'])}
    try:
        reset_refresh(database,owners[0],url.rsplit('/',1)[-1])
        repeat=client.post(url+'/refresh',headers=auth,json={})
        assert repeat.status_code==200,repeat.text
    finally:
        live_banking_publication.internal_transfer_ids=original
    rows=client.get('/v1/ledger/transactions',params=period).json()['rows']
    assert len(rows)==len(page['rows'])==2
    reviewed=next(r for r in rows if r['id']==row['id'])
    assert (reviewed['economic_flow'],reviewed['category'],reviewed['basket'])==('expense','housing','mandatory_regular')
    for key in ('id','account_id','amount_minor','currency','booked_on','status'):
        assert reviewed[key]==row[key]


def test_income_and_refund_are_explicit_and_not_inferred_from_sign(database,owners):
    with psycopg.connect(database['admin']) as db:
        credit=put(db,owners[0],amount=200,flow='unknown',category='unclassified')
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        version=client.get('/v1/analysis/spending',params=PERIOD).json()['scope']['data_version']
        assert change(client,auth,credit,version,'expense').status_code==422
        response=change(client,auth,credit,version,'income',None,'unresolved')
        assert response.status_code==200,response.text
        assert client.get('/v1/analysis/spending',params=PERIOD).json()['net_minor']==0
        response=change(client,auth,credit,response.json()['data_version'],'refund','taxi','everyday')
        assert response.status_code==200,response.text
        totals=client.get('/v1/analysis/spending',params=PERIOD).json()
        assert (totals['net_minor'],totals['refund_count'],totals['unresolved_flow_count'])==(-200,1,0)
