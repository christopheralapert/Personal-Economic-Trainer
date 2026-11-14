"""Durable bounded source staging, lease recovery and immediate consent fences."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from uuid import UUID

import psycopg
import pytest

from app.bank_fetch import BankFetch, run_fetch_once
from app.bank_adapter import BankError
from app.database import tenant_transaction
from app.identity import AuthError, authorized_transaction
from app.jobs import JobStore, LostLease
from identity_support import authenticated_app
from test_bank_routes import NOW, finish, headers, start
from test_jobs import change_time


@pytest.mark.parametrize("conflict",[False,True])
def test_overlapping_provider_pages_are_exactly_idempotent_or_fail_closed(database,owners,monkeypatch,conflict):
    from app.synthetic_banks import SyntheticBank
    from app.bank_publish_worker import run_publish_once
    original=SyntheticBank.fetch_transactions
    def overlapping(adapter,session,account_reference,**options):
        page=original(adapter,session,account_reference,**{**options,"cursor":None,"limit":100})
        offset=int(options["cursor"].split(":")[1]) if options["cursor"] else 0
        records=page.rows[offset:offset+2]
        if conflict and offset: records=[records[0].model_copy(update={"amount_minor":records[0].amount_minor-1}),*records[1:]]
        return page.model_copy(update={"rows":records,"next_cursor":f"overlap:{offset+1}" if offset+2<len(page.rows) else None})
    monkeypatch.setattr(SyntheticBank,"fetch_transactions",overlapping)
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app);queued=enqueue(client,auth,started)
        secret=config.session_secret.get_secret_value()
        assert run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:NOW,page_size=2)
        if conflict:
            status=client.get(f"/v1/bank-connections/{started['connection']['id']}").json()
            assert status["last_error_code"]=="source_snapshot_conflict" and status["last_success_at"] is None
            assert checkpoint(database,started["connection"]["id"]) is None
        else:
            staged=checkpoint(database,started["connection"]["id"])
            assert len(staged["rows"])==len({item["reference"] for item in staged["rows"]})
            assert run_publish_once(database["runtime"],user.scope,secret,clock=lambda:NOW)
            with psycopg.connect(database["admin"]) as connection:
                count=connection.execute("SELECT count(*) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]
                assert count==len(staged["rows"])
        assert client.get("/v1/jobs/"+queued["job"]["id"]).json()["state"]==("dead_letter" if conflict else "completed")


def enqueue(client,auth,started,key="refresh-1"):
    response=client.post(f"/v1/bank-connections/{started['connection']['id']}/refresh",headers=auth,json={"key":key})
    assert response.status_code==200,response.text
    return response.json()


def setup(client,app,bank="s-bank-demo",suffix="1"):
    app.state.bank_clock=lambda:NOW
    auth=headers(client)
    started=start(client,auth,bank,"start-"+suffix)
    assert finish(client,auth,started).status_code==200
    user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
    return auth,started,user


def checkpoint(database,identifier):
    with psycopg.connect(database["admin"]) as connection:
        return connection.execute("SELECT sync_checkpoint FROM moneylens.connections WHERE id=%s",(identifier,)).fetchone()[0]


def claim(connection,user):
    with authorized_transaction(connection,user,write=True):
        return JobStore(connection,user.scope).claim(["bank.fetch"])


def run(database,user,config,**options):
    return run_fetch_once(database["runtime"],user.scope,config.session_secret.get_secret_value(),clock=lambda:NOW,**options)


def test_refresh_coalesces_distinct_keys_and_replays_original_job_after_completion(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        first=enqueue(client,auth,started)
        second=enqueue(client,auth,started,"another-tab")
        assert first["job"]["id"]==second["job"]["id"] and second["coalesced"]
        assert first["connection"]["sync_health"]=="syncing"
        assert not first["financial_publication_complete"]
        assert run(database,user,config,page_size=2)
        done=enqueue(client,auth,started,"another-tab")
        assert done["job"]["id"]==first["job"]["id"] and done["job"]["state"]=="completed"
        assert done["connection"]["sync_health"]=="staged" and done["connection"]["last_success_at"] is None
        assert done["connection"]["staged_at"]==NOW.isoformat().replace("+00:00","Z")
        staged=checkpoint(database,started["connection"]["id"])
        assert staged["phase"]=="ready" and staged["pages"]>1 and staged["cursor"] is None
        assert len(staged["rows"])==len({row["reference"] for row in staged["rows"]})
        assert staged["balances"][0]["amount_minor"]==50000
        assert staged["coverage_from"]=="2026-08-01" and staged["coverage_to_exclusive"]=="2026-11-05"
        assert "amount_minor" not in client.get("/v1/bank-connections").text
        with psycopg.connect(database["admin"]) as connection:
            assert connection.execute("SELECT count(*) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==0
            assert connection.execute("SELECT count(*) FROM moneylens.balance_snapshots WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==0
        assert not run(database,user,config)
        throttled=client.post(f"/v1/bank-connections/{started['connection']['id']}/refresh",headers=auth,json={"key":"too-soon"})
        assert throttled.status_code==429 and throttled.headers["retry-after"]=="30"


def test_page_checkpoint_survives_process_restart_and_fences_old_lease(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        queued=enqueue(client,auth,started)
        secret=config.session_secret.get_secret_value()
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            job=claim(connection,user)
            service=BankFetch(connection,user,secret,job,clock=lambda:NOW,page_size=2)
            assert not service.step()
            saved=checkpoint(database,started["connection"]["id"])
            assert saved["pages"]==1 and saved["cursor"]
            change_time(database,job.id,"lease_until")
            with psycopg.connect(database["runtime"],autocommit=True) as recovered:
                new=claim(recovered,user)
                assert new.id==job.id and new.lease_token!=job.lease_token
                with pytest.raises(LostLease): service.step()
                resumed=BankFetch(recovered,user,secret,new,clock=lambda:NOW,page_size=2)
                while not resumed.step(): pass
        final=checkpoint(database,started["connection"]["id"])
        assert final["rows"][:2]==saved["rows"]
        assert final["as_of"]==saved["as_of"] and final["phase"]=="ready"
        status=client.get("/v1/jobs/"+queued["job"]["id"]).json()
        assert status["state"]=="completed" and status["attempts"]==2


@pytest.mark.parametrize("fault,health,code,state",[
    ("unavailable","error","bank_unavailable","queued"),
    ("throttled","error","bank_throttled","queued"),
    ("partial","partial","source_incomplete","dead_letter"),
    ("stale","stale","source_stale","dead_letter"),
])
def test_source_failures_never_publish_or_fake_success(database,owners,fault,health,code,state):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        url=f"/v1/bank-connections/{started['connection']['id']}"
        assert client.post(url+"/scenario",headers=auth,json={"fault":fault}).status_code==200
        queued=enqueue(client,auth,started)
        assert run(database,user,config)
        result=client.get(url).json()
        assert result["sync_health"]==health
        assert result["last_error_code"]==code and result["last_success_at"] is None
        assert result["staged_at"] is None and checkpoint(database,started["connection"]["id"]) is None
        status=client.get("/v1/jobs/"+queued["job"]["id"]).json()
        assert status["state"]==state
        if fault=="throttled":
            with psycopg.connect(database["admin"]) as connection:
                assert connection.execute("SELECT available_at>clock_timestamp()+interval '25 seconds' FROM moneylens.jobs WHERE id=%s",(queued["job"]["id"],)).fetchone()[0]


@pytest.mark.parametrize("change",["disconnect","scenario","membership","expiry","synthetic"])
def test_each_page_rechecks_consent_generation_permission_and_lease(database,owners,change):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        queued=enqueue(client,auth,started)
        url=f"/v1/bank-connections/{started['connection']['id']}"
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            job=claim(connection,user)
            current=[NOW]
            service=BankFetch(connection,user,config.session_secret.get_secret_value(),job,clock=lambda:current[0],page_size=2)
            assert not service.step()
            if change=="disconnect": client.post(url+"/disconnect",headers=auth)
            if change=="scenario": client.post(url+"/scenario",headers=auth,json={"fault":"booked"})
            if change=="expiry": current[0]=NOW+timedelta(hours=2)
            if change=="membership":
                with psycopg.connect(database["admin"]) as admin:
                    admin.execute("UPDATE moneylens.users SET permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
            if change=="synthetic":
                with psycopg.connect(database["admin"]) as admin:
                    admin.execute("UPDATE moneylens.users SET is_synthetic=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
            with pytest.raises((LostLease,AuthError,BankError)):
                service.step()
        staged=checkpoint(database,started["connection"]["id"])
        assert staged is None if change in ("disconnect","scenario") else staged["pages"]==1


def test_a_failing_bank_does_not_prevent_the_other_bank_from_staging(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=setup(client,app)
        second=start(client,auth,"north-demo","second"); finish(client,auth,second)
        client.post(f"/v1/bank-connections/{first['connection']['id']}/scenario",headers=auth,json={"fault":"unavailable"})
        one=enqueue(client,auth,first)
        two=enqueue(client,auth,second)
        assert run(database,user,config) and run(database,user,config)
        assert client.get("/v1/jobs/"+one["job"]["id"]).json()["state"]=="queued"
        assert client.get("/v1/jobs/"+two["job"]["id"]).json()["state"]=="completed"
        assert checkpoint(database,second["connection"]["id"])["balances"][0]["amount_minor"]==30000


def test_duplicate_refresh_race_produces_one_job_and_two_sticky_receipts(database,owners):
    from app.bank_store import BankStore
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        barrier=Barrier(2)
        def submit(key):
            with psycopg.connect(database["runtime"],autocommit=True) as connection:
                repository=BankStore(connection,user,config.session_secret.get_secret_value(),clock=lambda:NOW)
                barrier.wait(timeout=5)
                return repository.refresh(UUID(started["connection"]["id"]),key=key)
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures=[executor.submit(submit,key) for key in ("tab-1","tab-2")]
            results=[future.result(timeout=10) for future in futures]
        assert results[0]["job"]["id"]==results[1]["job"]["id"]
        assert sorted(result["coalesced"] for result in results)==[False,True]
        with psycopg.connect(database["admin"]) as connection:
            assert connection.execute("SELECT count(*) FROM moneylens.bank_refresh_requests WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==2


def test_request_budget_survives_new_keys_and_other_owners_cannot_see_receipts(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        queued=enqueue(client,auth,started)
        # Explicitly create the remaining owned receipt fixtures through the
        # normal service; coalescing does not bypass the request budget.
        for index in range(59): enqueue(client,auth,started,"tab-"+str(index))
        response=client.post(f"/v1/bank-connections/{started['connection']['id']}/refresh",headers=auth,json={"key":"over-budget"})
        assert response.status_code==429
        assert enqueue(client,auth,started)["job"]["id"]==queued["job"]["id"]
        headers(client,"mika")
        assert client.get("/v1/jobs/"+queued["job"]["id"]).status_code==404
        assert client.post(f"/v1/bank-connections/{started['connection']['id']}/refresh",headers=headers(client,"mika"),json={"key":"refresh-1"}).status_code==404
        from app.database import TrustedScope
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            with tenant_transaction(connection,TrustedScope(*owners[1][:2])):
                assert connection.execute("SELECT count(*) FROM moneylens.bank_refresh_requests").fetchone()[0]==0


def test_retries_exhaust_without_losing_the_last_published_success(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        url=f"/v1/bank-connections/{started['connection']['id']}"
        client.post(url+"/scenario",headers=auth,json={"fault":"unavailable"})
        previous=NOW-timedelta(hours=1)
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.connections SET last_success_at=%s WHERE id=%s",(previous,started["connection"]["id"]))
        queued=enqueue(client,auth,started)
        for attempt in range(5):
            if attempt: change_time(database,UUID(queued["job"]["id"]),"available_at")
            assert run(database,user,config)
        status=client.get("/v1/jobs/"+queued["job"]["id"]).json()
        assert status["state"]=="dead_letter" and status["attempts"]==5
        assert client.get(url).json()["last_success_at"]==previous.isoformat().replace("+00:00","Z")
        assert not run(database,user,config)


def test_worker_failure_cleanup_cannot_cancel_a_newer_claim(database,owners,monkeypatch):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        queued=enqueue(client,auth,started)
        original_step=BankFetch.step
        recovered=[]
        def supersede(service):
            change_time(database,service.job.id,"lease_until")
            with psycopg.connect(database["runtime"],autocommit=True) as connection:
                recovered.append(claim(connection,user))
            raise LostLease("old worker")
        monkeypatch.setattr(BankFetch,"step",supersede)
        assert run(database,user,config)
        monkeypatch.setattr(BankFetch,"step",original_step)
        assert client.get("/v1/jobs/"+queued["job"]["id"]).json()["state"]=="running"
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            service=BankFetch(connection,user,config.session_secret.get_secret_value(),recovered[0],clock=lambda:NOW)
            assert service.step()
        assert client.get("/v1/jobs/"+queued["job"]["id"]).json()["state"]=="completed"


def test_new_source_jobs_have_an_independent_durable_hourly_budget(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        current=[NOW]
        app.state.bank_clock=lambda:current[0]
        for index in range(20):
            enqueue(client,auth,started,"job-"+str(index))
            assert run_fetch_once(database["runtime"],user.scope,config.session_secret.get_secret_value(),clock=lambda:current[0])
            current[0]+=timedelta(seconds=31)
        response=client.post(f"/v1/bank-connections/{started['connection']['id']}/refresh",headers=auth,json={"key":"twenty-first-job"})
        assert response.status_code==429
        assert enqueue(client,auth,started,"job-19")["job"]["state"]=="completed"


def test_expired_continuation_restarts_as_a_new_synthetic_observation(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        enqueue(client,auth,started)
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            job=claim(connection,user)
            current=[NOW]
            service=BankFetch(connection,user,config.session_secret.get_secret_value(),job,clock=lambda:current[0],page_size=2)
            assert not service.step()
            old=checkpoint(database,started["connection"]["id"])
            current[0]+=timedelta(minutes=6)
            assert not service.step()
            new=checkpoint(database,started["connection"]["id"])
            assert new["pages"]==1 and new["as_of"]!=old["as_of"] and new["source_version"]!=old["source_version"]
            assert new["balances"][0]["observed_at"]==current[0].isoformat().replace("+00:00","Z")
            # Old source observations never get their timestamps rewritten.
            assert old["balances"][0]["observed_at"]==NOW.isoformat().replace("+00:00","Z")


def test_synthetic_eligibility_change_uses_the_same_transaction_fence(database,owners):
    from app.bank_store import BankStore
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        with psycopg.connect(database["runtime"],autocommit=True) as reader:
            with authorized_transaction(reader,user):
                with psycopg.connect(database["admin"],autocommit=True) as admin:
                    admin.execute("SET lock_timeout='100ms'")
                    with pytest.raises(psycopg.errors.LockNotAvailable):
                        admin.execute("UPDATE moneylens.users SET is_synthetic=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
            with psycopg.connect(database["admin"]) as admin:
                admin.execute("UPDATE moneylens.users SET is_synthetic=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
            repository=BankStore(reader,user,config.session_secret.get_secret_value(),clock=lambda:NOW)
            with pytest.raises(AuthError) as caught:
                repository.list()
            assert caught.value.code=="SYNTHETIC_BANKS_ONLY"


def test_current_permission_refresh_never_coalesces_into_an_old_permission_job(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,started,user=setup(client,app)
        first=enqueue(client,auth,started)
        with psycopg.connect(database["admin"]) as admin:
            admin.execute("UPDATE moneylens.users SET permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
        auth=headers(client)
        app.state.bank_clock=lambda:NOW+timedelta(seconds=31)
        second=enqueue(client,auth,started,"renewed-permission")
        assert first["job"]["id"]!=second["job"]["id"] and not second["coalesced"]
        assert client.get("/v1/jobs/"+first["job"]["id"]).json()["state"]=="cancelled"
