"""Real source -> leased stage -> atomic ledger -> scoped review acceptance."""
from datetime import timedelta
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from app.bank_adapter import BankError
from app.bank_fetch import run_fetch_once
from app.bank_publication import BankPublication
from app.bank_publish_worker import run_publish_once
from app.bank_access import planning_sources_ready
from app.identity import AuthError, authorized_transaction
from identity_support import authenticated_app
from test_bank_routes import NOW, finish, headers, start
from test_bank_fetch import enqueue, checkpoint


@pytest.mark.parametrize("change,code",[("metadata","source_revision_conflict"),("status","source_status_regressed"),
    ("observation","source_observation_regressed"),("observation_reconnect","source_observation_regressed")])
def test_source_fingerprint_and_monotonic_state_protect_the_last_complete_money(database,owners,monkeypatch,change,code):
    from app.synthetic_banks import SyntheticBank
    original=SyntheticBank.dataset
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        before={table:sorted(rows(database,owners[0],table,columns)) for table,columns in
            (("transactions","id,amount_minor,status,source_revision,source_payload_hash"),("balance_snapshots","id"),("user_state","data_version"))}
        assert all(item[-1] and len(item[-1])==64 for item in before["transactions"])
        def changed(adapter,session):
            data=original(adapter,session)
            if not change.startswith("observation"):
                data[0]=data[0].model_copy(update={"merchant":"Changed same revision"} if change=="metadata" else {"status":"pending","revision":2})
            return data
        monkeypatch.setattr(SyntheticBank,"dataset",changed)
        if change=="observation_reconnect":
            assert client.post(f"/v1/bank-connections/{first['connection']['id']}/disconnect",headers=auth).status_code==200
            first=start(client,auth,"s-bank-demo","reconnect");assert finish(client,auth,first).status_code==200
        now=NOW+timedelta(seconds=31);app.state.bank_clock=lambda:now
        enqueue(client,auth,first,"changed-source")
        secret=config.session_secret.get_secret_value()
        assert run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:NOW-timedelta(seconds=1) if change.startswith("observation") else now)
        # Refresh admission intentionally invalidates quotes before publication.
        # Compare the atomic publication against that current version.
        before["user_state"]=sorted(rows(database,owners[0],"user_state","data_version"))
        assert run_publish_once(database["runtime"],user.scope,secret,clock=lambda:now)
        assert client.get(f"/v1/bank-connections/{first['connection']['id']}").json()["last_error_code"]==code
        for table,columns in (("transactions","id,amount_minor,status,source_revision,source_payload_hash"),("balance_snapshots","id"),("user_state","data_version")):
            assert sorted(rows(database,owners[0],table,columns))==before[table]


def connect(client,app,bank,key):
    app.state.bank_clock=app.state.planning_clock=lambda:NOW
    auth=headers(client)
    started=start(client,auth,bank,key)
    response=finish(client,auth,started)
    assert response.status_code==200,response.text
    user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
    return auth,started,user


def synchronize(database,client,app,config,auth,started,user,*,key="refresh",now=NOW):
    app.state.bank_clock=app.state.planning_clock=lambda:now
    receipt=enqueue(client,auth,started,key)
    secret=config.session_secret.get_secret_value()
    assert run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:now)
    assert run_publish_once(database["runtime"],user.scope,secret,clock=lambda:now)
    view=client.get(f"/v1/bank-connections/{started['connection']['id']}").json()
    assert view["sync_health"]=="fresh",view
    return receipt


def rows(database,owner,table,columns="count(*)"):
    assert table in ("accounts","transactions","balance_snapshots","account_source_aliases","transfer_links","audit_events","outbox_events","user_state")
    with psycopg.connect(database["admin"]) as connection:
        return connection.execute("SELECT "+columns+" FROM moneylens."+table+" WHERE tenant_id=%s AND owner_user_id=%s",owner[:2]).fetchall()


def test_two_sources_publish_typed_money_once_and_reconcile_internal_transfer(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        second=start(client,auth,"north-demo","second"); finish(client,auth,second)
        synchronize(database,client,app,config,auth,second,user,key="north-refresh")
        response=client.get("/v1/analysis/spending?start=2026-10-01&end_exclusive=2026-11-01")
        assert response.status_code==200,response.text
        assert response.json()["net_minor"]==86450 and response.json()["unresolved_flow_count"]==0
        assert rows(database,owners[0],"account_source_aliases")==[(2,)]
        assert rows(database,owners[0],"transfer_links")==[(1,)]
        assert sorted(rows(database,owners[0],"balance_snapshots","amount_minor,balance_kind,pending_reflection"))==[
            (30000,"booked","excluded"),(50000,"available","included")]
        assert all(row[0]==NOW for row in rows(database,owners[0],"balance_snapshots","observed_at"))
        with app.state.pools.finance.connection() as connection:
            with authorized_transaction(connection,user): planning_sources_ready(connection,user,NOW)
        assert checkpoint(database,first["connection"]["id"]) is None


def test_replay_and_reconnection_share_canonical_accounts_and_transaction_ids(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        receipt=synchronize(database,client,app,config,auth,first,user)
        before={table:rows(database,owners[0],table) for table in ("accounts","transactions","balance_snapshots","audit_events","outbox_events")}
        with app.state.pools.finance.connection() as connection:
            service=BankPublication(connection,user,config.session_secret.get_secret_value(),clock=lambda:NOW)
            assert not service.publish(UUID(first["connection"]["id"]),fetch_job_id=UUID(receipt["job"]["id"]),generation=2)
        assert before=={table:rows(database,owners[0],table) for table in before}
        assert enqueue(client,auth,first,"refresh")["financial_publication_complete"]
        original_ids=sorted(rows(database,owners[0],"transactions","id,source_id"))
        url=f"/v1/bank-connections/{first['connection']['id']}"
        assert client.post(url+"/disconnect",headers=auth).status_code==200
        query="/v1/analysis/spending?start=2026-10-01&end_exclusive=2026-11-01"
        assert client.get(query).status_code==409
        replacement=start(client,auth,"s-bank-demo","reconnect"); finish(client,auth,replacement)
        synchronize(database,client,app,config,auth,replacement,user,key="reconnect-refresh",now=NOW+timedelta(seconds=31))
        assert sorted(rows(database,owners[0],"transactions","id,source_id"))==original_ids
        assert rows(database,owners[0],"accounts")==before["accounts"]
        assert rows(database,owners[0],"account_source_aliases")==[(2,)]
        assert client.get(query).status_code==200
        with app.state.pools.finance.connection() as connection:
            with authorized_transaction(connection,user): planning_sources_ready(connection,user,NOW+timedelta(seconds=31))


def test_pending_to_changed_booked_updates_one_identity_and_never_double_counts(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        url=f"/v1/bank-connections/{first['connection']['id']}"
        client.post(url+"/scenario",headers=auth,json={"fault":"pending"})
        synchronize(database,client,app,config,auth,first,user,key="pending")
        with psycopg.connect(database["admin"]) as connection:
            pending=connection.execute("SELECT id,amount_minor,status,source_revision FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s AND source_id='sim-pending-transition'",owners[0][:2]).fetchone()
        assert pending[1:]==(-4200,"pending",1)
        client.post(url+"/scenario",headers=auth,json={"fault":"booked"})
        synchronize(database,client,app,config,auth,first,user,key="booked",now=NOW+timedelta(seconds=31))
        with psycopg.connect(database["admin"]) as connection:
            booked=connection.execute("SELECT id,amount_minor,status,source_revision FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s AND source_id='sim-pending-transition'",owners[0][:2]).fetchall()
            latest=connection.execute("SELECT amount_minor FROM moneylens.balance_snapshots WHERE tenant_id=%s AND owner_user_id=%s ORDER BY observed_at DESC LIMIT 1",owners[0][:2]).fetchone()
        assert booked==[(pending[0],-4600,"booked",2)] and latest==(45400,)


@pytest.mark.parametrize("change",["disconnect","scenario","expiry","permission","synthetic"])
def test_stage_cannot_publish_after_authority_changes(database,owners,change):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        enqueue(client,auth,first)
        secret=config.session_secret.get_secret_value()
        assert run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:NOW)
        now=NOW
        url=f"/v1/bank-connections/{first['connection']['id']}"
        if change=="disconnect": client.post(url+"/disconnect",headers=auth)
        if change=="scenario": client.post(url+"/scenario",headers=auth,json={"fault":"booked"})
        if change=="expiry": now=NOW+timedelta(hours=2)
        if change in ("permission","synthetic"):
            assignment="permission_version=permission_version+1" if change=="permission" else "is_synthetic=false"
            with psycopg.connect(database["admin"]) as connection:
                connection.execute("UPDATE moneylens.users SET "+assignment+" WHERE tenant_id=%s AND id=%s",owners[0][:2])
        run_publish_once(database["runtime"],user.scope,secret,clock=lambda:now)
        assert rows(database,owners[0],"transactions")==[(0,)]
        assert rows(database,owners[0],"balance_snapshots")==[(0,)]
        assert rows(database,owners[0],"account_source_aliases")==[(0,)]


@pytest.mark.parametrize("damage",["currency","account","coverage","duplicate","money-bytes"])
def test_invalid_stage_rolls_back_account_alias_money_versions_and_audit(database,owners,damage):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        receipt=enqueue(client,auth,first)
        secret=config.session_secret.get_secret_value()
        assert run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:NOW)
        staged=checkpoint(database,first["connection"]["id"])
        if damage=="currency": staged["balances"][0]["currency"]="USD"
        if damage=="account": staged["account"]["reference"]=str(owners[1][2])
        if damage=="coverage": staged["coverage_from"]="2026-08-02"
        if damage=="duplicate": staged["rows"].append(staged["rows"][0])
        if damage=="money-bytes":
            staged["balances"][0]["amount_minor"]+=1
        else:
            # Test semantic validation independently of accidental byte damage.
            from app.bank_staging import seal_stage
            staged["seal"]=seal_stage(secret,user.scope,UUID(first["connection"]["id"]),staged)
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.connections SET sync_checkpoint=%s WHERE id=%s",(Jsonb(staged),first["connection"]["id"]))
        before={table:rows(database,owners[0],table) for table in ("accounts","transactions","balance_snapshots","account_source_aliases","audit_events","outbox_events")}
        with app.state.pools.finance.connection() as connection:
            service=BankPublication(connection,user,secret,clock=lambda:NOW)
            with pytest.raises(BankError):
                service.publish(UUID(first["connection"]["id"]),fetch_job_id=UUID(receipt["job"]["id"]),generation=2)
        assert before=={table:rows(database,owners[0],table) for table in before}


@pytest.mark.parametrize("access_change",["disconnect","eligibility"])
def test_owned_plan_review_and_reservation_survive_disconnection_without_source_access(database,owners,access_change):
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.accounts SET included=false WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        context=client.get("/v1/planning/context").json()
        end=(NOW+timedelta(days=31)).isoformat()
        body={"key":"review-after-source","expected_data_version":context["data_version"],"expected_plan_version":context["plan_version"],
            "accounts":[{"account_id":item["id"],"balance_snapshot_id":item["balance"]["id"],"inaccessible_minor":0,
                "coverage_confirmed":True,"liability_covered":None} for item in context["accounts"]],
            "protections":[{"id":str(uuid4()),"kind":kind,"amount_minor":0,"reviewed_through":end,"routes":[]}
                for kind in ("essentials","irregular","savings","buffer")],"obligations_reviewed_through":end}
        result=client.post("/v1/plans",headers=auth,json=body)
        assert result.status_code==200,result.text
        plan=result.json()["plan"]
        assert plan and plan["current"] and plan["analysis"]["result"]["amount_minor"]==50000
        root=f"/v1/plans/{plan['id']}"
        accepted=client.post(root+"/allocations",headers=auth,json={"key":"save","expected_data_version":plan["data_version"],
            "expected_plan_version":plan["plan_version"],"account_id":context["accounts"][0]["id"],"amount_minor":5000,"desired_discretionary_minor":10000})
        assert accepted.status_code==200,accepted.text
        if access_change=="disconnect":
            client.post(f"/v1/bank-connections/{first['connection']['id']}/disconnect",headers=auth)
        else:
            with psycopg.connect(database["admin"]) as connection:
                connection.execute("UPDATE moneylens.users SET is_synthetic=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
        assert client.get(root+"/review").status_code==409
        assert client.get("/v1/planning/context").status_code==409
        assert client.get("/v1/ledger/transactions?start=2026-10-01&end_exclusive=2026-11-01").status_code==409
        assert client.get(root).json()["analysis"]["result"]["amount_minor"] is None
        history=client.get(root+"/allocations").json()
        assert history["rows"][0]["id"]==accepted.json()["id"]
        released=client.post(root+f"/allocations/{accepted.json()['id']}/release",headers=auth,json={"key":"release-after-disconnect",
            "expected_data_version":history["data_version"],"expected_plan_version":history["plan_version"]})
        assert released.status_code==200,released.text
        assert released.json()["state"]=="released"


def test_a_late_publication_failure_rolls_back_every_financial_effect(database,owners,monkeypatch):
    from app.bank_store import BankStore
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        receipt=enqueue(client,auth,first)
        secret=config.session_secret.get_secret_value()
        assert run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:NOW)
        before={table:rows(database,owners[0],table) for table in ("accounts","transactions","balance_snapshots","account_source_aliases","audit_events","outbox_events","user_state")}
        before_versions=rows(database,owners[0],"user_state","data_version,plan_version")
        original=BankStore.record
        def fail_after_money(repository,action,resource,**options):
            if action=="bank.published": raise RuntimeError("injected late failure")
            return original(repository,action,resource,**options)
        monkeypatch.setattr(BankStore,"record",fail_after_money)
        with app.state.pools.finance.connection() as connection:
            service=BankPublication(connection,user,secret,clock=lambda:NOW)
            with pytest.raises(RuntimeError,match="injected late failure"):
                service.publish(UUID(first["connection"]["id"]),fetch_job_id=UUID(receipt["job"]["id"]),generation=2)
        assert before=={table:rows(database,owners[0],table) for table in before}
        assert rows(database,owners[0],"user_state","data_version,plan_version")==before_versions
        assert client.get(f"/v1/bank-connections/{first['connection']['id']}").json()["sync_health"]=="staged"


def test_seeded_accounts_and_source_rows_are_adopted_by_exact_authored_identity(database,owners):
    import json
    from pathlib import Path
    from app.seed import seed_synthetic
    artifact=json.loads((Path(__file__).resolve().parents[2]/"fixtures/synthetic/demo.v1.json").read_text(encoding="utf-8"))
    profiles=artifact["profiles"]
    seeded=[(UUID(profile["accounts"][0]["owner"]["tenant_id"]),UUID(profile["accounts"][0]["owner"]["user_id"]),UUID(profile["accounts"][0]["id"])) for profile in profiles]
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT id FROM moneylens.tenants WHERE id=%s",(seeded[0][0],)).fetchone() is None
        seed_synthetic(connection)
    try:
        with authenticated_app(database,seeded) as (client,app,config):
            auth,first,user=connect(client,app,"s-bank-demo","seed-first")
            synchronize(database,client,app,config,auth,first,user)
            second=start(client,auth,"north-demo","seed-second"); finish(client,auth,second)
            synchronize(database,client,app,config,auth,second,user,key="seed-second-refresh")
            assert rows(database,seeded[0],"accounts")==[(2,)]
            assert rows(database,seeded[0],"transactions")==[(len(profiles[0]["transactions"]),)]
            assert {item[0] for item in rows(database,seeded[0],"transactions","id")}=={UUID(tx["id"]) for tx in profiles[0]["transactions"]}
            assert rows(database,seeded[0],"transfer_links")==[(1,)]
            before=rows(database,seeded[0],"user_state","data_version")
            with psycopg.connect(database["admin"]) as connection: seed_synthetic(connection)
            assert rows(database,seeded[0],"user_state","data_version")==before
            assert client.get("/v1/analysis/spending?start=2026-10-01&end_exclusive=2026-11-01").json()["net_minor"]==86450
    finally:
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("DELETE FROM moneylens.tenants WHERE id=%s",(seeded[0][0],))


def test_unavailable_account_scope_cannot_hide_inside_an_explicit_selection(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        second=start(client,auth,"north-demo","second"); finish(client,auth,second)
        synchronize(database,client,app,config,auth,second,user,key="second-refresh")
        with psycopg.connect(database["admin"]) as connection:
            accounts=dict(connection.execute("SELECT connection_id,account_id FROM moneylens.account_source_aliases WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchall())
        client.post(f"/v1/bank-connections/{first['connection']['id']}/disconnect",headers=auth)
        query="/v1/analysis/spending?start=2026-10-01&end_exclusive=2026-11-01"
        assert client.get(query).status_code==409
        assert client.get(query+"&account_id="+str(accounts[UUID(first["connection"]["id"])] )).status_code==409
        working=client.get(query+"&account_id="+str(accounts[UUID(second["connection"]["id"])]))
        assert working.status_code==200,working.text
        assert working.json()["scope"]["account_ids"]==[str(accounts[UUID(second["connection"]["id"])])]


def test_transient_publication_failure_recovers_without_refetching_or_duplicate_money(database,owners,monkeypatch):
    from app.bank_store import BankStore
    from test_jobs import change_time
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        enqueue(client,auth,first)
        secret=config.session_secret.get_secret_value()
        assert run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:NOW)
        original=BankStore.record
        def transient(repository,action,resource,**options):
            if action=="bank.published": raise psycopg.OperationalError("injected temporary failure")
            return original(repository,action,resource,**options)
        monkeypatch.setattr(BankStore,"record",transient)
        assert run_publish_once(database["runtime"],user.scope,secret,clock=lambda:NOW)
        assert rows(database,owners[0],"transactions")==[(0,)]
        assert rows(database,owners[0],"balance_snapshots")==[(0,)]
        with psycopg.connect(database["admin"]) as connection:
            job=connection.execute("SELECT id,state,attempts FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s AND type='bank.publish'",owners[0][:2]).fetchone()
        assert job[1:]==("queued",1)
        assert checkpoint(database,first["connection"]["id"])["phase"]=="ready"
        change_time(database,job[0],"available_at")
        monkeypatch.setattr(BankStore,"record",original)
        assert run_publish_once(database["runtime"],user.scope,secret,clock=lambda:NOW)
        assert rows(database,owners[0],"balance_snapshots")==[(1,)]
        assert client.get(f"/v1/bank-connections/{first['connection']['id']}").json()["sync_health"]=="fresh"


@pytest.mark.parametrize("next_fault,code",[("pending","source_revision_regressed"),("healthy","source_history_changed")])
def test_revised_or_disappearing_source_history_never_silently_rewinds_money(database,owners,next_fault,code):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        url=f"/v1/bank-connections/{first['connection']['id']}"
        client.post(url+"/scenario",headers=auth,json={"fault":"booked"})
        synchronize(database,client,app,config,auth,first,user,key="booked")
        before=sorted(rows(database,owners[0],"transactions","id,amount_minor,status,source_revision"))
        client.post(url+"/scenario",headers=auth,json={"fault":next_fault})
        now=NOW+timedelta(seconds=31)
        app.state.bank_clock=lambda:now
        enqueue(client,auth,first,"rewind")
        secret=config.session_secret.get_secret_value()
        run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:now)
        run_publish_once(database["runtime"],user.scope,secret,clock=lambda:now)
        assert client.get(url).json()["last_error_code"]==code
        assert sorted(rows(database,owners[0],"transactions","id,amount_minor,status,source_revision"))==before
        assert rows(database,owners[0],"balance_snapshots")==[(1,)]


def test_foreign_connection_and_stage_ids_cannot_be_published_under_another_owner(database,owners):
    from test_bank_routes import headers as login_headers
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        receipt=enqueue(client,auth,first)
        secret=config.session_secret.get_secret_value()
        run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:NOW)
        login_headers(client,"mika")
        other=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        with app.state.pools.finance.connection() as connection:
            service=BankPublication(connection,other,secret,clock=lambda:NOW)
            with pytest.raises(AuthError) as caught:
                service.publish(UUID(first["connection"]["id"]),fetch_job_id=UUID(receipt["job"]["id"]),generation=2)
            assert caught.value.status==404
        assert rows(database,owners[0],"transactions")==rows(database,owners[1],"transactions")==[(0,)]


def test_transfer_with_conflicting_amounts_remains_unresolved_without_a_false_match(database,owners):
    from app.bank_staging import seal_stage
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        second=start(client,auth,"north-demo","second"); finish(client,auth,second)
        enqueue(client,auth,second,"second")
        secret=config.session_secret.get_secret_value()
        run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:NOW)
        staged=checkpoint(database,second["connection"]["id"])
        transfer=next(item for item in staged["rows"] if item["economic_flow"]=="internal_transfer")
        transfer["amount_minor"]+=1
        staged["seal"]=seal_stage(secret,user.scope,UUID(second["connection"]["id"]),staged)
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.connections SET sync_checkpoint=%s WHERE id=%s",(Jsonb(staged),second["connection"]["id"]))
        run_publish_once(database["runtime"],user.scope,secret,clock=lambda:NOW)
        assert rows(database,owners[0],"transfer_links")==[(0,)]
        response=client.get("/v1/analysis/spending?start=2026-10-01&end_exclusive=2026-11-01")
        assert response.status_code==200,response.text
        assert response.json()["unresolved_flow_count"]==2


def test_old_refresh_receipt_and_replay_remain_completed_after_a_newer_publication(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        original=synchronize(database,client,app,config,auth,first,user,key="original")
        next_time=NOW+timedelta(seconds=31)
        newer=synchronize(database,client,app,config,auth,first,user,key="newer",now=next_time)
        assert original["job"]["id"]!=newer["job"]["id"]
        assert enqueue(client,auth,first,"original")["financial_publication_complete"]
        assert enqueue(client,auth,first,"newer")["financial_publication_complete"]
        with app.state.pools.finance.connection() as connection:
            service=BankPublication(connection,user,config.session_secret.get_secret_value(),clock=lambda:next_time)
            assert not service.publish(UUID(first["connection"]["id"]),fetch_job_id=UUID(original["job"]["id"]),generation=2)
        assert rows(database,owners[0],"balance_snapshots")==[(2,)]
