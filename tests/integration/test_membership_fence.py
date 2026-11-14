from concurrent.futures import ThreadPoolExecutor
from queue import Queue
import time
from types import SimpleNamespace

import psycopg
import pytest

from app.database import TrustedScope
from app.identity import AuthError, authorized_transaction


def principal(owner):
    return SimpleNamespace(scope=TrustedScope(*owner[:2]),permission_version=1)


@pytest.mark.parametrize("change", ["active=false", "permission_version=permission_version+1"])
def test_revocation_cannot_commit_during_an_authorized_transaction(database,owners,change):
    owner = owners[0]
    with psycopg.connect(database["runtime"],autocommit=True) as reader:
        with authorized_transaction(reader,principal(owner)):
            with psycopg.connect(database["admin"],autocommit=True) as revoker:
                revoker.execute("SET lock_timeout='100ms'")
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    revoker.execute("UPDATE moneylens.users SET "+change+" WHERE tenant_id=%s AND id=%s",owner[:2])
            assert reader.execute("SELECT active,permission_version FROM moneylens.users").fetchone()==(True,1)
        with psycopg.connect(database["admin"]) as revoker:
            revoker.execute("UPDATE moneylens.users SET "+change+" WHERE tenant_id=%s AND id=%s",owner[:2])
        with pytest.raises(AuthError):
            with authorized_transaction(reader,principal(owner)):
                pytest.fail("A revoked principal entered a financial transaction")


@pytest.mark.parametrize("repeatable", [False, True])
def test_revocation_winning_the_lock_prevents_stale_snapshot_access(database,owners,repeatable):
    owner, started = owners[0], Queue()
    def read():
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            started.put(connection.execute("SELECT pg_backend_pid()").fetchone()[0])
            try:
                with authorized_transaction(connection,principal(owner),repeatable_read=repeatable):
                    return "incorrectly_authorized"
            except AuthError as exc:
                return exc.code
    with psycopg.connect(database["admin"],autocommit=True) as revoker:
        with ThreadPoolExecutor(max_workers=1) as pool:
            with revoker.transaction():
                revoker.execute("UPDATE moneylens.users SET active=false WHERE tenant_id=%s AND id=%s",owner[:2])
                future = pool.submit(read)
                pid = started.get(timeout=2)
                deadline = time.monotonic()+2
                with psycopg.connect(database["admin"],autocommit=True) as observer:
                    while time.monotonic()<deadline:
                        row = observer.execute("SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s",(pid,)).fetchone()
                        if row and row[0]=="Lock":
                            break
                        time.sleep(0.01)
                    else:
                        pytest.fail("The scoped reader did not wait behind revocation")
            assert future.result(timeout=2) in ("UNAUTHENTICATED", "DATA_CHANGED_RETRY")


def test_same_owner_mutations_serialize_without_shared_lock_upgrade_deadlock(database,owners):
    owner = owners[0]
    def mutate():
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            with authorized_transaction(connection,principal(owner),write=True):
                connection.execute("UPDATE moneylens.user_state SET plan_version=plan_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owner[:2])
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(mutate) for _ in range(2)]
        for future in futures:
            future.result(timeout=3)
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT plan_version FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",owner[:2]).fetchone()==(3,)


def test_membership_trigger_is_not_an_elevated_runtime_entry_point(database):
    with psycopg.connect(database["admin"]) as connection:
        row = connection.execute("""SELECT p.prosecdef,has_function_privilege('moneylens_runtime',p.oid,'EXECUTE'),p.proconfig
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='moneylens' AND p.proname='fence_membership_change'""").fetchone()
        assert row[0] is False and row[1] is False
        assert row[2]==["search_path=pg_catalog, pg_temp"]
