"""Planning and connection tools reuse owned services without granting review authority."""
from datetime import timedelta
from uuid import uuid4

import psycopg
import pytest

from app.analysis_tool_finance import BankConnectionsArgumentsV1,PlanningReadArgumentsV1
from app.analysis_tool_population import PopulationReferenceArgumentsV1
from app.analysis_tools import execute_tool
from app.identity import AuthError
from app.model_adapter import ToolCall
from identity_support import authenticated_app
from test_bank_publication import connect,synchronize
from test_bank_routes import NOW,headers,database_facts
from test_planning_routes import seed_plan

PATH="/v2/analysis/tools/execute"

def query(client,auth,name,**arguments):
    return client.post(PATH,headers=auth,json={"name":name,"arguments":arguments})


def assert_withheld(plan):
    assert plan["current"] is False and plan["period"] is None
    assert plan["analysis"]["status"]=="blocked"
    result=plan["analysis"]["result"]
    assert all(result[field] is None for field in (
        "amount_minor","minimum_headroom_minor","minimum_headroom_at","surplus_minor","shortfall_minor"))
    assert plan["analysis"]["blockers"][0]["code"]=="PLANNING_REVIEW_REQUIRED"


def test_v2_expands_tools_without_mutating_v1_and_retains_csrf_and_body_limits(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=lambda:NOW
        assert client.get("/v2/analysis/tools").status_code==401
        assert query(client,{},"planning_read").status_code==401
        auth=headers(client)
        legacy=client.get("/v1/analysis/tools").json();expanded=client.get("/v2/analysis/tools").json()
        assert legacy["registry_version"]=="analysis-tools.v1" and len(legacy["tools"])==10
        assert expanded["registry_version"]=="analysis-tools.v2" and len(expanded["tools"])==13
        assert expanded["tools"][:10]==legacy["tools"]
        for name in ("planning_read","bank_connections","population_reference"):
            assert client.post("/v1/analysis/tools/execute",headers=auth,json={"name":name,"arguments":{}}).status_code==422
            assert query(client,{**auth,"X-CSRF-Token":"wrong"},name).status_code==403
            assert query(client,{**auth,"Origin":"https://foreign.invalid"},name).status_code==403
        assert client.post(PATH,headers=auth,content=b"x"*8193).status_code==413
        body={"name":"spending_totals","arguments":{"start":"2026-10-01","end_exclusive":"2026-11-01"}}
        assert client.post(PATH,headers=auth,json=body).json()==client.post("/v1/analysis/tools/execute",headers=auth,json=body).json()


def test_plan_read_preserves_missing_current_expired_and_version_evidence_without_writes(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.planning_clock=lambda:NOW
        # Deliberately different: tool routing must use the planning source clock.
        app.state.bank_clock=lambda:NOW+timedelta(days=10)
        auth=headers(client)
        before=database_facts(database,owners[0])
        missing=query(client,auth,"planning_read")
        assert missing.status_code==200 and missing.json()["result"]["plan"] is None
        assert missing.json()["result"]["evaluated_at"]==NOW.isoformat().replace("+00:00","Z")
        assert database_facts(database,owners[0])==before
        saved=seed_plan(database,owners[0]);identifier=str(saved["id"])
        before=database_facts(database,owners[0])
        direct=client.get(f"/v1/plans/{identifier}").json()
        for arguments in ({},{"plan_id":identifier}):
            response=query(client,auth,"planning_read",**arguments)
            assert response.status_code==200,response.text
            result=response.json()["result"]["plan"]
            assert result["analysis"]==direct["analysis"] and result["current"] is True
            assert result["analysis"]["result"]["amount_minor"]==20000
            assert result["period"]==direct["calculation"]["prepared"]["period"]
            assert "calculation" not in result and "reviewed_inputs" not in result
            assert result["data_version"]==direct["data_version"] and result["plan_version"]==direct["plan_version"]
        assert database_facts(database,owners[0])==before
        app.state.planning_clock=lambda:NOW+timedelta(days=1)
        expired=query(client,auth,"planning_read",plan_id=identifier).json()["result"]["plan"]
        assert expired["current"] is False and expired["period"] is None
        assert expired["analysis"]["status"]=="blocked" and expired["analysis"]["result"]["amount_minor"] is None
        assert expired["analysis"]["blockers"][0]["code"]=="PLANNING_REVIEW_REQUIRED"
        assert database_facts(database,owners[0])==before


def test_population_reference_reuses_verified_public_context_without_personal_selection_or_writes(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=lambda:NOW
        auth=headers(client)
        before=database_facts(database,owners[0])
        response=query(client,auth,"population_reference")
        assert response.status_code==200,response.text
        reference=response.json()["result"]
        assert reference["context"]==client.get("/v1/public/benchmarks/consumption").json()
        assert reference["status"]=="available" and reference["household_selection"]=="not_selected"
        assert reference["personal_comparison"]=="not_performed"
        assert reference["evaluated_at"]==NOW.isoformat().replace("+00:00","Z")
        assert "no-store" in response.headers["cache-control"]
        for extra in ({"household_code":"1"},{"household_coverage_confirmed":True},{"account_ids":[str(owners[0][2])]}):
            assert query(client,auth,"population_reference",**extra).status_code==422
        assert database_facts(database,owners[0])==before


@pytest.mark.parametrize("change",["data_version","plan_version","account","superseded"])
def test_plan_tool_withholds_guidance_after_owned_review_invalidation(database,owners,change):
    saved=seed_plan(database,owners[0]);identifier=str(saved["id"])
    with authenticated_app(database,owners) as (client,app,config):
        app.state.planning_clock=lambda:NOW
        auth=headers(client)
        initial=query(client,auth,"planning_read",plan_id=identifier).json()["result"]["plan"]
        assert initial["current"] is True and initial["analysis"]["result"]["amount_minor"]==20000
        with psycopg.connect(database["admin"]) as connection:
            if change in ("data_version","plan_version"):
                connection.execute(f"UPDATE moneylens.user_state SET {change}={change}+1 WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
            elif change=="account":
                connection.execute("UPDATE moneylens.accounts SET included=false WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",owners[0])
            else:
                connection.execute("UPDATE moneylens.plans SET state='superseded' WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*owners[0][:2],saved["id"]))
        before=database_facts(database,owners[0])
        response=query(client,auth,"planning_read",plan_id=identifier)
        assert response.status_code==200,response.text
        historical=response.json()["result"]["plan"]
        assert_withheld(historical)
        assert historical["data_version"]==initial["data_version"] and historical["plan_version"]==initial["plan_version"]
        current=query(client,auth,"planning_read")
        assert current.status_code==200,current.text
        if change=="superseded":
            assert current.json()["result"]["plan"] is None
        else:
            assert_withheld(current.json()["result"]["plan"])
        assert database_facts(database,owners[0])==before


def test_plan_tool_withholds_reviewed_bank_guidance_after_source_disconnect(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.accounts SET included=false WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=connect(client,app,"s-bank-demo","review-source")
        synchronize(database,client,app,config,auth,started,user)
        context=client.get("/v1/planning/context").json()
        end=(NOW+timedelta(days=31)).isoformat()
        body={"key":"review-bank","expected_data_version":context["data_version"],"expected_plan_version":context["plan_version"],
            "accounts":[{"account_id":item["id"],"balance_snapshot_id":item["balance"]["id"],"inaccessible_minor":0,
                "coverage_confirmed":True,"liability_covered":None} for item in context["accounts"]],
            "protections":[{"id":str(uuid4()),"kind":kind,"amount_minor":0,"reviewed_through":end,"routes":[]}
                for kind in ("essentials","irregular","savings","buffer")],"obligations_reviewed_through":end}
        created=client.post("/v1/plans",headers=auth,json=body)
        assert created.status_code==200,created.text
        identifier=created.json()["plan"]["id"]
        current=query(client,auth,"planning_read",plan_id=identifier)
        assert current.status_code==200,current.text
        assert current.json()["result"]["plan"]["analysis"]["result"]["amount_minor"]==50000
        disconnected=client.post(f"/v1/bank-connections/{started['connection']['id']}/disconnect",headers=auth)
        assert disconnected.status_code==200,disconnected.text
        before=database_facts(database,owners[0])
        for arguments in ({},{"plan_id":identifier}):
            response=query(client,auth,"planning_read",**arguments)
            assert response.status_code==200,response.text
            assert_withheld(response.json()["result"]["plan"])
        assert database_facts(database,owners[0])==before


def test_bank_read_preserves_consent_source_and_expiry_without_secrets_or_provider_calls(database,owners,monkeypatch):
    from app.synthetic_banks import SyntheticBank
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=connect(client,app,"s-bank-demo","bank")
        identifier=started["connection"]["id"]
        synchronize(database,client,app,config,auth,started,user)
        before=database_facts(database,owners[0])
        def no_provider_read(*args,**kwargs): raise AssertionError("Metadata tool cannot fetch bank data")
        monkeypatch.setattr(SyntheticBank,"fetch_transactions",no_provider_read)
        monkeypatch.setattr(SyntheticBank,"fetch_balances",no_provider_read)
        direct=client.get(f"/v1/bank-connections/{identifier}").json()
        for arguments in ({},{"connection_id":identifier}):
            response=query(client,auth,"bank_connections",**arguments)
            assert response.status_code==200,response.text
            rows=response.json()["result"]["rows"];assert len(rows)==1
            row=rows[0]
            assert row["account_count"]==len(direct["account_references"])
            assert all(value==direct[name] for name,value in row.items() if name!="account_count")
            assert not {"account_references","state_token","provider_reference","sync_checkpoint","synthetic_fault","refresh_job_id"}&row.keys()
            assert "no-store" in response.headers["cache-control"]
        assert database_facts(database,owners[0])==before
        app.state.bank_clock=lambda:NOW+timedelta(hours=2)
        expired=query(client,auth,"bank_connections").json()["result"]["rows"][0]
        assert expired["consent_state"]=="expired" and expired["source_observed_at"]==direct["source_observed_at"]
        assert database_facts(database,owners[0])==before
        assert query(client,auth,"bank_connections",connection_id=str(uuid4())).status_code==404


@pytest.mark.parametrize("foreign_index",[1,2])
def test_tool_ids_never_grant_foreign_plan_or_connection_access(database,owners,foreign_index):
    foreign_plan=seed_plan(database,owners[foreign_index])
    with authenticated_app(database,[owners[foreign_index],owners[0]]) as (client,app,config):
        app.state.planning_clock=lambda:NOW
        foreign_auth,foreign_connection,_=connect(client,app,"s-bank-demo","foreign")
        # The same HTTP session switches to the unrelated owned principal.
        own_auth=headers(client,"mika")
        assert query(client,own_auth,"planning_read",plan_id=str(foreign_plan["id"])).status_code==404
        assert query(client,own_auth,"bank_connections",connection_id=foreign_connection["connection"]["id"]).status_code==404
        assert query(client,foreign_auth,"bank_connections").status_code==409


@pytest.mark.parametrize("name",["planning_read","bank_connections","population_reference"])
def test_read_tools_refuse_reviews_commands_scope_authority_and_changed_membership(database,owners,name):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        for extra in ({"key":"command"},{"coverage_confirmed":True},{"confirmed":True},{"amount_minor":100},
                {"owner_user_id":str(owners[1][1])},{"as_of":NOW.isoformat()},{"sql":"select 1"}):
            assert query(client,auth,name,**extra).status_code==422
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.users SET active=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
        assert query(client,auth,name).status_code==401


@pytest.mark.parametrize("name,arguments",[("planning_read",PlanningReadArgumentsV1()),("bank_connections",BankConnectionsArgumentsV1()),
    ("population_reference",PopulationReferenceArgumentsV1())])
def test_cached_finance_tool_decision_cannot_reuse_a_logged_out_session(database,owners,name,arguments):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        call=ToolCall(name,arguments)
        assert client.post("/v1/auth/logout",headers=auth).status_code==204
        before=database_facts(database,owners[0])
        with pytest.raises(AuthError) as error:
            execute_tool(app.state.pools.finance,user,call,identity=app.state.identity,
                cursor_secret=config.session_secret.get_secret_value(),bank_secret=config.session_secret.get_secret_value(),now=NOW)
        assert error.value.status==401
        assert database_facts(database,owners[0])==before
