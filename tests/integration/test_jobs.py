from contextlib import contextmanager
import importlib.util
from pathlib import Path
import subprocess
import sys
import os

import psycopg
import pytest

from app.database import TrustedScope, tenant_transaction
from app.jobs import IdempotencyConflict, JobStore, LostLease


@contextmanager
def store(database, owner):
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        scope = TrustedScope(owner[0],owner[1])
        with tenant_transaction(connection, scope):
            yield JobStore(connection, scope)


def call(database, owner, method, *args, **kwargs):
    with store(database,owner) as jobs:
        return getattr(jobs, method)(*args, **kwargs)


def change_time(database, job_id, column):
    # Test-only controlled time movement; no wall-clock sleeps or runtime privilege bypass.
    assert column in ("available_at", "lease_until")
    with psycopg.connect(database["admin"], autocommit=True) as connection:
        connection.execute(f"UPDATE moneylens.jobs SET {column}=clock_timestamp()-interval '1 second' WHERE id=%s", (job_id,))


def test_enqueue_is_scoped_idempotent_and_rejects_changed_input(database,owners):
    first = call(database,owners[0],"enqueue","test.effect","same",{"amount":100})
    assert call(database,owners[0],"enqueue","test.effect","same",{"amount":100}) == first
    assert call(database,owners[1],"enqueue","test.effect","same",{"amount":100}) != first
    assert call(database,owners[1],"status",first) is None
    with pytest.raises(IdempotencyConflict):
        call(database,owners[0],"enqueue","test.effect","same",{"amount":200})


def test_idempotency_distinguishes_booleans_from_numbers(database,owners):
    for method in ("enqueue","emit"):
        call(database,owners[0],method,"test.effect","typed-json",{"enabled":True})
        with pytest.raises(IdempotencyConflict):
            call(database,owners[0],method,"test.effect","typed-json",{"enabled":1})


def test_enqueue_and_outbox_rollback_with_business_change(database,owners):
    with pytest.raises(ValueError):
        with store(database,owners[0]) as jobs:
            jobs.connection.execute("UPDATE moneylens.accounts SET name='Should roll back' WHERE id=%s",(owners[0][2],))
            jobs.enqueue("test.effect","rollback",{})
            jobs.emit("test.event","rollback",{})
            raise ValueError("synthetic rollback")
    with store(database,owners[0]) as jobs:
        assert jobs.connection.execute("SELECT name FROM moneylens.accounts").fetchone()[0] == "Synthetic account"
        assert jobs.connection.execute("SELECT count(*) FROM moneylens.jobs").fetchone()[0] == 0
        assert jobs.connection.execute("SELECT count(*) FROM moneylens.outbox_events").fetchone()[0] == 0


def test_two_worker_connections_skip_locked_work(database,owners):
    ids = {call(database,owners[0],"enqueue","test.effect",str(i),{}) for i in range(2)}
    with store(database,owners[0]) as first:
        a = first.claim(["test.effect"])
        with store(database,owners[0]) as second:
            b = second.claim(["test.effect"])
    assert {a.id,b.id} == ids
    assert a.lease_token != b.lease_token


def test_expired_attempt_is_recovered_and_fenced(database,owners):
    job_id = call(database,owners[0],"enqueue","test.effect","recovery",{})
    old = call(database,owners[0],"claim",["test.effect"])
    call(database,owners[0],"heartbeat",old,lease_seconds=60)
    change_time(database,job_id,"lease_until")
    new = call(database,owners[0],"claim",["test.effect"])
    assert new.id == old.id and new.attempts == 2 and new.lease_token != old.lease_token
    with pytest.raises(LostLease):
        call(database,owners[0],"heartbeat",old)
    with pytest.raises(LostLease):
        call(database,owners[0],"complete",old,lambda jobs,job: pytest.fail("Stale handler ran"))
    assert call(database,owners[0],"complete",new,lambda jobs,job: jobs.emit("test.done","once",{}))
    with pytest.raises(LostLease):
        call(database,owners[0],"complete",new,lambda jobs,job: pytest.fail("Completed handler replayed"))
    with store(database,owners[0]) as jobs:
        assert jobs.connection.execute("SELECT count(*) FROM moneylens.outbox_events").fetchone()[0] == 1


def test_handler_effects_use_a_savepoint_even_when_exception_is_caught(database,owners):
    job_id = call(database,owners[0],"enqueue","test.effect","atomic",{})
    job = call(database,owners[0],"claim",["test.effect"])
    def broken(jobs,claimed):
        jobs.emit("test.done","rolled-back",{})
        jobs.connection.execute("UPDATE moneylens.accounts SET name='Partial effect'")
        raise ValueError("synthetic handler failure")
    with store(database,owners[0]) as jobs:
        with pytest.raises(ValueError):
            jobs.complete(job,broken)
        assert jobs.connection.execute("SELECT count(*) FROM moneylens.outbox_events").fetchone()[0] == 0
        assert jobs.connection.execute("SELECT name FROM moneylens.accounts").fetchone()[0] == "Synthetic account"
        assert jobs.status(job_id)["state"] == "running"
        jobs.fail(job,"handler_failed")
    assert call(database,owners[0],"status",job_id)["state"] == "queued"


def test_backoff_limits_and_dead_letter_are_inspectable(database,owners):
    job_id = call(database,owners[0],"enqueue","test.effect","bounded",{},max_attempts=2)
    job = call(database,owners[0],"claim",["test.effect"])
    call(database,owners[0],"fail",job,"temporary_failure")
    status = call(database,owners[0],"status",job_id)
    assert status["state"] == "queued" and status["last_error_code"] == "temporary_failure"
    assert call(database,owners[0],"claim",["test.effect"]) is None
    change_time(database,job_id,"available_at")
    job = call(database,owners[0],"claim",["test.effect"])
    call(database,owners[0],"fail",job,"temporary_failure")
    status = call(database,owners[0],"status",job_id)
    assert status["state"] == "dead_letter" and status["attempts"] == 2 and status["finished_at"]
    assert not call(database,owners[0],"cancel",job_id)


def test_crashed_final_attempt_becomes_dead_letter(database,owners):
    job_id = call(database,owners[0],"enqueue","test.effect","crash",{},max_attempts=1)
    call(database,owners[0],"claim",["test.effect"])
    change_time(database,job_id,"lease_until")
    assert call(database,owners[0],"claim",["test.effect"]) is None
    assert call(database,owners[0],"status",job_id)["state"] == "dead_letter"


def test_cancel_invalidates_running_lease(database,owners):
    job_id = call(database,owners[0],"enqueue","test.effect","cancel",{})
    job = call(database,owners[0],"claim",["test.effect"])
    assert not call(database,owners[1],"cancel",job_id)
    assert call(database,owners[0],"cancel",job_id)
    with pytest.raises(LostLease):
        call(database,owners[0],"complete",job,lambda jobs,job: pytest.fail("Cancelled handler ran"))
    assert call(database,owners[0],"status",job_id)["state"] == "cancelled"


def test_revoked_permission_blocks_execution(database,owners):
    job_id = call(database,owners[0],"enqueue","test.effect","revocation",{})
    job = call(database,owners[0],"claim",["test.effect"])
    with psycopg.connect(database["admin"],autocommit=True) as connection:
        connection.execute("UPDATE moneylens.users SET permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
    assert call(database,owners[0],"complete",job,lambda jobs,job: pytest.fail("Revoked handler ran")) is False
    assert call(database,owners[0],"status",job_id)["state"] == "cancelled"


def test_outbox_fanout_is_durable_and_replay_safe(database,owners):
    event_id = call(database,owners[0],"emit","test.event","event-1",{"test":True})
    assert call(database,owners[0],"emit","test.event","event-1",{"test":True}) == event_id
    subscriptions = {"test.event":("test.consumer_a","test.consumer_b")}
    assert call(database,owners[0],"dispatch_one",subscriptions) == event_id
    assert call(database,owners[0],"dispatch_one",subscriptions) is None
    with store(database,owners[0]) as jobs:
        assert jobs.connection.execute("SELECT count(*) FROM moneylens.jobs").fetchone()[0] == 2
        assert jobs.connection.execute("SELECT published_at IS NOT NULL FROM moneylens.outbox_events").fetchone()[0]
        claimed = jobs.claim(["test.consumer_a"])
        assert claimed.payload["event_id"] == str(event_id) and claimed.payload["data"] == {"test":True}


def test_outbox_partial_dispatch_rolls_back(database,owners,monkeypatch):
    call(database,owners[0],"emit","test.event","event-1",{})
    with pytest.raises(ValueError):
        with store(database,owners[0]) as jobs:
            original = jobs.enqueue
            def fail_second(kind,*args,**kwargs):
                if kind == "test.consumer_b":
                    raise ValueError("simulated crash")
                return original(kind,*args,**kwargs)
            monkeypatch.setattr(jobs,"enqueue",fail_second)
            jobs.dispatch_one({"test.event":("test.consumer_a","test.consumer_b")})
    with store(database,owners[0]) as jobs:
        assert jobs.connection.execute("SELECT count(*) FROM moneylens.jobs").fetchone()[0] == 0
        assert jobs.connection.execute("SELECT published_at IS NULL FROM moneylens.outbox_events").fetchone()[0]


def test_permission_changed_outbox_is_discarded_before_enqueue(database,owners):
    event = call(database,owners[0],"emit","test.event","revoked-event",{})
    with psycopg.connect(database["admin"],autocommit=True) as connection:
        connection.execute("UPDATE moneylens.users SET permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
    assert call(database,owners[0],"dispatch_one",{"test.event":("test.consumer",)}) == event
    with store(database,owners[0]) as jobs:
        assert jobs.connection.execute("SELECT count(*) FROM moneylens.jobs").fetchone()[0] == 0
        assert jobs.connection.execute("SELECT discard_reason FROM moneylens.outbox_events").fetchone()[0] == "permission_changed"


def test_inactive_user_cannot_enqueue_or_publish(database,owners):
    with psycopg.connect(database["admin"],autocommit=True) as connection:
        connection.execute("UPDATE moneylens.users SET active=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
    for method in ("enqueue","emit"):
        with pytest.raises(PermissionError):
            call(database,owners[0],method,"test.effect","inactive",{})


def test_unknown_events_and_types_are_not_executed(database,owners):
    call(database,owners[0],"emit","test.unknown","event-1",{})
    call(database,owners[0],"enqueue","test.unregistered","job-1",{})
    assert call(database,owners[0],"dispatch_one",{"test.known":("test.consumer",)}) is None
    assert call(database,owners[0],"claim",["test.registered"]) is None


@pytest.mark.parametrize("payload", [{"large":"x"*65537}, {"bad":float("nan")}, []])
def test_invalid_job_payload_rejected(database,owners,payload):
    with pytest.raises(ValueError):
        call(database,owners[0],"enqueue","test.effect","invalid",payload)


def test_store_rejects_missing_or_mismatched_transaction_scope(database,owners):
    with psycopg.connect(database["runtime"],autocommit=True) as connection:
        with pytest.raises(RuntimeError):
            JobStore(connection,TrustedScope(owners[0][0],owners[0][1]))
    with store(database,owners[0]) as jobs:
        with pytest.raises(RuntimeError):
            JobStore(jobs.connection,TrustedScope(owners[1][0],owners[1][1]))


def test_worker_process_restart_does_not_duplicate_effects(database,owners):
    root = Path(__file__).resolve().parents[2]
    args = [sys.executable,str(root / "services/workers/run.py"),"--tenant",str(owners[0][0]),
            "--user",str(owners[0][1]),"--once","--enqueue-demo"]
    environment = {**os.environ,"MONEYLENS_DATABASE_URL":database["runtime"]}
    for _ in range(2):
        result = subprocess.run(args,env=environment,capture_output=True,text=True,timeout=15)
        assert result.returncode == 0, result.stderr
    with store(database,owners[0]) as jobs:
        assert jobs.connection.execute("SELECT state FROM moneylens.jobs").fetchall() == [("completed",)]
        assert jobs.connection.execute("SELECT count(*) FROM moneylens.outbox_events WHERE type='demo.completed'").fetchone()[0] == 1


def test_worker_records_permanent_validation_failure(database,owners):
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("moneylens_worker",root / "services/workers/run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    job_id = call(database,owners[0],"enqueue","demo.echo","bad-envelope",{"schema_version":2})
    module.run_once(database["runtime"],TrustedScope(owners[0][0],owners[0][1]))
    status = call(database,owners[0],"status",job_id)
    assert status["state"] == "dead_letter" and status["last_error_code"] == "unsupported_schema"
