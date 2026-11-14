"""Persisted coaching tool reads retain ownership, freshness and no-write semantics."""
from datetime import timedelta
from uuid import UUID,uuid4

import psycopg
import pytest
from pydantic import TypeAdapter

from app.analysis_tools import (AnalysisToolResultV1,CoachingPreferencesArgumentsV1,InsightDetailsArgumentsV1,
    InsightListArgumentsV1,execute_tool)
from app.identity import AuthError
from app.model_adapter import ToolCall
from identity_support import authenticated_app
from test_bank_routes import headers
from test_coaching_routes import BODY as PREFERENCES
from test_durable_insights import NOW,counts,correct_cost,prepared,run

PATH="/v1/analysis/tools/execute"


def execute(client,auth,name,**arguments):
    return client.post(PATH,headers=auth,json={"name":name,"arguments":arguments})


def facts(database,owner):
    with psycopg.connect(database["admin"]) as connection:
        names=("coaching_preferences","coaching_commands","insight_collections","jobs","reserves","allocations")
        rows=tuple(connection.execute("SELECT count(*) FROM moneylens."+name+" WHERE tenant_id=%s AND owner_user_id=%s",owner[:2]).fetchone()[0] for name in names)
    return counts(database,owner),rows


def test_insight_tools_match_direct_owned_services_without_model_or_write_effects(database,owners,monkeypatch):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0])
        # An unrelated source clock must not replace these services' own clocks.
        app.state.bank_clock=lambda:NOW+timedelta(days=10)
        async def forbidden(*args,**kwargs): raise AssertionError("Coaching reads cannot invoke a model")
        monkeypatch.setattr(app.state.model,"decide",forbidden)
        first=client.get("/v1/insights").json();identifier=first["rows"][0]["id"]
        before=facts(database,owners[0]);adapter=TypeAdapter(AnalysisToolResultV1)
        for name,arguments,path in [
            ("insight_list",{},"/v1/insights"),
            ("insight_details",{"insight_id":identifier},"/v1/insights/"+identifier),
            ("coaching_preferences",{},"/v1/coaching/preferences"),
        ]:
            response=execute(client,auth,name,**arguments);assert response.status_code==200,response.text
            assert response.json()=={"name":name,"result":client.get(path).json()}
            assert adapter.validate_json(response.content).name==name
            assert "no-store" in response.headers["cache-control"]
        assert all("evidence" not in row for row in execute(client,auth,"insight_list").json()["result"]["rows"])
        detail=execute(client,auth,"insight_details",insight_id=identifier).json()["result"]
        assert detail["current"] and detail["evidence"]["kind"]=="planning"
        assert detail["interpretation"]=="stored_rule_snapshot_not_spending_permission"
        assert facts(database,owners[0])==before


def test_opted_out_default_reads_create_no_preferences_jobs_or_collection(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.insight_clock=app.state.coaching_clock=lambda:NOW
        auth=headers(client);before=facts(database,owners[0])
        for _ in range(2):
            preferences=execute(client,auth,"coaching_preferences");assert preferences.status_code==200,preferences.text
            value=preferences.json()["result"]
            assert value["version"]==1 and value["coaching_enabled"] is False and value["created_at"] is None
            assert value["state"]["external_delivery_available"] is False
            page=execute(client,auth,"insight_list").json()["result"]
            assert page["rows"]==[] and page["collection_version"]==1
        assert facts(database,owners[0])==before


@pytest.mark.parametrize("foreign_index",[1,2])
def test_insight_ids_and_signed_pages_cannot_cross_user_or_tenant(database,owners,foreign_index):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0]);first=execute(client,auth,"insight_list",limit=1).json()["result"]
        identifier=uuid4();original=first["rows"][0]["id"]
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("""INSERT INTO moneylens.insights (tenant_id,owner_user_id,id,kind,status,version,data_version,plan_version,
                preferences_version,permission_version,candidate,evidence,fingerprint,generated_at,expires_at,created_at,updated_at)
                SELECT %s,%s,%s,kind,status,version,data_version,plan_version,preferences_version,permission_version,
                    jsonb_set(candidate,'{id}',to_jsonb(%s::text)),evidence,fingerprint,generated_at,expires_at,created_at,updated_at
                FROM moneylens.insights WHERE id=%s AND tenant_id=%s AND owner_user_id=%s""",
                (*owners[foreign_index][:2],identifier,str(identifier),original,*owners[0][:2]))
        response=execute(client,auth,"insight_details",insight_id=str(identifier))
        assert response.status_code==404
        assert str(identifier) not in str(execute(client,auth,"insight_list").json())
        other=headers(client,"mika")
        assert execute(client,other,"insight_details",insight_id=original).status_code==404
        assert execute(client,other,"insight_list",cursor=first["next_cursor"]).status_code==409
        assert execute(client,other,"coaching_preferences").json()["result"]["coaching_enabled"] is False
        assert execute(client,auth,"insight_list").status_code==409


@pytest.mark.parametrize("change",["status","collection","data","plan","preferences","signature"])
def test_insight_cursor_binds_exact_filters_versions_and_signature(database,owners,change):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0]);first=execute(client,auth,"insight_list",limit=1).json()["result"]
        cursor=first["next_cursor"];assert cursor
        second=execute(client,auth,"insight_list",limit=1,cursor=cursor);assert second.status_code==200,second.text
        assert second.json()["result"]==client.get("/v1/insights",params={"limit":1,"cursor":cursor}).json()
        arguments={"cursor":cursor}
        if change=="status": arguments["status"]="dismissed"
        elif change=="signature": arguments["cursor"]=cursor[:-1]+("A" if cursor[-1]!="A" else "B")
        elif change=="collection":
            row=first["rows"][0]
            assert client.post(f"/v1/insights/{row['id']}/dismiss",headers=auth,json={"key":"cursor-dismiss","expected_insight_version":row["version"]}).status_code==200
        elif change=="preferences":
            assert client.post("/v1/coaching/preferences",headers=auth,json={**PREFERENCES,"key":"cursor-prefs","expected_preferences_version":2}).status_code==200
        else:
            with psycopg.connect(database["admin"]) as connection:
                field=change+"_version"
                connection.execute("UPDATE moneylens.user_state SET "+field+"="+field+"+1 WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
        assert execute(client,auth,"insight_list",**arguments).status_code in (400,409)


def test_history_reads_preserve_dismissal_expiry_and_opt_out_as_noncurrent_evidence(database,owners):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0]);rows=execute(client,auth,"insight_list").json()["result"]["rows"]
        identifier=rows[0]["id"]
        assert client.post(f"/v1/insights/{identifier}/dismiss",headers=auth,json={"key":"history-dismiss","expected_insight_version":1}).status_code==200
        dismissed=execute(client,auth,"insight_list",status="dismissed").json()["result"]["rows"][0]
        assert dismissed["id"]==identifier and not dismissed["current"] and "INSIGHT_NOT_ACTIVE" in dismissed["current_blockers"]
        detail=execute(client,auth,"insight_details",insight_id=identifier).json()["result"]
        assert detail["evidence"]["kind"]=="planning" and detail["dismissed_at"]
        current_id=rows[1]["id"]
        app.state.insight_clock=lambda:NOW+timedelta(minutes=5)
        expired=execute(client,auth,"insight_details",insight_id=current_id).json()["result"]
        assert not expired["current"] and "INSIGHT_EVIDENCE_EXPIRED" in expired["current_blockers"]
        app.state.insight_clock=lambda:NOW
        assert client.post("/v1/coaching/preferences",headers=auth,json={**PREFERENCES,"key":"history-disable","expected_preferences_version":2,"coaching_enabled":False}).status_code==200
        inactive=execute(client,auth,"insight_details",insight_id=current_id).json()["result"]
        assert not inactive["current"] and "COACHING_DISABLED_PAUSED_OR_KIND_DISABLED" in inactive["current_blockers"]
        assert run(database,owners[0])
        previous=execute(client,auth,"insight_list",status="superseded").json()["result"]["rows"]
        assert [row["id"] for row in previous]==[current_id] and not previous[0]["current"]


@pytest.mark.parametrize("change",["membership","logout","profile"])
def test_saved_insight_tool_decisions_cannot_reuse_revoked_session_or_membership(database,owners,change):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0]);identifier=client.get("/v1/insights").json()["rows"][0]["id"]
        user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        calls=[ToolCall("insight_list",InsightListArgumentsV1()),
            ToolCall("insight_details",InsightDetailsArgumentsV1(insight_id=UUID(identifier))),
            ToolCall("coaching_preferences",CoachingPreferencesArgumentsV1())]
        if change=="membership":
            with psycopg.connect(database["admin"]) as connection:
                connection.execute("UPDATE moneylens.users SET active=false,permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
        elif change=="logout": assert client.post("/v1/auth/logout",headers=auth).status_code==204
        else: headers(client,"mika")
        for call in calls:
            with pytest.raises(AuthError):
                execute_tool(app.state.pools.finance,user,call,identity=app.state.identity,
                    cursor_secret=app.state.settings.session_secret.get_secret_value(),now=NOW)


def test_read_tool_boundary_rejects_coaching_writes_and_requires_current_csrf_session(database,owners):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0]);identifier=client.get("/v1/insights").json()["rows"][0]["id"]
        before=facts(database,owners[0])
        for name in ("insight_refresh","insight_dismiss","coaching_enable","coaching_set_preferences"):
            assert execute(client,auth,name).status_code==422
        for name,arguments in [("insight_list",{}),("insight_details",{"insight_id":identifier}),("coaching_preferences",{})]:
            for extra in ({"key":"write"},{"coaching_enabled":True},{"owner_user_id":str(owners[1][1])},{"current":True},{"as_of":NOW.isoformat()}):
                assert execute(client,auth,name,**arguments,**extra).status_code==422
            assert execute(client,{},name,**arguments).status_code==403
            assert execute(client,{**auth,"X-MoneyLens-Session-ID":str(uuid4())},name,**arguments).status_code==409
        assert client.post(PATH,headers=auth,content=b"x"*8193).status_code==413
        assert execute(client,auth,"insight_list",limit=True).status_code==422
        assert facts(database,owners[0])==before
