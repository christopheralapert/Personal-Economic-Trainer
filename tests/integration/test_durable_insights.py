from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID,uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from app.database import TrustedScope
from app.identity import authorized_transaction
from app.insight_worker import run_insights_once
from app.insight_store import InsightStore
from app.insight_records import DismissInsightV1
from app.jobs import JobStore
from identity_support import ORIGIN,authenticated_app
from test_bank_routes import headers
from test_coaching_routes import BODY as PREFERENCES
from test_planning_store import NOW,POLICY,reviewed,store

PATH="/v1/insights"


@contextmanager
def prepared(database,owners):
    data=reviewed(database,owners[0]);data.costs[0].at=NOW+timedelta(days=3);data.balances[0].amount_minor=65000
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.balance_snapshots SET amount_minor=65000 WHERE id=%s",(data.balances[0].id,))
    with store(database,owners[0]) as repository: plan=repository.create(data,POLICY,key="insight-plan")
    with authenticated_app(database,owners) as (client,app,config):
        app.state.insight_clock=app.state.coaching_clock=app.state.planning_clock=lambda:NOW
        auth=headers(client);body={**PREFERENCES,"spending_insights":False}
        response=client.post("/v1/coaching/preferences",headers=auth,json=body);assert response.status_code==200,response.text
        yield client,app,auth,plan


def run(database,owner,now=NOW):
    return run_insights_once(database["runtime"],TrustedScope(*owner[:2]),clock=lambda:now)


def counts(database,owner):
    with psycopg.connect(database["admin"]) as connection:
        return connection.execute("""SELECT data_version,plan_version,goal_version,
            (SELECT count(*) FROM moneylens.insights WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT count(*) FROM moneylens.insight_commands WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT count(*) FROM moneylens.audit_events WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT count(*) FROM moneylens.outbox_events WHERE tenant_id=%s AND owner_user_id=%s)
            FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s""",owner[:2]*5).fetchone()


def correct_cost(database,owner,plan,*,add=False):
    with psycopg.connect(database["admin"]) as connection:
        row=connection.execute("SELECT reviewed_inputs FROM moneylens.plans WHERE id=%s",(plan["id"],)).fetchone()[0]
        row["plan_version"]+=1;row["costs"][0]["amount_minor"]=36000
        if add: row["costs"].append({**row["costs"][0],"id":str(uuid4()),"economic_cost_id":str(uuid4()),"amount_minor":1})
        connection.execute("UPDATE moneylens.plans SET reviewed_inputs=%s,plan_version=%s WHERE id=%s",(Jsonb(row),row["plan_version"],plan["id"]))
        connection.execute("UPDATE moneylens.user_state SET plan_version=%s WHERE tenant_id=%s AND owner_user_id=%s",(row["plan_version"],*owner[:2]))


def test_worker_persists_two_explained_insights_and_identical_jobs_do_not_duplicate_effects(database,owners):
    with prepared(database,owners) as (client,app,auth,plan):
        before=counts(database,owners[0]);assert run(database,owners[0])
        first=client.get(PATH);assert first.status_code==200,first.text
        body=first.json();assert len(body["rows"])==2 and body["collection_version"]==2
        assert all(row["current"] and not row["current_blockers"] for row in body["rows"])
        assert all("evidence" not in row and row["evidence_kind"]=="planning" for row in body["rows"])
        assert {row["candidate"]["kind"]:row["candidate"]["amount_minor"] for row in body["rows"]}=={"upcoming_bill":35000,"low_headroom":5000}
        for row in body["rows"]:
            detail=client.get(f"{PATH}/{row['id']}");assert detail.status_code==200,detail.text
            assert detail.json()["evidence"]["planning"]["plan_id"]==str(plan["id"])
            assert detail.json()["interpretation"]=="stored_rule_snapshot_not_spending_permission"
        after=counts(database,owners[0]);assert after[:3]==before[:3] and after[3:]==(2,0,before[5]+1,before[6]+1)
        assert not run(database,owners[0]);assert client.get(PATH).json()==body
        requested=client.post(PATH+"/refresh",headers=auth,json={"key":"manual-1"});assert requested.status_code==200
        assert client.post(PATH+"/refresh",headers=auth,json={"key":"manual-1"}).json()["id"]==requested.json()["id"]
        assert run(database,owners[0])
        assert counts(database,owners[0])==after and client.get(PATH).json()==body


def test_dismissal_survives_replayed_work_and_corrected_source_without_undismissing(database,owners):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0])
        bill=next(row for row in client.get(PATH).json()["rows"] if row["candidate"]["kind"]=="upcoming_bill")
        command={"key":"dismiss-1","expected_insight_version":bill["version"]}
        receipt=client.post(f"{PATH}/{bill['id']}/dismiss",headers=auth,json=command);assert receipt.status_code==200,receipt.text
        assert client.post(f"{PATH}/{bill['id']}/dismiss",headers=auth,json=command).json()==receipt.json()
        assert len(client.get(PATH).json()["rows"])==1
        client.post(PATH+"/refresh",headers=auth,json={"key":"replay"});assert run(database,owners[0])
        assert len(client.get(PATH).json()["rows"])==1
        correct_cost(database,owners[0],plan)
        assert all(not row["current"] for row in client.get(PATH).json()["rows"])
        assert run(database,owners[0])
        hidden=client.get(PATH,params={"status":"dismissed"}).json()["rows"]
        assert len(hidden)==1 and hidden[0]["candidate"]["amount_minor"]==36000 and hidden[0]["dismissed_at"]
        assert hidden[0]["current"] is False
        assert client.post(f"{PATH}/{bill['id']}/dismiss",headers=auth,json=command).json()==receipt.json()
        active=client.get(PATH).json()["rows"];assert len(active)==1 and active[0]["candidate"]["amount_minor"]==4000


@pytest.mark.parametrize("choice",["disabled","paused","kind"])
def test_live_preference_changes_immediately_block_current_claims_and_worker_supersedes(database,owners,choice):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0])
        change={"coaching_enabled":False} if choice=="disabled" else {"paused_until":(NOW+timedelta(hours=1)).isoformat()} if choice=="paused" else {"bill_insights":False,"headroom_insights":False}
        response=client.post("/v1/coaching/preferences",headers=auth,json={**PREFERENCES,"key":"change","expected_preferences_version":2,"spending_insights":False,**change})
        assert response.status_code==200,response.text
        assert all(not row["current"] for row in client.get(PATH).json()["rows"])
        assert run(database,owners[0])
        assert client.get(PATH).json()["rows"]==[]
        assert len(client.get(PATH,params={"status":"superseded"}).json()["rows"])==2


def test_expired_quote_is_historical_before_worker_and_superseded_afterward(database,owners):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0]);app.state.insight_clock=lambda:NOW+timedelta(minutes=6)
        rows=client.get(PATH).json()["rows"];assert len(rows)==2
        assert all(not row["current"] and "INSIGHT_EVIDENCE_EXPIRED" in row["current_blockers"] for row in rows)
        assert run(database,owners[0],NOW+timedelta(minutes=6))
        assert client.get(PATH).json()["rows"]==[]


def test_signed_summary_pages_bind_owner_status_collection_and_preferences(database,owners):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0])
        first=client.get(PATH,params={"limit":1}).json();cursor=first["next_cursor"];assert cursor
        second=client.get(PATH,params={"limit":1,"cursor":cursor}).json()
        assert second["next_cursor"] is None and second["rows"][0]["id"]!=first["rows"][0]["id"]
        assert client.get(PATH,params={"cursor":cursor,"status":"dismissed"}).status_code==409
        assert client.get(PATH,params={"cursor":cursor[:-3]+"bad"}).status_code==400
        identifier=first["rows"][0]["id"]
        assert client.post(f"{PATH}/{identifier}/dismiss",headers=auth,json={"key":"dismiss","expected_insight_version":1}).status_code==200
        assert client.get(PATH,params={"cursor":cursor}).status_code==409
        other=headers(client,"mika")
        assert client.get(PATH,params={"cursor":cursor}).status_code==409
        assert client.get(f"{PATH}/{identifier}").status_code==404
        assert client.post(f"{PATH}/{identifier}/dismiss",headers=other,json={"key":"foreign","expected_insight_version":1}).status_code==404
        assert client.get(PATH).json()["rows"]==[]


def test_outbox_failure_rolls_back_all_insights_and_collection_and_retry_is_atomic(database,owners,monkeypatch):
    with prepared(database,owners) as (client,app,auth,plan):
        before=counts(database,owners[0]);original=JobStore.emit
        def fail(self,kind,*args,**kwargs):
            if kind=="insights.refreshed": raise RuntimeError("owned refresh outbox failure")
            return original(self,kind,*args,**kwargs)
        with monkeypatch.context() as patch:
            patch.setattr(JobStore,"emit",fail);assert run(database,owners[0])
        assert counts(database,owners[0])==before
        assert client.get(PATH).json()["collection_version"]==1
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.jobs SET available_at=clock_timestamp()-interval '1 second' WHERE tenant_id=%s AND owner_user_id=%s AND type='coaching.refresh'",owners[0][:2])
        assert run(database,owners[0]);assert len(client.get(PATH).json()["rows"])==2


def test_opt_out_before_queued_job_prevents_generation_and_refresh_exact_retry_is_available(database,owners):
    with prepared(database,owners) as (client,app,auth,plan):
        requested=client.post(PATH+"/refresh",headers=auth,json={"key":"queued"});assert requested.status_code==200
        disabled=client.post("/v1/coaching/preferences",headers=auth,json={**PREFERENCES,"key":"disable","expected_preferences_version":2,"coaching_enabled":False})
        assert disabled.status_code==200
        assert client.post(PATH+"/refresh",headers=auth,json={"key":"queued"}).json()["id"]==requested.json()["id"]
        assert client.post(PATH+"/refresh",headers=auth,json={"key":"new"}).status_code==409
        assert run(database,owners[0]);assert client.get(PATH).json()["rows"]==[]
        assert counts(database,owners[0])[3:5]==(0,0)


def test_dismissal_rollback_and_stale_versions_have_no_partial_effect(database,owners,monkeypatch):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0]);row=client.get(PATH).json()["rows"][0];before=counts(database,owners[0])
        original=JobStore.emit
        def fail(self,kind,*args,**kwargs):
            if kind=="insights.dismissed": raise RuntimeError("owned dismissal failure")
            return original(self,kind,*args,**kwargs)
        command={"key":"dismiss","expected_insight_version":1}
        with monkeypatch.context() as patch:
            patch.setattr(JobStore,"emit",fail)
            response=client.post(f"{PATH}/{row['id']}/dismiss",headers=auth,json=command)
            assert response.status_code==500 and "owned dismissal failure" not in response.text
        assert counts(database,owners[0])==before and len(client.get(PATH).json()["rows"])==2
        assert client.post(f"{PATH}/{row['id']}/dismiss",headers=auth,json=command).status_code==200
        assert client.post(f"{PATH}/{row['id']}/dismiss",headers=auth,json={**command,"key":"stale"}).status_code==409


def test_new_refresh_budget_is_bounded_and_exact_replay_bypasses_quota(database,owners):
    with prepared(database,owners) as (client,app,auth,plan):
        first=client.post(PATH+"/refresh",headers=auth,json={"key":"refresh-0"});assert first.status_code==200
        for index in range(1,20): assert client.post(PATH+"/refresh",headers=auth,json={"key":f"refresh-{index}"}).status_code==200
        assert client.post(PATH+"/refresh",headers=auth,json={"key":"overflow"}).status_code==429
        assert client.post(PATH+"/refresh",headers=auth,json={"key":"refresh-0"}).json()["id"]==first.json()["id"]


def test_auth_csrf_size_closed_arguments_and_receipt_rls(database,owners):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0]);row=client.get(PATH).json()["rows"][0]
        assert client.post(PATH+"/refresh",headers={"Origin":ORIGIN},json={"key":"unsafe"}).status_code==403
        assert client.post(PATH+"/refresh",headers=auth,content=b"x"*8193).status_code==413
        assert client.post(PATH+"/refresh",headers=auth,json={"key":"unsafe","amount_minor":1}).status_code==422
        assert client.post(f"{PATH}/{row['id']}/dismiss",headers=auth,json={"key":"wrong","expected_insight_version":True}).status_code==422
        receipt=client.post(f"{PATH}/{row['id']}/dismiss",headers=auth,json={"key":"dismiss","expected_insight_version":1}).json()
        from app.database import tenant_transaction
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            with tenant_transaction(connection,TrustedScope(*owners[2][:2])):
                assert connection.execute("SELECT id FROM moneylens.insights").fetchall()==[]
                assert connection.execute("SELECT id FROM moneylens.insight_commands").fetchall()==[]
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with tenant_transaction(connection,TrustedScope(*owners[0][:2])):
                    connection.execute("UPDATE moneylens.insight_commands SET receipt='{}' WHERE id=%s",(receipt["id"],))
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.users SET active=false,permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
        assert not run(database,owners[0])
        assert client.get(PATH).status_code==401 and client.get(f"{PATH}/{row['id']}").status_code==401


def test_published_spending_candidates_keep_full_evidence_and_become_noncurrent_after_revocation(database,owners):
    from test_bank_publication import connect,synchronize
    from test_ledger import put
    with authenticated_app(database,owners) as (client,app,config):
        app.state.insight_clock=app.state.coaching_clock=lambda:NOW
        auth,first,user=connect(client,app,"s-bank-demo","insight-spending-first")
        synchronize(database,client,app,config,auth,first,user)
        auth,second,user=connect(client,app,"north-demo","insight-spending-north")
        synchronize(database,client,app,config,auth,second,user,key="insight-spending-north-refresh")
        account=next(item for item in client.get("/v1/accounts/sources").json() if item["source"])
        with psycopg.connect(database["admin"]) as connection:
            # Fixture-only empty account is explicitly outside this scope. Add
            # owned canonical historical rows to exercise a non-thin sample.
            connection.execute("UPDATE moneylens.accounts SET included=false WHERE id=%s",(owners[0][2],))
            for day in ("2026-09-10","2026-09-12","2026-09-14"):
                put(connection,(*owners[0][:2],UUID(account["id"])),day=day,amount=-1000,category="dining")
            for day in ("2026-10-10","2026-10-12","2026-10-14"):
                put(connection,(*owners[0][:2],UUID(account["id"])),day=day,amount=-50000,category="dining")
            connection.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
        response=client.post("/v1/coaching/preferences",headers=auth,json={**PREFERENCES,"bill_insights":False,"headroom_insights":False})
        assert response.status_code==200,response.text
        before=counts(database,owners[0]);assert run(database,owners[0])
        rows=client.get(PATH).json()["rows"];assert len(rows)==1,rows
        assert rows[0]["current"] and rows[0]["candidate"]["kind"]=="higher_observed_spending"
        detail=client.get(f"{PATH}/{rows[0]['id']}").json()
        comparison=detail["evidence"]["comparison"]
        assert comparison["status"]=="covered_comparison" and comparison["current"]["scope"]["sources"]
        assert rows[0]["candidate"]["amount_minor"]==comparison["change"]["net_minor"]>0
        assert counts(database,owners[0])[:3]==before[:3]
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.connections SET sync_health='error' WHERE id=%s",(first["connection"]["id"],))
        changed=client.get(f"{PATH}/{rows[0]['id']}").json()
        assert changed["current"] is False and "SPENDING_SOURCE_REVIEW_REQUIRED" in changed["current_blockers"]
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.connections SET sync_health='fresh' WHERE id=%s",(first["connection"]["id"],))
        assert client.get(f"{PATH}/{rows[0]['id']}").json()["current"] is True
        assert client.post(f"/v1/bank-connections/{first['connection']['id']}/disconnect",headers=auth,json={}).status_code==200
        assert client.get(f"{PATH}/{rows[0]['id']}").json()["current"] is False
        client.post(PATH+"/refresh",headers=auth,json={"key":"after-revocation"})
        assert run(database,owners[0]);assert client.get(PATH).json()["rows"]==[]


@pytest.mark.parametrize("boundary",["collection","record","history"])
def test_version_and_retained_history_limits_roll_back_worker_effects(database,owners,boundary):
    with prepared(database,owners) as (client,app,auth,plan):
        assert run(database,owners[0]);original=client.get(PATH).json()["rows"]
        with psycopg.connect(database["admin"]) as connection:
            if boundary=="collection": connection.execute("UPDATE moneylens.insight_collections SET version=%s WHERE tenant_id=%s AND owner_user_id=%s",(2**53-1,*owners[0][:2]))
            elif boundary=="record": connection.execute("UPDATE moneylens.insights SET version=%s WHERE id=%s AND tenant_id=%s AND owner_user_id=%s",(2**53-1,original[0]["id"],*owners[0][:2]))
            else:
                for _ in range(998):
                    identifier=uuid4()
                    connection.execute("""INSERT INTO moneylens.insights (tenant_id,owner_user_id,id,kind,status,version,data_version,plan_version,
                        preferences_version,permission_version,candidate,evidence,fingerprint,generated_at,expires_at,created_at,updated_at)
                        SELECT tenant_id,owner_user_id,%s,kind,'superseded',1,data_version,plan_version,preferences_version,permission_version,
                            jsonb_set(candidate,'{id}',to_jsonb(%s::text)),evidence,fingerprint,generated_at,expires_at,created_at,updated_at
                        FROM moneylens.insights WHERE id=%s AND tenant_id=%s AND owner_user_id=%s""",(identifier,str(identifier),original[0]["id"],*owners[0][:2]))
        correct_cost(database,owners[0],plan,add=boundary=="history")
        before=counts(database,owners[0]);assert run(database,owners[0])
        assert counts(database,owners[0])==before
        with psycopg.connect(database["admin"]) as connection:
            job=connection.execute("SELECT state,last_error_code FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s AND type='coaching.refresh' ORDER BY created_at DESC LIMIT 1",owners[0][:2]).fetchone()
            assert job==("dead_letter","coaching_context_unavailable")


def test_opted_out_default_never_creates_jobs_insights_or_collection_rows(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        assert not run(database,owners[0])
        page=client.get(PATH);assert page.status_code==200,page.text
        assert page.json()["rows"]==[] and page.json()["collection_version"]==1
        assert client.post(PATH+"/refresh",headers=auth,json={"key":"not-opted-in"}).status_code==409
        with psycopg.connect(database["admin"]) as connection:
            for table in ("jobs","insights","insight_collections","coaching_preferences"):
                assert connection.execute("SELECT count(*) FROM moneylens."+table+" WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()==(0,)


def test_competing_workers_and_dismissals_have_one_effect_per_source_or_command(database,owners):
    from app.identity import AuthError
    with prepared(database,owners) as (client,app,auth,plan):
        before=counts(database,owners[0])
        with ThreadPoolExecutor(max_workers=2) as workers:
            results=list(workers.map(lambda _:run(database,owners[0]),range(2)))
        assert sorted(results)==[False,True]
        after=counts(database,owners[0]);assert after[3:]==(2,0,before[5]+1,before[6]+1)
        rows=client.get(PATH).json()["rows"];user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        def dismiss(identifier,key):
            try:
                with app.state.pools.finance.connection() as connection:
                    return InsightStore(connection,user,clock=lambda:NOW).dismiss(UUID(identifier),DismissInsightV1(key=key,expected_insight_version=1))
            except AuthError as error: return error
        with ThreadPoolExecutor(max_workers=2) as workers:
            first,second=list(workers.map(lambda _:dismiss(rows[0]["id"],"same"),range(2)))
        assert first==second and first.insight_id==UUID(rows[0]["id"])
        with ThreadPoolExecutor(max_workers=2) as workers:
            different=list(workers.map(lambda key:dismiss(rows[1]["id"],key),["different-a","different-b"]))
        assert sum(isinstance(result,AuthError) for result in different)==1
        assert client.get(PATH).json()["rows"]==[]
        assert counts(database,owners[0])[4]==2
