from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta,timezone
from uuid import UUID,uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest
from alembic import command

from app.database import TrustedScope,tenant_transaction
from app.goal_store import GoalStore
from app.goals import CreateGoalV1
from app.identity import AuthError
from app.jobs import JobStore
from identity_support import ORIGIN,authenticated_app
from test_bank_routes import headers

NOW=datetime(2026,11,5,10,tzinfo=timezone.utc)
BODY=dict(key="create-1",name="Emergency fund",target_minor=10000,currency="EUR",deadline="2026-11-15",priority=2)


def create(client,auth,**changes):
    response=client.post("/v1/goals",headers=auth,json={**BODY,**changes})
    assert response.status_code==200,response.text
    return response.json()


def facts(database,owner):
    with psycopg.connect(database["admin"]) as connection:
        return connection.execute("""SELECT data_version,plan_version,goal_version,
            (SELECT count(*) FROM moneylens.goals WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT count(*) FROM moneylens.goal_commands WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT count(*) FROM moneylens.audit_events WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT count(*) FROM moneylens.outbox_events WHERE tenant_id=%s AND owner_user_id=%s)
            FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s""",owner[:2]*5).fetchone()


def test_lifecycle_is_versioned_replayable_and_never_changes_financial_versions(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.goal_clock=lambda:NOW;auth=headers(client)
        first=create(client,auth);identifier=first["goal"]["id"]
        assert first["goal"]["version"]==1 and first["collection_version"]==2 and first["historical_command_snapshot"] is True
        assert create(client,auth)==first
        view=client.get(f"/v1/goals/{identifier}");assert view.status_code==200
        assert "no-store" in view.headers["cache-control"]
        progress=view.json()["progress"]
        assert progress["recorded_reserved_minor"]==0 and progress["reservation_gap_minor"]==10000
        assert progress["confirmed_saved_minor"] is None and progress["required_daily_reservation_minor"]==1000
        pause=dict(key="pause-1",expected_goal_version=1,state="paused")
        paused=client.post(f"/v1/goals/{identifier}/state",headers=auth,json=pause)
        assert paused.status_code==200 and paused.json()["goal"]["version"]==2 and paused.json()["goal"]["state"]=="paused"
        revise={**BODY,"key":"revise-1","expected_goal_version":2,"name":"Travel fund","priority":1,"target_minor":20000}
        revised=client.post(f"/v1/goals/{identifier}/revise",headers=auth,json=revise)
        assert revised.status_code==200 and revised.json()["goal"]["version"]==3
        assert client.post(f"/v1/goals/{identifier}/state",headers=auth,json={**pause,"key":"stale"}).status_code==409
        removed=client.post(f"/v1/goals/{identifier}/remove",headers=auth,json={"key":"remove-1","expected_goal_version":3})
        assert removed.status_code==200 and removed.json()["goal"]["state"]=="removed" and removed.json()["goal"]["version"]==4
        assert client.get("/v1/goals").json()["rows"]==[]
        assert client.get("/v1/goals?state=removed").json()["rows"][0]["id"]==identifier
        assert client.post(f"/v1/goals/{identifier}/state",headers=auth,json={**pause,"key":"reopen","expected_goal_version":4}).json()["error"]["code"]=="GOAL_REMOVED"
        assert create(client,auth)==first  # historical creation does not reactivate
        assert client.post(f"/v1/goals/{identifier}/state",headers=auth,json=pause).json()==paused.json()
        assert client.post("/v1/goals",headers=auth,json={**BODY,"name":"Conflicting replay"}).json()["error"]["code"]=="IDEMPOTENCY_CONFLICT"
        assert facts(database,owners[0])==(1,1,5,1,4,4,4)
        with psycopg.connect(database["admin"]) as connection:
            payloads=connection.execute("SELECT payload FROM moneylens.outbox_events WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchall()
            assert all("Emergency fund" not in str(payload) and "Travel fund" not in str(payload) for payload in payloads)


@pytest.mark.parametrize("foreign",[1,2])
def test_goal_and_receipt_scope_cannot_cross_owner_or_tenant(database,owners,foreign):
    with psycopg.connect(database["admin"]) as connection:
        goal_id=uuid4()
        connection.execute("INSERT INTO moneylens.goals (tenant_id,owner_user_id,id,name,target_minor,currency,deadline,state) VALUES (%s,%s,%s,'Private',1000,'EUR','2026-12-01','active')",(*owners[foreign][:2],goal_id))
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        assert client.get(f"/v1/goals/{goal_id}").status_code==404
        for action,body in (("revise",{**BODY,"expected_goal_version":1}),("state",dict(key="foreign-state",expected_goal_version=1,state="paused")),("remove",dict(key="foreign-remove",expected_goal_version=1))):
            assert client.post(f"/v1/goals/{goal_id}/{action}",headers=auth,json=body).status_code==404
        assert client.get("/v1/goals").json()["rows"]==[]


def test_concurrent_retries_create_once_and_competing_versions_have_one_winner(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client);user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        def attempt_create():
            with app.state.pools.finance.connection() as connection:
                return GoalStore(connection,user,clock=lambda:NOW).create(CreateGoalV1(**BODY)).model_dump(mode="json")
        with ThreadPoolExecutor(max_workers=2) as workers: first,second=list(workers.map(lambda _:attempt_create(),range(2)))
        assert first==second and facts(database,owners[0])==(1,1,2,1,1,1,1)
        identifier=first["goal"]["id"]
        with ThreadPoolExecutor(max_workers=2) as workers:
            responses=list(workers.map(lambda key:client.post(f"/v1/goals/{identifier}/state",headers=auth,
                json={"key":key,"expected_goal_version":1,"state":"paused"}),["pause-a","pause-b"]))
        assert sorted(response.status_code for response in responses)==[200,409]
        assert facts(database,owners[0])==(1,1,3,1,2,2,2)


def test_signed_paging_preserves_priority_and_binds_filters_owner_and_versions(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        identifiers=[create(client,auth,key=f"create-{index}",priority=priority)["goal"]["id"] for index,priority in enumerate([3,1,2])]
        first=client.get("/v1/goals?limit=1").json();assert first["rows"][0]["id"]==identifiers[1]
        cursor=first["next_cursor"];assert cursor
        second=client.get("/v1/goals",params={"limit":1,"cursor":cursor}).json()
        third=client.get("/v1/goals",params={"limit":1,"cursor":second["next_cursor"]}).json()
        assert [second["rows"][0]["id"],third["rows"][0]["id"]]==[identifiers[2],identifiers[0]] and third["next_cursor"] is None
        assert client.get("/v1/goals",params={"cursor":cursor,"currency":"USD"}).status_code==409
        assert client.get("/v1/goals",params={"cursor":cursor,"state":"active"}).status_code==409
        assert client.get("/v1/goals",params={"cursor":cursor[:-3]+"abc"}).status_code==400
        create(client,auth,key="fourth")
        assert client.get("/v1/goals",params={"cursor":cursor}).status_code==409
        new_cursor=client.get("/v1/goals?limit=1").json()["next_cursor"]
        other=headers(client,"mika")
        assert client.get("/v1/goals",headers={"X-MoneyLens-Session-ID":other["X-MoneyLens-Session-ID"]},params={"cursor":new_cursor}).status_code==409
        assert client.get("/v1/goals").json()["rows"]==[]


def test_goal_command_and_outbox_rollback_together_and_retry_is_safe(database,owners,monkeypatch):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client);before=facts(database,owners[0])
        def fail(*args,**kwargs): raise RuntimeError("synthetic outbox failure")
        with monkeypatch.context() as patch:
            patch.setattr(JobStore,"emit",fail)
            response=client.post("/v1/goals",headers=auth,json=BODY)
            assert response.status_code==500 and "synthetic outbox failure" not in response.text
        assert facts(database,owners[0])==before
        assert create(client,auth)["goal"]["version"]==1


def test_goal_origin_csrf_expected_session_body_and_authority_checks(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.get("/v1/goals").status_code==401
        assert client.post("/v1/goals",json=BODY).status_code==401
        auth=headers(client)
        assert client.post("/v1/goals",headers={"Origin":ORIGIN},json=BODY).status_code==403
        assert client.post("/v1/goals",headers={**auth,"Origin":"https://foreign.invalid"},json=BODY).status_code==403
        assert client.post("/v1/goals",headers={**auth,"X-MoneyLens-Session-ID":str(uuid4())},json=BODY).status_code==409
        assert client.post("/v1/goals",headers=auth,content=b"x"*8193).status_code==413
        for update in ({"confirmed_saved_minor":5000},{"owner_user_id":str(owners[1][1])},{"priority":True},{"target_minor":"10000"},{"state":"completed"}):
            assert client.post("/v1/goals",headers=auth,json={**BODY,**update}).status_code==422
        assert client.get("/v1/goals?limit=101").status_code==422
        assert client.get("/v1/goals?currency=usd").status_code==422


def test_bounded_goal_command_budget_allows_exact_replay_after_throttle(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.goal_clock=lambda:NOW;auth=headers(client);first=create(client,auth)
        with psycopg.connect(database["admin"]) as connection:
            for index in range(99):
                connection.execute("""INSERT INTO moneylens.goal_commands (tenant_id,owner_user_id,id,goal_id,command_key,action,request_fingerprint,applied_at,receipt)
                    VALUES (%s,%s,%s,%s,%s,'create',%s,%s,'{}')""",(*owners[0][:2],uuid4(),first["goal"]["id"],f"quota-{index}","0"*64,NOW))
        response=client.post("/v1/goals",headers=auth,json={**BODY,"key":"new-key"})
        assert response.status_code==429 and response.json()["error"]["code"]=="GOAL_COMMAND_THROTTLED"
        assert response.headers["retry-after"]=="3600"
        assert create(client,auth)==first
        app.state.goal_clock=lambda:NOW+timedelta(hours=1,seconds=1)
        assert create(client,auth,key="new-key")["goal"]["id"]!=first["goal"]["id"]


def test_membership_recheck_blocks_a_previously_resolved_goal_writer(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client);user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.users SET active=false,permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
        with app.state.pools.finance.connection() as connection:
            with pytest.raises(AuthError): GoalStore(connection,user).create(CreateGoalV1(**BODY))
        assert client.post("/v1/goals",headers=auth,json=BODY).status_code==401
        assert facts(database,owners[0])[:5]==(1,1,1,0,0)


def test_retained_goal_cap_is_per_owner_and_cannot_be_evaded_by_removal(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        with connection.cursor() as cursor:
            cursor.executemany("""INSERT INTO moneylens.goals (tenant_id,owner_user_id,id,name,target_minor,currency,deadline,state)
                VALUES (%s,%s,%s,'Retained fixture goal',1000,'EUR','2026-12-01','removed')""",
                [(*owners[0][:2],uuid4()) for _ in range(1000)])
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        response=client.post("/v1/goals",headers=auth,json=BODY)
        assert response.status_code==409 and response.json()["error"]["code"]=="GOAL_LIMIT_REACHED"
        assert facts(database,owners[0])==(1,1,1,1000,0,0,0)
        other=headers(client,"mika");assert create(client,other)["goal"]["version"]==1


def test_collection_version_exhaustion_rolls_back_goal_and_all_effects(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.user_state SET goal_version=%s WHERE tenant_id=%s AND owner_user_id=%s",(2**53-1,*owners[0][:2]))
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        response=client.post("/v1/goals",headers=auth,json=BODY)
        assert response.status_code==409 and response.json()["error"]["code"]=="GOAL_VERSION_EXHAUSTED"
        assert facts(database,owners[0])==(1,1,2**53-1,0,0,0,0)


def test_goal_receipt_rls_is_owner_scoped_and_receipts_are_immutable(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client);first=create(client,auth)
    with psycopg.connect(database["runtime"],autocommit=True) as connection:
        with tenant_transaction(connection,TrustedScope(*owners[1][:2])):
            assert connection.execute("SELECT id FROM moneylens.goal_commands").fetchall()==[]
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with tenant_transaction(connection,TrustedScope(*owners[0][:2])):
                connection.execute("UPDATE moneylens.goal_commands SET receipt='{}' WHERE id=%s",(first["id"],))
        with tenant_transaction(connection,TrustedScope(*owners[0][:2])):
            assert connection.execute("SELECT id FROM moneylens.goal_commands").fetchall()==[(UUID(first["id"]),)]


def test_legacy_goal_migration_preserves_unknown_times_and_prior_fields(migration_database):
    with migration_database("0012_bank_publication_receipts") as scratch:
        owner=tuple(uuid4() for _ in range(3));identifier=uuid4();config=scratch["config"]
        with psycopg.connect(scratch["admin"]) as connection:
            connection.execute("INSERT INTO moneylens.tenants(id,name) VALUES (%s,'Synthetic legacy migration')",(owner[0],))
            connection.execute("INSERT INTO moneylens.users(tenant_id,id,subject_issuer,subject_id) VALUES (%s,%s,'integration',%s)",(*owner[:2],str(owner[1])))
            connection.execute("INSERT INTO moneylens.accounts(tenant_id,owner_user_id,id,name,currency,account_type) VALUES (%s,%s,%s,'Legacy EUR','EUR','current')",owner)
            connection.execute("INSERT INTO moneylens.user_state(tenant_id,owner_user_id,id) VALUES (%s,%s,%s)",(*owner[:2],uuid4()))
            connection.execute("INSERT INTO moneylens.goals (tenant_id,owner_user_id,id,name,target_minor,currency,deadline,state) VALUES (%s,%s,%s,'Legacy',1234,'EUR','2026-12-01','paused')",(*owner[:2],identifier))
        with scratch["engine"].begin() as connection:
            config.attributes["connection"]=connection;command.upgrade(config,"head")
        config.attributes.pop("connection",None)
        with authenticated_app(scratch,[owner]) as (client,app,settings):
            headers(client);view=client.get(f"/v1/goals/{identifier}").json()
            assert (view["name"],view["target_minor"],view["state"],view["version"],view["priority"])==("Legacy",1234,"paused",1,3)
            assert view["created_at"] is None and view["updated_at"] is None
