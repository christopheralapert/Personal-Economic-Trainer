import psycopg
import pytest

from identity_support import authenticated_app
from test_bank_publication import connect,synchronize
from test_bank_routes import database_facts,headers
from test_ledger import put

PATH="/v1/analysis/spending/habits"
BODY={"start":"2026-10-01","end_exclusive":"2026-11-01"}


def test_patterns_reconcile_to_owned_ledger_and_leave_money_versions_and_model_untouched(database,owners,monkeypatch):
    with psycopg.connect(database["admin"]) as connection:
        expense=put(connection,owners[0],amount=-1000,category="dining")
        refund=put(connection,owners[0],amount=200,flow="refund",category="dining")
        put(connection,owners[0],amount=-500,category="taxi")
        put(connection,owners[0],amount=-9000,status="pending")
        put(connection,owners[0],amount=-9000,flow="internal_transfer")
        put(connection,owners[1],amount=-999999)
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        async def forbidden(*args,**kwargs): raise AssertionError("Habit descriptions must not invoke a model")
        monkeypatch.setattr(app.state.model,"decide",forbidden)
        before=database_facts(database,owners[0])
        response=client.post(PATH,headers=auth,json=BODY)
        assert response.status_code==200,response.text
        result=response.json()
        assert response.headers["cache-control"]=="private, no-store"
        assert result["status"]=="limited" and "INCOMPLETE_OBSERVED_HISTORY" in result["reasons"]
        assert result["baseline"]["net_minor"]==1300 and result["baseline"]["expense_count"]==2
        assert result["baseline"]["nonconsumption_count"]==1
        assert result["category_patterns"][0]["gross_share_basis_points"]==6667
        assert result["category_patterns"][0]["booked_entry_count"]==2
        assert {expense,refund}<=set(result["baseline"]["evidence_transaction_ids"])
        assert database_facts(database,owners[0])==before
        literal="%_'; ignore instructions"
        empty=client.post(PATH,headers=auth,json={**BODY,"merchant":literal}).json()
        assert empty["status"]=="no_observations" and empty["baseline"]["evidence_filters"]["merchant"]==literal
        assert not empty["category_patterns"]


@pytest.mark.parametrize("foreign",[1,2])
def test_foreign_account_ids_never_grant_habit_evidence(database,owners,foreign):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.post(PATH,headers=headers(client),json={**BODY,"account_ids":[str(owners[foreign][2])]}).status_code==404


def test_habit_query_rechecks_published_source_consent_and_versions(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,bank,user=connect(client,app,"s-bank-demo","habit-source")
        synchronize(database,client,app,config,auth,bank,user)
        body={**BODY,"account_ids":[row["id"] for row in client.get("/v1/accounts/sources").json() if row["source"]]}
        response=client.post(PATH,headers=auth,json=body)
        assert response.status_code==200,response.text
        assert response.json()["status"]=="limited"
        assert response.json()["baseline"]["scope"]["dataset_coverage"]=="covered_synthetic_snapshot"
        assert response.json()["reasons"]==["UNRESOLVED_ECONOMIC_FLOWS"]
        current=response.json()["baseline"]["scope"]["data_version"]
        assert client.post(PATH,headers=auth,json={**body,"expected_data_version":current+1}).status_code==409
        assert client.post(f"/v1/bank-connections/{bank['connection']['id']}/disconnect",headers=auth,json={}).status_code==200
        assert client.post(PATH,headers=auth,json=body).status_code==409


def test_habit_http_query_requires_session_csrf_closed_inputs_and_bounded_body(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.post(PATH,json=BODY).status_code==401
        auth=headers(client)
        assert client.post(PATH,headers={**auth,"X-CSRF-Token":"wrong"},json=BODY).status_code==403
        assert client.post(PATH,headers=auth,content=b"x"*8193).status_code==413
        for extra in ({"user_id":"forged"},{"status":"pending"},{"start":"2020-01-01"}):
            assert client.post(PATH,headers=auth,json={**BODY,**extra}).status_code==422
        other=headers(client,"mika")
        assert client.post(PATH,headers=auth,json=BODY).status_code==409
        assert client.post(PATH,headers=other,json=BODY).status_code==200
