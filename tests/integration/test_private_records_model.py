"""Real owned API/RLS and fake Responses transport. Never uses personal records."""
from datetime import datetime,timezone
from uuid import uuid4
import json
from types import SimpleNamespace
from itertools import count
from app import coach_routes

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.auth_routes import cookie_name
from app.main import create_app
from app.settings import Settings
from app.model_adapter import OpenAIResponses
from test_ledger import put

ORIGIN="http://127.0.0.1:3000"
PERIOD={"start":"2026-10-01","end_exclusive":"2026-11-01"}


@pytest.fixture
def private_model(database,owners,monkeypatch):
    ticks=count(1000,60)
    monkeypatch.setattr(coach_routes,"time",SimpleNamespace(monotonic=lambda:next(ticks)))
    config=Settings(environment="test",auth_enabled=True,app_origin=ORIGIN,database_url=database["runtime"],auth_database_url=database["auth"],
        session_secret="private-fixture-session-secret-at-least-32-characters",model_enabled=True,model_billing_policy="paid_allowed",
        model_turn_budget_microusd=1,model_cost_limit_enabled=False,openai_api_key="offline-key-never-networked")
    app=create_app(config);captured=[]
    def handle(request):
        payload=json.loads(request.content);captured.append(payload)
        question=payload["input"][0]["content"]
        args={"intent":"transactions" if "transactions" in question.lower() else "spending",**PERIOD,
            "category":None,"merchant":None,"reduction_basis_points":None,"comparison_mode":None}
        return httpx.Response(200,json={"status":"completed","usage":{"input_tokens":100,"output_tokens":100},
            "output":[{"type":"function_call","name":"interpret_money_question","arguments":json.dumps(args)}]})
    with TestClient(app,base_url=ORIGIN) as client:
        client.portal.call(app.state.model.close)
        app.state.model=OpenAIResponses(config,transport=httpx.MockTransport(handle))
        def login(index=0):
            token=app.state.identity.login("integration",str(owners[index][1]))
            client.cookies.clear();client.cookies.set(cookie_name(config),token)
            session=client.get('/v1/auth/session').json()
            return {"Origin":ORIGIN,"X-CSRF-Token":session["csrf_token"],"X-MoneyLens-Session-ID":session["session_id"]}
        yield client,app,login,captured


def test_owned_73_booked_records_paginate_and_model_results_match_same_scope(database,owners,private_model):
    client,app,login,captured=private_model
    second=uuid4();ids=set()
    with psycopg.connect(database["admin"]) as c:
        c.execute("INSERT INTO moneylens.accounts (tenant_id,owner_user_id,id,name,currency,account_type) VALUES (%s,%s,%s,'Second fixture account','EUR','current')",(*owners[0][:2],second))
        for index in range(73):
            owner=owners[0] if index%2 else (*owners[0][:2],second)
            ids.add(put(c,owner,amount=-100,flow="unknown" if index<70 else "expense",category="unclassified" if index<70 else "coffee",merchant="Private fixture sentinel must never reach model"))
        put(c,owners[1],amount=-999999)
    auth=login()
    inventory=client.get('/v1/ledger/inventory',params=PERIOD).json()
    assert inventory["total_booked_count"]==inventory["period_booked_count"]==73
    assert inventory["period_unresolved_count"]==70 and len(inventory["scope"]["account_ids"])==2
    pages=[];cursor=None
    while True:
        r=client.get('/v1/ledger/transactions',params={**PERIOD,"spending_only":False,"limit":50,**({"cursor":cursor} if cursor else {})})
        assert r.status_code==200,r.text
        pages.extend(row['id'] for row in r.json()['rows']);cursor=r.json()['next_cursor']
        if not cursor:break
    assert len(pages)==len(set(pages))==73 and set(pages)==ids
    direct=client.get('/v1/analysis/spending',params=PERIOD).json()
    spent=client.post('/v1/coach/query',headers=auth,json={"question":"How much did I spend in October 2026?","privacy":False})
    assert spent.status_code==200,spent.text
    answer=spent.json();actual=answer['card']['answer']['artifact']['result']
    assert actual['net_minor']==direct['net_minor']==300
    assert actual['expense_count']==direct['expense_count']==3 and actual['unresolved_flow_count']==70
    assert answer['interpretation']['method']=='structured_model' and answer['model_usage']['estimated_cost_microusd']>1
    search=client.post('/v1/coach/query',headers=auth,json={"question":"Show transactions in October 2026","privacy":False})
    assert search.status_code==200,search.text
    search=search.json();assert len(search['transactions']['rows'])==50 and search['transactions']['next_cursor']
    assert search['transactions']['scope']['account_ids']==direct['scope']['account_ids']
    assert len(captured)==2
    wire=json.dumps(captured)
    assert "Private fixture sentinel" not in wire and not any(identifier in wire for identifier in ids)
    assert all(p['store'] is False and p['max_output_tokens']==app.state.settings.model_max_output_tokens for p in captured)
    assert client.post('/v1/coach/query',headers={**auth,"X-CSRF-Token":"invalid"},json={"question":"spending"}).status_code==403
    assert len(captured)==2
    # MyData exclusion applies to inventory, ledger and the model-selected tools.
    with psycopg.connect(database["admin"]) as c:c.execute("UPDATE moneylens.accounts SET included=false WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
    assert client.get('/v1/ledger/inventory',params=PERIOD).json()['total_booked_count']==0
    hidden=client.post('/v1/coach/query',headers=auth,json={"question":"Show transactions in October 2026","privacy":False}).json()
    assert hidden['transactions']['rows']==[]
    login(1)
    other=client.get('/v1/ledger/inventory',params=PERIOD).json()
    assert other['total_booked_count']==1
    with psycopg.connect(database['admin']) as c:
        usage=c.execute("SELECT metadata FROM moneylens.audit_events WHERE tenant_id=%s AND owner_user_id=%s AND action='coach.model_usage'",owners[0][:2]).fetchall()
        assert len(usage)==3 and all(row[0]['input_tokens']==100 for row in usage)
