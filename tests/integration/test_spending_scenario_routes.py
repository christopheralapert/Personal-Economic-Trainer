from datetime import timedelta

import psycopg
import pytest

from identity_support import ORIGIN,authenticated_app
from test_bank_publication import connect,synchronize
from test_bank_routes import NOW,database_facts,headers
from test_ledger import put

PATH="/v1/analysis/spending/reduction"
BODY=dict(start="2026-10-01",end_exclusive="2026-11-01",category="dining",change={"kind":"percentage","reduction_basis_points":2000})


def test_published_category_scenario_and_tool_share_immutable_observed_baseline(database,owners,monkeypatch):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","scenario-first")
        synchronize(database,client,app,config,auth,first,user)
        auth,second,user=connect(client,app,"north-demo","scenario-second")
        synchronize(database,client,app,config,auth,second,user,key="scenario-north")
        ids=[item["id"] for item in client.get("/v1/accounts/sources").json() if item["source"]]
        body={**BODY,"account_ids":ids}
        before=database_facts(database,owners[0])
        async def forbidden(*args,**kwargs): raise AssertionError("Scenario must not invoke a model")
        monkeypatch.setattr(app.state.model,"decide",forbidden)
        response=client.post(PATH,headers=auth,json=body);assert response.status_code==200,response.text
        result=response.json()
        assert result["status"]=="estimated" and result["result"]["amount_minor"]==5000 and result["counterfactual_net_minor"]==20000
        assert result["baseline"]["net_minor"]==25000 and result["baseline"]["scope"]["scope_kind"]=="selected_accounts"
        assert result["result_kind"]=="hypothetical_cost_reduction" and result["persisted"] is False
        tool=client.post("/v1/analysis/tools/execute",headers=auth,json={"name":"spending_reduction","arguments":body})
        assert tool.status_code==200,tool.text
        assert tool.json()["result"]==result
        fixed=client.post(PATH,headers=auth,json={**body,"change":{"kind":"fixed_amount","reduction_minor":5000}}).json()
        assert fixed["result"]["amount_minor"]==5000 and fixed["counterfactual_net_minor"]==20000
        assert before==database_facts(database,owners[0])
        app.state.bank_clock=lambda:NOW+timedelta(days=2)
        assert client.post(PATH,headers=auth,json=body).status_code==409
        app.state.bank_clock=lambda:NOW
        assert client.post(f"/v1/bank-connections/{first['connection']['id']}/disconnect",headers=auth,json={}).status_code==200
        assert client.post(PATH,headers=auth,json=body).status_code==409
        assert client.post("/v1/analysis/tools/execute",headers=auth,json={"name":"spending_reduction","arguments":body}).status_code==409


@pytest.mark.parametrize("foreign",[1,2])
def test_scenario_account_selection_never_grants_foreign_ownership(database,owners,foreign):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        body={**BODY,"account_ids":[str(owners[foreign][2])]}
        assert client.post(PATH,headers=auth,json=body).status_code==404
        assert client.post("/v1/analysis/tools/execute",headers=auth,json={"name":"spending_reduction","arguments":body}).status_code==404


def test_unverified_history_keeps_observed_baseline_but_blocks_hypothetical_result(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        put(connection,owners[0],amount=-30000,category="dining")
        put(connection,owners[0],amount=5000,flow="refund",category="dining")
        put(connection,owners[0],amount=-2000,category="dining",status="pending")
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        response=client.post(PATH,headers=auth,json=BODY);assert response.status_code==200,response.text
        result=response.json()
        assert result["baseline"]["net_minor"]==25000 and result["status"]=="blocked"
        assert result["result"]["amount_minor"] is None and result["counterfactual_net_minor"] is None
        assert result["blockers"][0]["code"]=="SCENARIO_HISTORY_INCOMPLETE"
        assert client.post(PATH,headers=auth,json={**BODY,"expected_data_version":2}).status_code==409


def test_scenario_session_csrf_body_limits_and_authoritative_field_rejection(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.post(PATH,json=BODY).status_code==401
        auth=headers(client)
        assert client.post(PATH,headers={"Origin":ORIGIN},json=BODY).status_code==403
        assert client.post(PATH,headers={**auth,"Origin":"https://foreign.invalid"},json=BODY).status_code==403
        assert client.post(PATH,headers=auth,content=b"x"*8193).status_code==413
        for changes in ({"owner_user_id":str(owners[1][1])},{"baseline_minor":25000},{"household_coverage_confirmed":True},{"status":"pending"},{"change":{"kind":"percentage","reduction_basis_points":True}}):
            assert client.post(PATH,headers=auth,json={**BODY,**changes}).status_code==422
        other=headers(client,"mika")
        assert client.post(PATH,headers=auth,json=BODY).status_code==409
        assert client.post(PATH,headers=other,json=BODY).status_code==200
