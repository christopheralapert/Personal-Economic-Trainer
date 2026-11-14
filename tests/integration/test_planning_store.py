from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest

from app.database import TrustedScope
from app.identity import AuthError
from app.planning_inputs import PlanningInputsV1
from app.planning_policy import PlanningPolicyV1
from app.planning_store import PlanningStore

NOW = datetime(2026,11,4,10,tzinfo=timezone.utc)
POLICY = PlanningPolicyV1()


def reviewed(database,owner):
    snapshot = uuid4()
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("""INSERT INTO moneylens.balance_snapshots
            (tenant_id,owner_user_id,id,account_id,amount_minor,currency,balance_kind,pending_reflection,observed_at)
            VALUES (%s,%s,%s,%s,80000,'EUR','available','excluded',%s)""",(*owner[:2],snapshot,owner[2],NOW))
    end = NOW+timedelta(days=30)
    return PlanningInputsV1(data_version=1,plan_version=1,as_of=NOW,source="synthetic_user_confirmed",
        obligations_reviewed_through=end,
        accounts=[dict(id=owner[2],currency="EUR",account_type="current",liquid=True,material=True,
            synced_at=NOW,coverage="user_confirmed",coverage_through=NOW,liability_covered=None)],
        balances=[dict(id=snapshot,account_id=owner[2],amount_minor=80000,currency="EUR",kind="available",observed_at=NOW,
            pending_reflection="excluded",included_credit_minor=0,inaccessible_minor=0)],
        protections=[dict(id=uuid4(),kind=kind,amount_minor=amount,reviewed_through=end,
            routes=[dict(account_id=owner[2],amount_minor=amount)] if amount else [])
            for kind,amount in (("essentials",15000),("irregular",0),("savings",0),("buffer",10000))],
        costs=[dict(id=uuid4(),economic_cost_id=uuid4(),account_id=owner[2],amount_minor=35000,
            at=NOW+timedelta(days=16),opening_reflected=False,kind="bill")])


@contextmanager
def store(database,owner,*,now=NOW):
    user = SimpleNamespace(scope=TrustedScope(*owner[:2]),permission_version=1)
    with psycopg.connect(database["runtime"],autocommit=True) as connection:
        yield PlanningStore(connection,user,clock=lambda:now)


def accept(repository,plan,owner,*,key="save-1",version=2,amount=5000):
    return repository.accept(plan["id"],key=key,expected_data_version=1,expected_plan_version=version,
        account_id=owner[2],amount_minor=amount,desired_discretionary_minor=10000)


def test_acceptance_is_reserved_once_and_replay_returns_the_same_receipt(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="plan-1")
        assert plan["plan_version"]==2 and plan["calculation"].amount_minor==20000
        receipt = accept(repository,plan,owners[0])
        replay = accept(repository,plan,owners[0])
        assert receipt==replay and receipt["amount_minor"]==5000
        assert receipt["acceptance_snapshot"]["remaining_spending_at_acceptance_minor"]==15000
        assert receipt["accepted_plan_version"]==3 and receipt["bank_transfer_executed"] is False
        fresh = repository.read(plan["id"])
        assert fresh["plan_version"]==3 and fresh["calculation"].amount_minor==15000
    with psycopg.connect(database["admin"]) as connection:
        for table,expected in (("reserves",1),("allocations",1),("audit_events",2),("outbox_events",2)):
            assert connection.execute("SELECT count(*) FROM moneylens."+table+" WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==expected


def test_creation_key_replay_is_stable_and_conflicting_input_fails(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        assert repository.create(inputs,POLICY,key="create-1")["id"]==plan["id"]
        changed = inputs.model_copy(deep=True)
        changed.costs[0].amount_minor += 1
        with pytest.raises(AuthError) as error:
            repository.create(changed,POLICY,key="create-1")
        assert error.value.code=="IDEMPOTENCY_CONFLICT"


def test_changed_acceptance_payload_cannot_reuse_a_committed_key(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        accept(repository,plan,owners[0])
        with pytest.raises(AuthError) as error:
            accept(repository,plan,owners[0],amount=6000)
        assert error.value.code=="IDEMPOTENCY_CONFLICT"
        assert repository.read(plan["id"])["calculation"].amount_minor==15000


def test_competing_allocations_serialize_and_only_one_version_wins(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
    def attempt(key):
        with store(database,owners[0]) as repository:
            try:
                return accept(repository,plan,owners[0],key=key)
            except AuthError as exc:
                return exc.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt,("choice-1","choice-2")))
    assert sum(isinstance(result,dict) for result in results)==1
    assert "PLANNING_VERSION_CHANGED" in results
    with store(database,owners[0]) as repository:
        assert repository.read(plan["id"])["calculation"].amount_minor==15000


@pytest.mark.parametrize("change", ["version","balance","latest","account"])
def test_acceptance_revalidates_data_and_exact_owned_facts(database,owners,change):
    owner = owners[0]
    inputs = reviewed(database,owner)
    with store(database,owner) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        with psycopg.connect(database["admin"]) as connection:
            if change=="version":
                connection.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owner[:2])
            elif change=="balance":
                connection.execute("UPDATE moneylens.balance_snapshots SET amount_minor=1 WHERE tenant_id=%s AND owner_user_id=%s",owner[:2])
            elif change=="account":
                connection.execute("UPDATE moneylens.accounts SET included=false WHERE tenant_id=%s AND owner_user_id=%s",owner[:2])
            else:
                connection.execute("""INSERT INTO moneylens.balance_snapshots
                    (tenant_id,owner_user_id,id,account_id,amount_minor,currency,balance_kind,pending_reflection,observed_at)
                    VALUES (%s,%s,%s,%s,70000,'EUR','available','excluded',%s)""",(*owner[:2],uuid4(),owner[2],NOW+timedelta(seconds=1)))
        with pytest.raises(AuthError):
            accept(repository,plan,owner)
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.allocations WHERE tenant_id=%s AND owner_user_id=%s",owner[:2]).fetchone()[0]==0


def test_another_owner_cannot_retrieve_accept_or_release_the_plan(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        receipt = accept(repository,plan,owners[0])
    with store(database,owners[1]) as repository:
        for operation in (lambda:repository.read(plan["id"]),lambda:accept(repository,plan,owners[1]),
            lambda:repository.release(plan["id"],receipt["id"],key="release-1",expected_data_version=1,expected_plan_version=3)):
            with pytest.raises(AuthError) as error:
                operation()
            assert error.value.status==404


def test_foreign_account_facts_cannot_enter_a_plan(database,owners):
    inputs = reviewed(database,owners[1])
    with store(database,owners[0]) as repository:
        with pytest.raises(AuthError) as error:
            repository.create(inputs,POLICY,key="foreign-input")
        assert error.value.code=="PLANNING_SCOPE_CHANGED"


def test_release_and_revision_restore_only_unconsumed_reserved_money(database,owners):
    owner = owners[0]
    inputs = reviewed(database,owner)
    with store(database,owner) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        receipt = accept(repository,plan,owner)
        released = repository.release(plan["id"],receipt["id"],key="release-1",expected_data_version=1,expected_plan_version=3)
        assert released["state"]=="released"
        assert repository.release(plan["id"],receipt["id"],key="release-1",expected_data_version=1,expected_plan_version=3)==released
        assert repository.read(plan["id"])["calculation"].amount_minor==20000
        revised = accept(repository,plan,owner,key="revised-1",version=4,amount=6000)
        assert revised["accepted_plan_version"]==5
        assert repository.read(plan["id"])["calculation"].amount_minor==14000
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT consumed_minor,released_minor FROM moneylens.reserves WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*owner[:2],receipt["reserve_id"])).fetchone()==(0,5000)


def test_failed_atomic_effect_rolls_back_the_reserve_version_receipt_and_events(database,owners,monkeypatch):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        def broken(*args):
            raise RuntimeError("injected publication failure")
        monkeypatch.setattr(repository,"record",broken)
        with pytest.raises(RuntimeError):
            accept(repository,plan,owners[0])
        fresh = repository.read(plan["id"])
        assert fresh["plan_version"]==2 and fresh["calculation"].amount_minor==20000
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.reserves WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==0


def test_expiry_hides_current_guidance_and_blocks_acceptance_but_allows_release(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        receipt = accept(repository,plan,owners[0])
    with store(database,owners[0],now=NOW+timedelta(minutes=6)) as repository:
        view = repository.read(plan["id"])
        assert view["current"] is False and view["calculation"] is None
        with pytest.raises(AuthError) as error:
            accept(repository,plan,owners[0],key="late",version=3)
        assert error.value.code=="PLANNING_QUOTE_EXPIRED"
        assert repository.release(plan["id"],receipt["id"],key="release-1",expected_data_version=1,expected_plan_version=3)["state"]=="released"


def test_active_commitments_cannot_disappear_by_replacing_the_plan(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        accept(repository,plan,owners[0])
        inputs.plan_version = 3
        with pytest.raises(AuthError) as error:
            repository.create(inputs,POLICY,key="replacement")
        assert error.value.code=="ACTIVE_ALLOCATIONS_REQUIRE_REVIEW"
        assert repository.read(plan["id"])["calculation"].amount_minor==15000


def test_consumed_savings_cannot_be_released_as_if_they_were_still_reserved(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        receipt = accept(repository,plan,owners[0])
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.reserves SET consumed_minor=1000 WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*owners[0][:2],receipt["reserve_id"]))
        with pytest.raises(AuthError) as error:
            repository.release(plan["id"],receipt["id"],key="release-1",expected_data_version=1,expected_plan_version=3)
        assert error.value.code=="RESERVE_RECONCILIATION_REQUIRED"


def test_duplicate_concurrent_submissions_across_instances_share_one_receipt(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
    def submit(_):
        with store(database,owners[0]) as repository:
            return accept(repository,plan,owners[0])
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(pool.map(submit,range(2)))
    assert receipts[0]==receipts[1]
    with store(database,owners[0]) as repository:
        assert repository.read(plan["id"])["plan_version"]==3


def test_over_capacity_and_foreign_route_choices_create_no_reserve(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        with pytest.raises(AuthError) as error:
            accept(repository,plan,owners[0],amount=10001)
        assert error.value.code=="SAVINGS_EXCEED_CAPACITY"
        with pytest.raises(AuthError) as error:
            accept(repository,plan,owners[1])
        assert error.value.code=="ALLOCATION_ACCOUNT_CAPACITY"
        assert repository.read(plan["id"])["plan_version"]==2


def test_revoked_membership_blocks_new_financial_effects(database,owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.users SET permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
        with pytest.raises(AuthError) as error:
            accept(repository,plan,owners[0])
        assert error.value.status==401


def test_failed_release_restores_commitment_and_version(database,owners,monkeypatch):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        receipt = accept(repository,plan,owners[0])
        def fail(*args):
            raise RuntimeError("injected release publication failure")
        monkeypatch.setattr(repository,"record",fail)
        with pytest.raises(RuntimeError):
            repository.release(plan["id"],receipt["id"],key="release-1",expected_data_version=1,expected_plan_version=3)
        fresh = repository.read(plan["id"])
        assert fresh["plan_version"]==3 and fresh["calculation"].amount_minor==15000


def test_quote_expiry_never_extends_past_balance_freshness(database,owners):
    inputs = reviewed(database,owners[0])
    observed = NOW-timedelta(hours=24)+timedelta(seconds=1)
    inputs.balances[0].observed_at = observed
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.balance_snapshots SET observed_at=%s WHERE tenant_id=%s AND owner_user_id=%s",(observed,*owners[0][:2]))
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        assert plan["expires_at"]==NOW+timedelta(seconds=1)
    with store(database,owners[0],now=NOW+timedelta(seconds=2)) as repository:
        assert repository.read(plan["id"])["calculation"] is None


def test_large_review_is_rejected_before_publication(database,owners):
    inputs = reviewed(database,owners[0])
    original = inputs.costs[0]
    inputs.costs = [original.model_copy(update={"id":uuid4(),"economic_cost_id":uuid4(),"amount_minor":1}) for _ in range(1500)]
    with store(database,owners[0]) as repository:
        with pytest.raises(AuthError) as error:
            repository.create(inputs,POLICY,key="too-large")
        assert error.value.code=="PLANNING_REVIEW_TOO_LARGE"
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.plans WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==0


def test_acceptance_uses_the_protective_cost_estimate_not_optimistic_range(database,owners):
    inputs = reviewed(database,owners[0])
    inputs.costs[0].amount_basis = "reviewed_upper_bound"
    inputs.costs[0].lower_amount_minor = 25000
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="create-1")
        assert plan["calculation"].amount_minor==20000
        assert plan["calculation"].lower_cost_scenario.amount_minor==30000
        with pytest.raises(AuthError) as error:
            accept(repository,plan,owners[0],amount=15000)
        assert error.value.code=="SAVINGS_EXCEED_CAPACITY"
