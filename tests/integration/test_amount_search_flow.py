"""Real fenced PostgreSQL reads; synthetic rows, signed local sessions, no hosted model."""
from datetime import datetime,timezone
from uuid import uuid4
import json
import psycopg
import pytest
from app import coach_routes
from test_ledger import put,PERIOD
from test_private_records_model import private_model

@pytest.mark.parametrize('locale,question',[
    ('en',"Show last month's taxi rides over EUR 20."),
    ('fi','Näytä viime kuun yli 20 euron taksimatkat.'),
    ('et','Näita eelmise kuu üle 20 € taksosõite'),
])
def test_exact_saved_rows_compound_filters_followup_and_owner_isolation(database,owners,private_model,locale,question):
    client,app,login,captured=private_model
    app.state.coach_clock=lambda:datetime(2026,11,14,tzinfo=timezone.utc)
    second=uuid4()
    with psycopg.connect(database['admin']) as connection:
        connection.execute("INSERT INTO moneylens.accounts (tenant_id,owner_user_id,id,name,currency,account_type) VALUES (%s,%s,%s,'Second synthetic account','EUR','current')",(*owners[0][:2],second))
        first=put(connection,owners[0],amount=-3097,category='taxi',merchant='City  Taxi')
        put(connection,owners[0],amount=-2000,category='taxi',merchant='City  Taxi')
        put(connection,owners[0],amount=-3100,category='coffee',merchant='City  Taxi')
        put(connection,owners[0],amount=-8100,category='taxi',status='pending')
        put(connection,owners[0],amount=-8200,category='taxi',day='2026-09-15')
        other=put(connection,(*owners[0][:2],second),amount=-2100,category='taxi',merchant='City  Taxi')
        put(connection,owners[1],amount=-999999,category='taxi',merchant='City  Taxi')
    auth=login()
    scope={'account_ids':[str(owners[0][2])],'card_locale':locale,'privacy':True}
    def ask(text,**overrides):
        response=client.post('/v1/coach/query',headers=auth,json={**scope,'question':text,**overrides})
        assert response.status_code==200,response.text
        result=response.json();assert result['source']=='rule' and result['provider'] is None
        assert result['interpretation']['status']=='ready'
        return result
    single=ask(question);assert [row['id'] for row in single['transactions']['rows']]==[first]
    args=single['interpretation']['intent']['tool']['arguments'];assert args['amount_min_minor']==2001
    assert sum(row['amount_minor'] for row in single['transactions']['rows'])==-3097
    combined=ask(question,account_ids=[str(owners[0][2]),str(second)])
    assert {row['id'] for row in combined['transactions']['rows']}=={first,other}
    assert sum(row['amount_minor'] for row in combined['transactions']['rows'])==-5197
    compound=ask('Show transactions taxi at "City  Taxi" at least EUR 30.97 at most EUR 30.97 last month')
    assert [row['id'] for row in compound['transactions']['rows']]==[first]
    empty=ask('Show transactions taxi over EUR 90 last month');assert empty['transactions']['rows']==[]
    context=json.dumps({**PERIOD,'tool':'ledger_transactions','category':'taxi','amount_min_minor':2001})
    followup=ask('What about the month before?',conversation_context=context)
    assert [row['amount_minor'] for row in followup['transactions']['rows']]==[-8200]
    assert followup['interpretation']['intent']['tool']['arguments']['amount_min_minor']==2001
    assert captured==[]
    # The exact same composed predicate reaches the ledger API and its signed cursor scope.
    query={**PERIOD,'category':'taxi','merchant':'City  Taxi','amount_min_minor':2001,'amount_max_minor':3097,'account_id':str(owners[0][2])}
    evidence=client.get('/v1/ledger/transactions',params=query)
    assert evidence.status_code==200 and [row['id'] for row in evidence.json()['rows']]==[first]
    login(1)
    assert client.get('/v1/ledger/transactions',params=query).status_code in (403,404)

def test_amount_pagination_cannot_be_replayed_without_its_bounds(database,owners,private_model):
    client,app,login,_=private_model
    with psycopg.connect(database['admin']) as connection:
        for _ in range(4):put(connection,owners[0],amount=-2500,category='taxi')
        put(connection,owners[0],amount=2600,category='taxi',flow='refund')
        put(connection,owners[0],amount=-5000,category='taxi',flow='unknown')
    login()
    query={**PERIOD,'category':'taxi','amount_min_minor':2001,'amount_max_minor':3000,'limit':2}
    seen=[]
    response=client.get('/v1/ledger/transactions',params=query);assert response.status_code==200
    first=response.json();cursor=first['next_cursor'];assert cursor
    changed=client.get('/v1/ledger/transactions',params={**query,'amount_min_minor':0,'cursor':cursor})
    assert changed.status_code==409
    while True:
        page=response.json();seen.extend(page['rows'])
        if not page['next_cursor']:break
        response=client.get('/v1/ledger/transactions',params={**query,'cursor':page['next_cursor']});assert response.status_code==200
    assert len(seen)==5 and len({row['id'] for row in seen})==5
    assert sum(row['amount_minor'] for row in seen)==-7400
    assert client.get('/v1/ledger/transactions',params={**PERIOD,'amount_min_minor':3000,'amount_max_minor':2000}).status_code==422
