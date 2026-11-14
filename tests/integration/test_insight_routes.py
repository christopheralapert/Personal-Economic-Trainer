from datetime import timedelta
from uuid import uuid4

import psycopg
import pytest

from identity_support import ORIGIN,authenticated_app
from test_bank_publication import connect,synchronize
from test_bank_routes import database_facts,headers
from test_ledger import put
from test_planning_routes import seed_plan
from test_planning_store import NOW,POLICY,reviewed,store

PLAN="/v1/insights/planning-preview"
SPENDING="/v1/insights/spending-preview"
BODY=dict(start="2026-10-01",end_exclusive="2026-11-01")


def test_owned_planning_preview_reuses_exact_forecast_and_bill_with_no_write_or_model(database,owners,monkeypatch):
    inputs=reviewed(database,owners[0]);inputs.costs[0].at=NOW+timedelta(days=3)
    inputs.balances[0].amount_minor=65000
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.balance_snapshots SET amount_minor=65000 WHERE id=%s",(inputs.balances[0].id,))
    with store(database,owners[0]) as repository: plan=repository.create(inputs,POLICY,key="insight-plan")
    with authenticated_app(database,owners) as (client,app,config):
        app.state.planning_clock=lambda:NOW;auth=headers(client)
        async def forbidden(*args,**kwargs): raise AssertionError("Coaching rules must not invoke a model")
        monkeypatch.setattr(app.state.model,"decide",forbidden)
        before=database_facts(database,owners[0])
        response=client.get(PLAN);assert response.status_code==200,response.text
        result=response.json();assert result["status"]=="ready" and result["persisted"] is False
        assert "no-store" in response.headers["cache-control"]
        assert {item["kind"]:item["amount_minor"] for item in result["candidates"]}=={"low_headroom":5000,"upcoming_bill":35000}
        assert result["evidence"]["plan_id"]==str(plan["id"]) and result["evidence"]["plan_version"]==2
        assert result["evidence"]["balance_snapshot_ids"]==[str(inputs.balances[0].id)]
        assert client.get(PLAN).json()==result
        assert database_facts(database,owners[0])==before
        other=headers(client,"mika");other_result=client.get(PLAN,headers={"X-MoneyLens-Session-ID":other["X-MoneyLens-Session-ID"]}).json()
        assert other_result["status"]=="blocked" and other_result["evidence"] is None and other_result["candidates"]==[]
        assert other_result["blocked_reasons"]==["CURRENT_PLAN_REQUIRED"]


@pytest.mark.parametrize("change",["expiry","data","account"])
def test_stale_or_changed_plan_has_no_actionable_insight_money(database,owners,change):
    seed_plan(database,owners[0])
    with authenticated_app(database,owners) as (client,app,config):
        app.state.planning_clock=lambda:NOW+(timedelta(minutes=5) if change=="expiry" else timedelta())
        headers(client)
        if change!="expiry":
            with psycopg.connect(database["admin"]) as connection:
                table,assignment=("user_state","data_version=data_version+1") if change=="data" else ("accounts","included=false")
                connection.execute("UPDATE moneylens."+table+" SET "+assignment+" WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
        response=client.get(PLAN);assert response.status_code==200,response.text
        assert response.json()["status"]=="blocked" and response.json()["candidates"]==[] and response.json()["evidence"] is None
        assert response.json()["blocked_reasons"]==["CURRENT_PLAN_REVIEW_REQUIRED"]


def test_source_bound_spending_preview_matches_direct_comparison_and_honors_revocation(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=connect(client,app,"s-bank-demo","insight-source")
        synchronize(database,client,app,config,auth,started,user)
        auth,second,user=connect(client,app,"north-demo","insight-source-north")
        synchronize(database,client,app,config,auth,second,user,key="refresh-north")
        ids=[item["id"] for item in client.get("/v1/accounts/sources").json() if item["source"]]
        before=database_facts(database,owners[0]);body={**BODY,"account_ids":ids}
        response=client.post(SPENDING,headers=auth,json=body);assert response.status_code==200,response.text
        result=response.json();assert result["status"]=="blocked" and result["blocked_reasons"]==["MORE_OBSERVED_EXPENSES_REQUIRED"]
        assert result["comparison"]["status"]=="covered_comparison" and result["candidates"]==[]
        direct=client.get("/v1/analysis/spending/comparison",params={**BODY,"account_id":ids,"mode":"previous_period","spending_only":True})
        assert direct.status_code==200,direct.text
        assert result["comparison"]==direct.json() and result["comparison"]["current"]["scope"]["sources"][0]["mode"]=="synthetic"
        assert database_facts(database,owners[0])==before
        assert client.post(f"/v1/bank-connections/{started['connection']['id']}/disconnect",headers=auth,json={}).status_code==200
        assert client.post(SPENDING,headers=auth,json=body).status_code==409


@pytest.mark.parametrize("foreign",[1,2])
def test_spending_insight_scope_cannot_select_foreign_accounts(database,owners,foreign):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        assert client.post(SPENDING,headers=auth,json={**BODY,"account_ids":[str(owners[foreign][2])]}).status_code==404


def test_unverified_history_returns_observed_evidence_without_a_behavior_claim(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        for amount in (5000,6000,7000): put(connection,owners[0],amount=-amount,category="dining")
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client);response=client.post(SPENDING,headers=auth,json=BODY)
        assert response.status_code==200,response.text
        result=response.json();assert result["status"]=="blocked" and result["candidates"]==[]
        assert result["comparison"]["current"]["net_minor"]==18000
        assert "SPENDING_HISTORY_REVIEW_REQUIRED" in result["blocked_reasons"]


def test_preview_auth_csrf_body_bound_and_policy_authority_are_server_owned(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.get(PLAN).status_code==401
        assert client.post(SPENDING,json=BODY).status_code==401
        auth=headers(client)
        assert client.post(SPENDING,headers={"Origin":ORIGIN},json=BODY).status_code==403
        assert client.post(SPENDING,headers={**auth,"Origin":"https://foreign.invalid"},json=BODY).status_code==403
        assert client.post(SPENDING,headers={**auth,"X-MoneyLens-Session-ID":str(uuid4())},json=BODY).status_code==409
        assert client.post(SPENDING,headers=auth,content=b"x"*8193).status_code==413
        for extra in ({"policy":{"spending_increase_basis_points":1}},{"owner_user_id":str(owners[1][1])},{"current_minor":999999},{"household_coverage_confirmed":True},{"expected_data_version":True}):
            assert client.post(SPENDING,headers=auth,json={**BODY,**extra}).status_code==422
        assert client.post(SPENDING,headers=auth,json={**BODY,"expected_data_version":2}).status_code==409
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.users SET active=false,permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
        assert client.get(PLAN).status_code==401 and client.post(SPENDING,headers=auth,json=BODY).status_code==401
