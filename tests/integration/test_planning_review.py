from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

import psycopg
import pytest

from app.planning_policy import PlanningPolicyV1
from app.identity import AuthError
from app.planning_review import CreateReviewedPlanV1, PlanningReview
from identity_support import authenticated_app, login
from test_planning_routes import command, session
from test_planning_store import NOW, reviewed, store


def review_body(database, owner):
    inputs = reviewed(database, owner)
    for protection in inputs.protections:
        protection.reviewed_through = NOW+timedelta(days=31)
    return dict(key="review-1", expected_data_version=1, expected_plan_version=1,
        accounts=[dict(account_id=str(owner[2]), balance_snapshot_id=str(inputs.balances[0].id),
            inaccessible_minor=0, coverage_confirmed=True, liability_covered=None)],
        protections=[item.model_dump(mode="json") for item in inputs.protections],
        obligations_reviewed_through=(NOW+timedelta(days=31)).isoformat(),
        extra_costs=[item.model_dump(mode="json") for item in inputs.costs])


def test_review_context_exposes_only_owned_facts_without_inventing_current_source_time(database, owners):
    body = review_body(database, owners[0])
    reviewed(database, owners[1])
    reviewed(database, owners[2])
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW+timedelta(hours=25)
        assert client.get("/v1/planning/context").status_code == 401
        login(client)
        response = client.get("/v1/planning/context")
        assert response.status_code == 200, response.text
        context = response.json()
        assert context["data_version"] == 1 and context["plan_version"] == 1
        assert context["source"] == "synthetic_user_confirmed"
        assert [row["id"] for row in context["accounts"]] == [str(owners[0][2])]
        balance = context["accounts"][0]["balance"]
        assert balance["id"] == body["accounts"][0]["balance_snapshot_id"]
        assert balance["observed_at"] == NOW.isoformat().replace("+00:00", "Z")
        assert balance["inaccessible_minor"] is None
        assert context["as_of"] != balance["observed_at"]
        assert context["existing_reservations_require_review"] is False
        assert response.headers["cache-control"] == "private, no-store"


def test_create_review_bind_source_balance_replay_later_accept_and_release(database, owners):
    body = review_body(database, owners[0])
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        headers = session(client)
        response = client.post("/v1/plans", headers=headers, json=body)
        assert response.status_code == 200, response.text
        plan = response.json()["plan"]
        assert plan["plan_version"] == 2 and plan["analysis"]["result"]["amount_minor"] == 20000
        app.state.planning_clock = lambda: NOW+timedelta(minutes=1)
        assert client.post("/v1/plans", headers=headers, json=body).json() == response.json()
        receipt = client.post(f"/v1/plans/{plan['id']}/allocations", headers=headers, json=command(owners[0]))
        assert receipt.status_code == 200, receipt.text
        replay = client.post("/v1/plans", headers=headers, json=body)
        assert replay.json()["plan"]["id"] == plan["id"]
        assert replay.json()["plan"]["plan_version"] == 3
        assert replay.json()["plan"]["analysis"]["result"]["amount_minor"] == 15000
        app.state.planning_clock = lambda: NOW+timedelta(minutes=6)
        stale = client.post("/v1/plans", headers=headers, json=body).json()
        assert stale["plan"]["current"] is False and stale["calculation"] is None
        assert stale["plan"]["analysis"]["result"]["amount_minor"] is None
        assert client.post("/v1/plans", headers=headers, json={**body, "key": "review-2", "expected_plan_version": 3}).status_code == 409


@pytest.mark.parametrize("change,code", [("coverage", "ACCOUNT_COVERAGE_UNKNOWN"),
    ("inaccessible", "OWN_FUNDS_COMPONENTS_UNKNOWN"), ("protection", "PROTECTION_AMOUNT_UNKNOWN"),
    ("horizon", "OBLIGATIONS_UNREVIEWED"), ("freshness", "SYNC_STALE_OR_MISSING"),
    ("long", "BACKGROUND_SCENARIO_REQUIRED")])
def test_material_missing_review_returns_blockers_and_publishes_nothing(database, owners, change, code):
    body = review_body(database, owners[0])
    if change == "coverage":
        body["accounts"][0]["coverage_confirmed"] = False
    elif change == "inaccessible":
        body["accounts"][0]["inaccessible_minor"] = None
    elif change == "protection":
        body["protections"][0]["amount_minor"] = None
    elif change == "horizon":
        body["obligations_reviewed_through"] = None
    elif change == "long":
        body["requested_to_exclusive"] = (NOW+timedelta(days=100)).isoformat()
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW+(timedelta(hours=25) if change == "freshness" else timedelta(0))
        response = client.post("/v1/plans", headers=session(client), json=body)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["plan"] is None and result["calculation"]["status"] == "blocked"
        assert result["calculation"]["amount_minor"] is None
        assert code in {row["code"] for row in result["calculation"]["blockers"]}
        assert client.get("/v1/plans/current").json() is None
    with psycopg.connect(database["admin"]) as connection:
        for table in ("plans", "reserves", "allocations", "outbox_events"):
            assert connection.execute("SELECT count(*) FROM moneylens."+table+" WHERE tenant_id=%s AND owner_user_id=%s", owners[0][:2]).fetchone()[0] == 0


@pytest.mark.parametrize("change", ["balance", "scope", "duplicate", "version", "client-authority", "past-period"])
def test_review_rejects_forged_source_scope_versions_and_clock(database, owners, change):
    body = review_body(database, owners[0])
    if change == "balance":
        foreign = reviewed(database, owners[1])
        body["accounts"][0]["balance_snapshot_id"] = str(foreign.balances[0].id)
    elif change == "scope":
        body["accounts"][0]["account_id"] = str(owners[1][2])
    elif change == "duplicate":
        body["accounts"] *= 2
    elif change == "version":
        body["expected_data_version"] += 1
    elif change == "client-authority":
        body["as_of"] = NOW.isoformat()
        body["accounts"][0]["amount_minor"] = 999999
    else:
        body["requested_to_exclusive"] = (NOW-timedelta(days=1)).isoformat()
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        response = client.post("/v1/plans", headers=session(client), json=body)
        assert response.status_code == (422 if change in ("client-authority", "past-period") else 409), response.text
        assert client.get("/v1/plans/current").json() is None


def test_source_pending_debits_and_obligations_cannot_be_removed_by_review(database, owners):
    body = review_body(database, owners[0])
    body["extra_costs"] = []
    owner = owners[0]
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("""INSERT INTO moneylens.obligations
            (tenant_id,owner_user_id,id,account_id,amount_minor,currency,due_at,state,assumption_source)
            VALUES (%s,%s,%s,%s,35000,'EUR',%s,'planned','synthetic')""", (*owner[:2],uuid4(),owner[2],NOW+timedelta(days=16)))
        for amount in (-5000, 900000):
            tid = uuid4()
            connection.execute("""INSERT INTO moneylens.transactions
                (tenant_id,owner_user_id,id,account_id,source_id,amount_minor,currency,booked_on,status,merchant,category,basket,economic_flow)
                VALUES (%s,%s,%s,%s,%s,%s,'EUR','2026-11-04','pending','Synthetic shop','unknown','unresolved','unknown')""",
                (*owner[:2],tid,owner[2],str(tid),amount))
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        response = client.post("/v1/plans", headers=session(client), json=body)
        assert response.status_code == 200, response.text
        assert response.json()["plan"]["analysis"]["result"]["amount_minor"] == 15000
        context = client.get("/v1/planning/context").json()
        assert len(context["pending"]) == 2 and len(context["obligations"]) == 1


def test_existing_reserves_and_omitted_included_accounts_block_replacement(database, owners):
    body = review_body(database, owners[0])
    owner = owners[0]
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("""INSERT INTO moneylens.reserves (tenant_id,owner_user_id,id,account_id,kind,amount_minor,currency)
            VALUES (%s,%s,%s,%s,'buffer',1000,'EUR')""", (*owner[:2],uuid4(),owner[2]))
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        headers = session(client)
        response = client.post("/v1/plans", headers=headers, json=body)
        assert response.status_code == 409 and response.json()["error"]["code"] == "EXISTING_RESERVATIONS_REQUIRE_REVIEW"
        assert client.get("/v1/planning/context").json()["existing_reservations_require_review"] is True
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.reserves SET released_minor=amount_minor WHERE tenant_id=%s AND owner_user_id=%s", owner[:2])
            connection.execute("""INSERT INTO moneylens.accounts (tenant_id,owner_user_id,id,name,currency,account_type)
                VALUES (%s,%s,%s,'Unreviewed second account','EUR','current')""", (*owner[:2],uuid4()))
        assert client.post("/v1/plans", headers=headers, json=body).json()["error"]["code"] == "PLANNING_SCOPE_CHANGED"


def test_concurrent_identical_reviews_publish_one_plan_and_keep_the_original_server_clock(database, owners):
    body = CreateReviewedPlanV1.model_validate(review_body(database, owners[0]))
    def attempt(offset):
        with store(database, owners[0], now=NOW+timedelta(seconds=offset)) as repository:
            # Repository fixture is a verified internal principal; review requires
            # the same synthetic identity property as real sessions.
            repository.user.synthetic = True
            return PlanningReview(repository, PlanningPolicyV1()).create(body)[0]
    with ThreadPoolExecutor(max_workers=2) as pool:
        views = list(pool.map(attempt, (0, 1)))
    assert views[0]["id"] == views[1]["id"] and views[0]["as_of"] == views[1]["as_of"]
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.plans WHERE tenant_id=%s AND owner_user_id=%s", owners[0][:2]).fetchone()[0] == 1


def test_review_write_protection_body_limits_and_conflicting_keys(database, owners):
    body = review_body(database, owners[0])
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        headers = session(client)
        assert client.post("/v1/plans", json=body).status_code == 403
        assert client.post("/v1/plans", headers={**headers, "Origin": "https://evil.example"}, json=body).status_code == 403
        assert client.post("/v1/plans", headers=headers, content=b"x"*65537).status_code == 413
        assert client.post(f"/v1/plans/{uuid4()}/proposal", headers=headers, content=b"x"*8193).status_code == 413
        assert client.post("/v1/plans", headers=headers, json=body).status_code == 200
        body["extra_costs"][0]["amount_minor"] += 1
        response = client.post("/v1/plans", headers=headers, json=body)
        assert response.status_code == 409 and response.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


def test_review_keeps_calculated_zero_and_shortfall_distinct_from_missing_inputs(database, owners):
    body = review_body(database, owners[0])
    body["extra_costs"][0]["amount_minor"] = 60000
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        response = client.post("/v1/plans", headers=session(client), json=body)
        assert response.status_code == 200, response.text
        analysis = response.json()["plan"]["analysis"]
        assert analysis["status"] == "estimated" and analysis["result"]["amount_minor"] == 0
        assert analysis["result"]["shortfall_minor"] == 5000
        assert analysis["result"]["minimum_headroom_minor"] == -5000


def test_source_review_limits_fail_explicitly_instead_of_truncating_obligations(database, owners):
    body = review_body(database, owners[0])
    owner = owners[0]
    with psycopg.connect(database["admin"]) as connection:
        with connection.cursor() as cursor:
            cursor.executemany("""INSERT INTO moneylens.obligations
                (tenant_id,owner_user_id,id,account_id,amount_minor,currency,due_at,state,assumption_source)
                VALUES (%s,%s,%s,%s,1,'EUR',%s,'planned','synthetic')""",
                [(*owner[:2],uuid4(),owner[2],NOW+timedelta(days=1)) for _ in range(501)])
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        response = client.post("/v1/plans", headers=session(client), json=body)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "PLANNING_BACKGROUND_REVIEW_REQUIRED"
        assert client.get("/v1/plans/current").json() is None


def test_verified_provider_mode_cannot_be_claimed_by_a_synthetic_review(database, owners):
    review_body(database, owners[0])
    with store(database, owners[0]) as repository:
        repository.user.synthetic = False
        with pytest.raises(AuthError) as error:
            PlanningReview(repository, PlanningPolicyV1()).context()
        assert error.value.code == "PLANNING_SOURCE_NOT_READY"


@pytest.mark.parametrize("change", ["unrepresentable-utc", "income-horizon-overflow"])
def test_extreme_review_instants_are_rejected_without_an_internal_error(database, owners, change):
    body = review_body(database, owners[0])
    if change == "unrepresentable-utc":
        body["protections"][0]["reviewed_through"] = "0001-01-01T00:00:00+14:00"
    else:
        body["incomes"] = [dict(id=str(uuid4()), account_id=str(owners[0][2]), amount_minor=100,
            at="9999-12-31T12:00:00Z", confirmed=True)]
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        response = client.post("/v1/plans", headers=session(client), json=body)
        assert response.status_code == 422, response.text
