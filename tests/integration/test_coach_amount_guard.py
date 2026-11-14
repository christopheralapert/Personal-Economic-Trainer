"""Authenticated PostgreSQL and native Gemini test transport; no live provider calls."""
import json
from datetime import datetime,timezone
from types import SimpleNamespace

import httpx
from pydantic import SecretStr
import psycopg
import pytest

from app import coach_routes
from app.gemini_adapter import GeminiFunctions
from test_ledger import put
from test_private_records_model import private_model

CASES=[
    ('et','Näita eelmise kuu üle 20 € taksosõite','Kui palju kulutasin taksodele eelmisel kuul?','Summapiiranguga otsingut veel ei toetata'),
    ('en',"Show last month's taxi rides over EUR 20.",'How much did I spend on taxis last month?','Amount filters are not supported'),
    ('fi','Näytä viime kuun yli 20 euron taksimatkat.','Paljonko käytin takseihin viime kuussa?','Summarajauksia ei vielä tueta'),
]


@pytest.mark.parametrize('locale,limited,normal,message',CASES)
def test_amount_guard_skips_model_ledger_and_admission_but_regular_taxis_still_work(database,owners,private_model,monkeypatch,locale,limited,normal,message):
    client,app,login,_=private_model;config=app.state.settings
    config.model_provider='gemini';config.model_name='gemini-3.5-flash';config.gemini_api_key=SecretStr('injected-transport-only')
    captured=[]
    def handle(request):
        captured.append(json.loads(request.content))
        args=dict(intent='spending',start='2026-10-01',end_exclusive='2026-11-01',category='taxi',merchant=None,reduction_basis_points=None,comparison_mode=None)
        composing=captured[-1]['tools'][0]['functionDeclarations'][0]['name']=='respond_to_money_message'
        call=dict(name='respond_to_money_message',args=dict(text='Review the recorded evidence before choosing a change.')) if composing else dict(name='interpret_money_question',args=args)
        return httpx.Response(200,json=dict(candidates=[dict(finishReason='STOP',content=dict(parts=[dict(functionCall=call)]))],usageMetadata=dict(promptTokenCount=100,totalTokenCount=200)))
    client.portal.call(app.state.model.close);app.state.model=GeminiFunctions(config,transport=httpx.MockTransport(handle))
    app.state.coach_clock=lambda:datetime(2026,11,14,tzinfo=timezone.utc)
    with psycopg.connect(database['admin']) as connection:
        ids={put(connection,owners[0],amount=-1500,category='taxi',merchant='Private fixture merchant'),put(connection,owners[0],amount=-1597,category='taxi')}
        put(connection,owners[1],amount=-999999,category='taxi')
    auth=login();scope={'account_ids':[str(owners[0][2])],'card_locale':locale}
    def forbidden(*args,**kwargs):raise AssertionError('No model admission or ledger execution for unsupported predicates')
    def check_guard():
        before=list(captured);window=dict(coach_routes._model_usage_window)
        with monkeypatch.context() as guard:
            guard.setattr(coach_routes,'time',SimpleNamespace(monotonic=forbidden))
            guard.setattr(coach_routes,'execute_tool',forbidden)
            for privacy in (False,True):
                response=client.post('/v1/coach/query',headers=auth,json={**scope,'question':limited,'privacy':privacy})
                assert response.status_code==200
                body=response.json()
                assert body['source']=='rule' and body['provider'] is None and body['model_usage'] is None
                assert body['transactions'] is None and body['card'] is None and body['habits'] is None
                assert body['interpretation']['status']=='clarification_required' and body['interpretation']['reason']=='FILTER_REQUIRED'
                assert message in body['answer_text'] and body['answer_text'].count('?')==1
        assert captured==before and coach_routes._model_usage_window==window
    check_guard()
    answer=client.post('/v1/coach/query',headers=auth,json={**scope,'question':normal,'privacy':False})
    assert answer.status_code==200
    body=answer.json();assert body['source']=='model' and body['provider']=='gemini-direct' and body['model_usage']['calls']==2
    assert body['card']['answer']['artifact']['result']['net_minor']==3097
    assert ('30.97' if locale=='en' else '30,97') in body['answer_text']
    assert '2026-10-01' in body['answer_text'] and '2026-10-31' in body['answer_text']
    check_guard()  # Even immediately after a model attempt, not just before first admission.
    evidence=client.get('/v1/ledger/transactions',params={'start':'2026-10-01','end_exclusive':'2026-11-01','category':'taxi','account_id':str(owners[0][2])})
    assert evidence.status_code==200
    assert {row['id'] for row in evidence.json()['rows']}==ids
    assert sum(row['amount_minor'] for row in evidence.json()['rows'])==-3097
    local=client.post('/v1/coach/query',headers=auth,json={**scope,'question':normal,'privacy':True})
    assert local.status_code==200 and local.json()['source']=='rule' and local.json()['provider'] is None
    assert local.json()['card']['answer']['artifact']['result']['net_minor']==3097 and len(captured)==2
    wire=json.dumps(captured)
    assert 'Private fixture merchant' not in wire and all(identifier not in wire for identifier in ids)
    assert str(owners[0][2]) not in wire and str(owners[1][2]) not in wire
