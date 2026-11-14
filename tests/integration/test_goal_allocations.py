"""Goal links reuse actual accepted reservations, with real RLS and fencing."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from uuid import UUID,uuid4

import psycopg
import pytest

from app.goal_store import GoalStore
from app.goals import GoalVersionedCommandV1
from app.identity import AuthError
from app.jobs import JobStore
from identity_support import authenticated_app
from test_bank_routes import headers
from test_goal_routes import NOW,create,facts
from test_planning_routes import seed_plan
from test_planning_store import NOW as PLAN_NOW,accept,store


@contextmanager
def prepared(database,owners):
    plan=seed_plan(database,owners[0])
    with store(database,owners[0]) as repository: allocation=accept(repository,plan,owners[0])
    with authenticated_app(database,owners) as (client,app,config):
        app.state.goal_clock=lambda:NOW;app.state.planning_clock=lambda:PLAN_NOW
        auth=headers(client);goal=create(client,auth)["goal"]
        yield client,app,auth,goal,plan,allocation


def link_url(goal,allocation):
    return f"/v1/goals/{goal['id']}/allocations/{allocation['id']}"


def link_body(version=1,key="link-1"):
    return dict(key=key,expected_goal_version=version)


def money(database,owner):
    with psycopg.connect(database["admin"]) as connection:
        return connection.execute("""SELECT data_version,plan_version,
            (SELECT count(*) FROM moneylens.allocations WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT count(*) FROM moneylens.reserves WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT sum(amount_minor-consumed_minor-released_minor) FROM moneylens.reserves WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT reviewed_inputs FROM moneylens.plans WHERE tenant_id=%s AND owner_user_id=%s AND state='active')
            FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s""",owner[:2]*5).fetchone()


def test_existing_fifty_euros_link_unlink_and_replay_never_reserve_twice(database,owners):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        url=link_url(goal,allocation);before=money(database,owners[0]);initial=facts(database,owners[0])
        linked=client.post(url+"/link",headers=auth,json=link_body())
        assert linked.status_code==200,linked.text
        receipt=linked.json()
        assert receipt["allocation_id"]==str(allocation["id"]) and receipt["goal"]["version"]==2
        assert receipt["reservation_mutated"] is False and receipt["bank_transfer_executed"] is False
        assert client.post(url+"/link",headers=auth,json=link_body()).json()==receipt
        assert money(database,owners[0])==before
        view=client.get(f"/v1/goals/{goal['id']}").json()
        assert view["progress"]["recorded_reserved_minor"]==5000 and view["progress"]["reservation_gap_minor"]==5000
        assert view["progress"]["confirmed_saved_minor"] is None
        page=client.get(f"/v1/goals/{goal['id']}/allocations");assert page.status_code==200
        assert "no-store" in page.headers["cache-control"] and page.json()["next_cursor"] is None
        assert page.json()["rows"][0]["id"]==str(allocation["id"])
        assert page.json()["rows"][0]["acceptance_snapshot"]["remaining_spending_at_acceptance_minor"]==15000
        assert client.post(f"/v1/goals/{goal['id']}/remove",headers=auth,json=link_body(2,"remove")).status_code==409
        assert client.post(url+"/unlink",headers=auth,json=link_body(2,"unlink")).status_code==422
        unlinked=client.post(url+"/unlink",headers=auth,json={**link_body(2,"unlink"),"reservation_choice":"keep_reserved"})
        assert unlinked.status_code==200 and unlinked.json()["goal"]["version"]==3
        assert money(database,owners[0])==before
        assert client.get(f"/v1/goals/{goal['id']}/allocations").json()["rows"]==[]
        assert client.get(f"/v1/goals/{goal['id']}").json()["progress"]["recorded_reserved_minor"]==0
        assert client.get(f"/v1/plans/{plan['id']}").json()["analysis"]["result"]["amount_minor"]==15000
        assert client.post(url+"/link",headers=auth,json=link_body()).json()==receipt
        assert client.post(url+"/unlink",headers=auth,json={**link_body(2,"unlink"),"reservation_choice":"keep_reserved"}).json()==unlinked.json()
        assert client.post(url+"/link",headers=auth,json=link_body(3,"relink")).status_code==200
        assert facts(database,owners[0])[2:]==(initial[2]+3,1,initial[4]+3,initial[5]+3,initial[6]+3)


def test_release_updates_progress_retains_history_and_does_not_rewrite_link_receipt(database,owners):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        url=link_url(goal,allocation);receipt=client.post(url+"/link",headers=auth,json=link_body()).json()
        released=client.post(f"/v1/plans/{plan['id']}/allocations/{allocation['id']}/release",headers=auth,
            json=dict(key="release",expected_data_version=1,expected_plan_version=3))
        assert released.status_code==200,released.text
        progress=client.get(f"/v1/goals/{goal['id']}").json()["progress"]
        assert progress["recorded_reserved_minor"]==0 and progress["reservation_gap_minor"]==10000 and progress["confirmed_saved_minor"] is None
        page=client.get(f"/v1/goals/{goal['id']}/allocations").json()
        assert page["rows"][0]["state"]=="released" and page["plan_version"]==4
        assert client.post(url+"/unlink",headers=auth,json={**link_body(2,"unlink"),"reservation_choice":"keep_reserved"}).status_code==409
        assert client.post(f"/v1/goals/{goal['id']}/remove",headers=auth,json=link_body(2,"remove")).status_code==200
        assert client.post(url+"/link",headers=auth,json=link_body()).json()==receipt
        assert client.get(f"/v1/goals/{goal['id']}/allocations").json()["rows"][0]["state"]=="released"


@pytest.mark.parametrize("foreign_index",[1,2])
def test_foreign_goals_and_allocations_are_not_found(database,owners,foreign_index):
    foreign_plan=seed_plan(database,owners[foreign_index])
    with store(database,owners[foreign_index]) as repository: foreign=accept(repository,foreign_plan,owners[foreign_index])
    foreign_goal=uuid4()
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("INSERT INTO moneylens.goals (tenant_id,owner_user_id,id,name,target_minor,currency,deadline,state) VALUES (%s,%s,%s,'Private',1000,'EUR','2026-12-01','active')",(*owners[foreign_index][:2],foreign_goal))
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        before=money(database,owners[0])
        for target,item in ((goal,foreign),({"id":foreign_goal},allocation)):
            for action in ("link","unlink"):
                body={**link_body(),**({"reservation_choice":"keep_reserved"} if action=="unlink" else {})}
                assert client.post(link_url(target,item)+"/"+action,headers=auth,json=body).status_code==404
        assert client.get(f"/v1/goals/{foreign_goal}/allocations").status_code==404
        assert money(database,owners[0])==before


@pytest.mark.parametrize("case",["paused","removed","currency","consumed","released_amount","reserve_amount","reserve_currency","account_currency","kind","legacy"])
def test_invalid_goal_or_reservation_never_gets_linked(database,owners,case):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        with psycopg.connect(database["admin"]) as connection:
            if case in ("paused","removed"): connection.execute("UPDATE moneylens.goals SET state=%s WHERE id=%s",(case,goal["id"]))
            elif case=="currency": connection.execute("UPDATE moneylens.goals SET currency='USD' WHERE id=%s",(goal["id"],))
            elif case=="account_currency": connection.execute("UPDATE moneylens.accounts SET currency='USD' WHERE id=%s",(owners[0][2],))
            elif case=="legacy": connection.execute("UPDATE moneylens.allocations SET acceptance_snapshot=NULL WHERE id=%s",(allocation["id"],))
            else:
                assignment={"consumed":"consumed_minor=1","released_amount":"released_minor=1","reserve_amount":"amount_minor=4999","reserve_currency":"currency='USD'","kind":"kind='buffer'"}[case]
                connection.execute("UPDATE moneylens.reserves SET "+assignment+" WHERE id=%s",(allocation["reserve_id"],))
        before=money(database,owners[0]);before_facts=facts(database,owners[0])
        response=client.post(link_url(goal,allocation)+"/link",headers=auth,json=link_body())
        assert response.status_code==409,response.text
        assert money(database,owners[0])==before and facts(database,owners[0])==before_facts
        assert client.get(f"/v1/goals/{goal['id']}/allocations").json()["rows"]==[]


def test_paused_goal_allows_explicit_keep_reserved_unlink_and_currency_change_is_blocked(database,owners):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        url=link_url(goal,allocation);assert client.post(url+"/link",headers=auth,json=link_body()).status_code==200
        assert client.post(f"/v1/goals/{goal['id']}/state",headers=auth,json={**link_body(2,"pause"),"state":"paused"}).status_code==200
        revision={key:goal[key] for key in ("name","target_minor","currency","deadline","priority")}
        assert client.post(f"/v1/goals/{goal['id']}/revise",headers=auth,json={**revision,**link_body(3,"currency"),"currency":"USD"}).status_code==409
        assert client.post(url+"/unlink",headers=auth,json={**link_body(3,"unlink"),"reservation_choice":"release"}).status_code==422
        assert client.post(url+"/unlink",headers=auth,json={**link_body(3,"unlink"),"reservation_choice":"keep_reserved"}).status_code==200
        assert money(database,owners[0])[:5]==(1,3,1,1,5000)


def test_fenced_competing_goals_cannot_assign_one_reservation_twice(database,owners):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        other=create(client,auth,key="other")["goal"]
        user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        def attempt(target):
            try:
                with app.state.pools.finance.connection() as connection:
                    return GoalStore(connection,user,clock=lambda:NOW).assign(UUID(target["id"]),allocation["id"],GoalVersionedCommandV1(**link_body(key=target["id"])))
            except AuthError as error: return error
        with ThreadPoolExecutor(max_workers=2) as workers: results=list(workers.map(attempt,[goal,other]))
        assert sum(not isinstance(result,AuthError) for result in results)==1
        assert [result.code for result in results if isinstance(result,AuthError)]==["GOAL_ALLOCATION_ALREADY_LINKED"]
        assert money(database,owners[0])[:5]==(1,3,1,1,5000)


def test_link_is_atomic_with_audit_outbox_and_optimistic_idempotent_versions(database,owners,monkeypatch):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        url=link_url(goal,allocation);before=facts(database,owners[0]);financial=money(database,owners[0])
        def fail(*args,**kwargs): raise RuntimeError("owned link outbox failure")
        with monkeypatch.context() as patch:
            patch.setattr(JobStore,"emit",fail)
            response=client.post(url+"/link",headers=auth,json=link_body())
            assert response.status_code==500 and "owned link outbox failure" not in response.text
        assert facts(database,owners[0])==before and money(database,owners[0])==financial
        assert client.get(f"/v1/goals/{goal['id']}/allocations").json()["rows"]==[]
        first=client.post(url+"/link",headers=auth,json=link_body());assert first.status_code==200
        for body in (link_body(2),link_body(1,"stale"),link_body(2,"already")):
            assert client.post(url+"/link",headers=auth,json=body).status_code==409
        assert client.post(url+"/unlink",headers=auth,json={**link_body(2),"reservation_choice":"keep_reserved"}).status_code==409
        assert client.post(url+"/link",headers=auth,json=link_body()).json()==first.json()
        with psycopg.connect(database["admin"]) as connection:
            metadata=connection.execute("SELECT metadata FROM moneylens.audit_events WHERE action='goal.link_allocation' AND resource_id=%s",(goal["id"],)).fetchone()[0]
            assert set(metadata)=={"allocation_id","goal_version","collection_version"}


def test_allocation_paging_binds_goal_profile_namespace_and_financial_versions(database,owners):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        with store(database,owners[0]) as repository: second=accept(repository,plan,owners[0],key="save-2",version=3,amount=1000)
        for version,item in enumerate([allocation,second],start=1):
            assert client.post(link_url(goal,item)+"/link",headers=auth,json=link_body(version,f"link-{version}")).status_code==200
        endpoint=f"/v1/goals/{goal['id']}/allocations"
        page=client.get(endpoint,params={"limit":1}).json();cursor=page["next_cursor"];assert cursor
        next_page=client.get(endpoint,params={"limit":1,"cursor":cursor}).json()
        assert next_page["next_cursor"] is None
        assert {page["rows"][0]["id"],next_page["rows"][0]["id"]}=={str(allocation["id"]),str(second["id"])}
        assert client.get("/v1/goals",params={"cursor":cursor}).status_code==409
        other=create(client,auth,key="other")["goal"]
        assert client.get(f"/v1/goals/{other['id']}/allocations",params={"cursor":cursor}).status_code==409
        cursor=client.get(endpoint,params={"limit":1}).json()["next_cursor"]
        released=client.post(f"/v1/plans/{plan['id']}/allocations/{allocation['id']}/release",headers=auth,
            json=dict(key="release",expected_data_version=1,expected_plan_version=4));assert released.status_code==200
        assert client.get(endpoint,params={"cursor":cursor}).status_code==409
        headers(client,"mika");assert client.get(endpoint,params={"cursor":cursor}).status_code==404


def test_link_endpoints_enforce_session_csrf_body_and_closed_arguments(database,owners):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        url=link_url(goal,allocation)
        assert client.post(url+"/link",json=link_body()).status_code==403
        assert client.post(url+"/link",headers={**auth,"X-MoneyLens-Session-ID":str(uuid4())},json=link_body()).status_code==409
        assert client.post(url+"/link",headers=auth,content=b"x"*8193).status_code==413
        for extra in ({"amount_minor":5000},{"owner_user_id":str(owners[1][1])},{"expected_goal_version":True},{"reservation_choice":"release"}):
            assert client.post(url+"/link",headers=auth,json={**link_body(),**extra}).status_code==422
        assert client.get(f"/v1/goals/{goal['id']}/allocations?limit=101").status_code==422


def test_concurrent_exact_link_retries_have_one_receipt_and_one_effect(database,owners):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        user=app.state.identity.resolve(client.cookies.get("moneylens_session"));before=facts(database,owners[0])
        def attempt(_):
            with app.state.pools.finance.connection() as connection:
                return GoalStore(connection,user,clock=lambda:NOW).assign(UUID(goal["id"]),allocation["id"],GoalVersionedCommandV1(**link_body()))
        with ThreadPoolExecutor(max_workers=2) as workers: first,second=list(workers.map(attempt,range(2)))
        assert first==second
        after=facts(database,owners[0]);assert after[:2]==before[:2]
        assert after[2:]==(before[2]+1,1,before[4]+1,before[5]+1,before[6]+1)


def test_link_competing_with_release_never_revives_or_duplicates_reserve(database,owners):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        def link():
            try:
                with app.state.pools.finance.connection() as connection:
                    return GoalStore(connection,user,clock=lambda:NOW).assign(UUID(goal["id"]),allocation["id"],GoalVersionedCommandV1(**link_body()))
            except AuthError as error:
                assert error.code=="GOAL_ALLOCATION_NOT_ACTIVE"
                return None
        def release():
            with store(database,owners[0]) as repository:
                return repository.release(plan["id"],allocation["id"],key="release",expected_data_version=1,expected_plan_version=3)
        with ThreadPoolExecutor(max_workers=2) as workers:
            linked=workers.submit(link);released=workers.submit(release)
            assert released.result()["state"]=="released";linked.result()
        assert money(database,owners[0])[:5]==(1,4,1,1,0)
        assert client.get(f"/v1/goals/{goal['id']}").json()["progress"]["recorded_reserved_minor"]==0


def seed_assigned(database,owner,goal,plan,allocation,*,count,amount):
    """Deliberately create retained boundary fixtures, never a banking operation."""
    with psycopg.connect(database["admin"]) as connection:
        for index in range(count):
            reserve_id,allocation_id=uuid4(),uuid4()
            connection.execute("INSERT INTO moneylens.reserves (tenant_id,owner_user_id,id,account_id,kind,amount_minor,currency) VALUES (%s,%s,%s,%s,'savings',%s,'EUR')",(*owner[:2],reserve_id,owner[2],amount))
            connection.execute("""INSERT INTO moneylens.allocations (tenant_id,owner_user_id,id,plan_id,goal_id,reserve_id,amount_minor,currency,idempotency_key,accepted_plan_version,acceptance_snapshot)
                SELECT tenant_id,owner_user_id,%s,plan_id,%s,%s,%s,currency,%s,accepted_plan_version,acceptance_snapshot
                FROM moneylens.allocations WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                (allocation_id,goal["id"],reserve_id,amount,f"retained-{index}",*owner[:2],allocation["id"]))


@pytest.mark.parametrize("case",["retained_cap","sum_overflow","collection_version","goal_version"])
def test_link_limits_fail_atomically_without_hiding_reserved_money(database,owners,case):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        if case in ("retained_cap","sum_overflow"):
            seed_assigned(database,owners[0],goal,plan,allocation,count=200 if case=="retained_cap" else 1,amount=1 if case=="retained_cap" else 2**53-1)
        else:
            with psycopg.connect(database["admin"]) as connection:
                if case=="collection_version": connection.execute("UPDATE moneylens.user_state SET goal_version=%s WHERE tenant_id=%s AND owner_user_id=%s",(2**53-1,*owners[0][:2]))
                else: connection.execute("UPDATE moneylens.goals SET version=%s WHERE id=%s",(2**53-1,goal["id"]))
        before=facts(database,owners[0]);financial=money(database,owners[0])
        response=client.post(link_url(goal,allocation)+"/link",headers=auth,json=link_body(2**53-1 if case=="goal_version" else 1))
        assert response.status_code==409,response.text
        expected={"retained_cap":"GOAL_ALLOCATION_LIMIT_REACHED","sum_overflow":"GOAL_RESERVATION_RECONCILIATION_REQUIRED","collection_version":"GOAL_VERSION_EXHAUSTED","goal_version":"GOAL_VERSION_EXHAUSTED"}[case]
        assert response.json()["error"]["code"]==expected
        assert money(database,owners[0])==financial and facts(database,owners[0])==before


def test_legacy_assigned_receipt_missing_snapshot_is_explicitly_unavailable(database,owners):
    with prepared(database,owners) as (client,app,auth,goal,plan,allocation):
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.allocations SET goal_id=%s,acceptance_snapshot=NULL WHERE id=%s",(goal["id"],allocation["id"]))
        response=client.get(f"/v1/goals/{goal['id']}/allocations")
        assert response.status_code==409 and response.json()["error"]["code"]=="GOAL_RESERVATION_RECONCILIATION_REQUIRED"
