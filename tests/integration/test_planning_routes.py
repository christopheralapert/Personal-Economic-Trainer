"""Exercise the real HTTP, session, RLS and transactional reservation boundary."""
from datetime import timedelta
from uuid import uuid4

import psycopg
import pytest

from identity_support import ORIGIN, authenticated_app, login
from test_planning_store import NOW, POLICY, reviewed, store


def seed_plan(database, owner):
    inputs = reviewed(database, owner)
    with store(database, owner) as repository:
        return repository.create(inputs, POLICY, key="review-1")


def command(owner, **updates):
    return dict(key="save-1", expected_data_version=1, expected_plan_version=2,
        account_id=str(owner[2]), amount_minor=5000, desired_discretionary_minor=10000, **updates)


def session(client):
    return {"Origin": ORIGIN, "X-CSRF-Token": login(client).json()["csrf_token"]}


def test_http_plan_proposal_accept_receipt_and_release_share_one_surplus(database, owners):
    plan = seed_plan(database, owners[0])
    url = f"/v1/plans/{plan['id']}"
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        headers = session(client)
        response = client.get("/v1/plans/current")
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "private, no-store"
        body = response.json()
        assert body == client.get(url).json()
        assert body["current"] is True and body["analysis"]["status"] == "estimated"
        assert body["analysis"]["result"]["amount_minor"] == 20000
        assert body["analysis"]["evidence"]["source"] == "synthetic_user_confirmed"
        assert body["analysis"]["evidence"]["balance_snapshot_ids"]
        proposal = client.post(url + "/proposal", headers=headers,
            json={"desired_discretionary_minor": 10000, "chosen_savings_minor": 5000})
        assert proposal.status_code == 200, proposal.text
        assert proposal.json()["remaining_spending_minor"] == 15000
        assert proposal.json()["persisted"] is False
        assert client.get(url).json()["analysis"]["result"]["amount_minor"] == 20000
        accepted = client.post(url + "/allocations", headers=headers, json=command(owners[0]))
        assert accepted.status_code == 200, accepted.text
        receipt = accepted.json()
        assert receipt["bank_transfer_executed"] is False and receipt["state"] == "active"
        assert receipt["acceptance_snapshot"]["remaining_spending_at_acceptance_minor"] == 15000
        assert client.post(url + "/allocations", headers=headers, json=command(owners[0])).json() == receipt
        receipt_url = url + "/allocations/" + receipt["id"]
        assert client.get(receipt_url).json() == receipt
        current = client.get(url).json()
        assert current["plan_version"] == 3 and current["analysis"]["result"]["amount_minor"] == 15000
        assert current["analysis"]["calculation_id"] != body["analysis"]["calculation_id"]
        payload = dict(key="release-1", expected_data_version=1, expected_plan_version=3)
        released = client.post(receipt_url + "/release", headers=headers, json=payload)
        assert released.status_code == 200, released.text
        assert released.json()["state"] == "released"
        assert client.post(receipt_url + "/release", headers=headers, json=payload).json() == released.json()
        assert client.get(url).json()["analysis"]["result"]["amount_minor"] == 20000


def test_no_plan_is_explicit_and_anonymous_access_is_denied(database, owners):
    with authenticated_app(database, owners) as (client, app, config):
        assert client.get("/v1/plans/current").status_code == 401
        login(client)
        assert client.get("/v1/plans/current").json() is None
        assert client.get(f"/v1/plans/{uuid4()}").status_code == 404


@pytest.mark.parametrize("change", ["expiry", "data", "account"])
def test_stale_plan_never_publishes_a_current_amount_or_accepts_savings(database, owners, change):
    plan = seed_plan(database, owners[0])
    url = f"/v1/plans/{plan['id']}"
    if change != "expiry":
        with psycopg.connect(database["admin"]) as connection:
            table, assignment = ("user_state", "data_version=data_version+1") if change == "data" else ("accounts", "included=false")
            connection.execute(f"UPDATE moneylens.{table} SET {assignment} WHERE tenant_id=%s AND owner_user_id=%s", owners[0][:2])
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW + (timedelta(minutes=6) if change == "expiry" else timedelta(0))
        headers = session(client)
        body = client.get(url).json()
        assert body["current"] is False and body["calculation"] is None
        assert body["analysis"]["status"] == "blocked" and body["analysis"]["result"]["amount_minor"] is None
        assert body["analysis"]["result"]["surplus_minor"] is None and body["analysis"]["blockers"]
        proposal = client.post(url + "/proposal", headers=headers, json={"desired_discretionary_minor": 10000}).json()
        assert proposal["status"] == "blocked" and proposal["remaining_spending_minor"] is None
        assert client.post(url + "/allocations", headers=headers, json=command(owners[0])).status_code == 409


@pytest.mark.parametrize("foreign_index", [1, 2])
def test_foreign_plan_and_receipt_ids_never_grant_access(database, owners, foreign_index):
    plan = seed_plan(database, owners[foreign_index])
    with store(database, owners[foreign_index]) as repository:
        receipt = repository.accept(plan["id"], **{**command(owners[foreign_index]), "account_id": owners[foreign_index][2]})
    url = f"/v1/plans/{plan['id']}"
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        headers = session(client)
        assert client.get("/v1/plans/current").json() is None
        assert client.get(url).status_code == 404
        assert client.post(url + "/proposal", headers=headers, json={"desired_discretionary_minor": 0}).status_code == 404
        assert client.post(url + "/allocations", headers=headers, json=command(owners[0])).status_code == 404
        receipt_url = url + "/allocations/" + str(receipt["id"])
        assert client.get(receipt_url).status_code == 404
        assert client.post(receipt_url + "/release", headers=headers,
            json=dict(key="release-1", expected_data_version=1, expected_plan_version=3)).status_code == 404


def test_write_routes_require_session_origin_csrf_and_strict_commands(database, owners):
    plan = seed_plan(database, owners[0])
    url = f"/v1/plans/{plan['id']}"
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        assert client.post(url + "/allocations", json=command(owners[0])).status_code == 401
        headers = session(client)
        for route, body in (("/proposal", {"desired_discretionary_minor": 0}), ("/allocations", command(owners[0])),
            (f"/allocations/{uuid4()}/release", dict(key="release-1", expected_data_version=1, expected_plan_version=2))):
            for invalid in ({}, {"Origin": ORIGIN}, {**headers, "Origin": "https://evil.example"}, {**headers, "Sec-Fetch-Site": "cross-site"}):
                assert client.post(url + route, headers=invalid, json=body).status_code == 403
        for change in ({"tenant_id": str(uuid4())}, {"amount_minor": True}, {"amount_minor": "5000"},
            {"amount_minor": 2**53}, {"amount_minor": 0}, {"expected_plan_version": True}, {"key": "bad/key"}):
            assert client.post(url + "/allocations", headers=headers, json={**command(owners[0]), **change}).status_code == 422
        assert client.post(url + "/allocations", headers=headers,
            json={**command(owners[0]), "account_id": str(owners[1][2])}).status_code == 409
        assert client.get(url).json()["plan_version"] == 2


def test_changed_choices_conflict_and_revoked_membership_cannot_replay_receipts(database, owners):
    plan = seed_plan(database, owners[0])
    url = f"/v1/plans/{plan['id']}"
    with authenticated_app(database, owners) as (client, app, config):
        app.state.planning_clock = lambda: NOW
        headers = session(client)
        receipt = client.post(url + "/allocations", headers=headers, json=command(owners[0])).json()
        conflict = client.post(url + "/allocations", headers=headers, json={**command(owners[0]), "amount_minor": 6000})
        assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.users SET permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s", owners[0][:2])
        assert client.get(url).status_code == 401
        assert client.get(url + "/allocations/" + receipt["id"]).status_code == 401
        assert client.post(url + "/allocations", headers=headers, json=command(owners[0])).status_code == 401


def test_private_planning_openapi_documents_cookie_and_write_protection(database, owners):
    with authenticated_app(database, owners) as (client, app, config):
        paths = client.get("/openapi.json").json()["paths"]
        operations = [(method, operation) for path, methods in paths.items() if path.startswith(("/v1/plans", "/v1/planning/"))
            for method, operation in methods.items() if method in ("get", "post")]
        assert len(operations) == 10
        for method, operation in operations:
            assert operation["security"] == [{"SessionCookie": []}]
            names = {item["name"] for item in operation.get("parameters", []) if item.get("required")}
            if method == "post":
                assert {"Origin", "X-CSRF-Token"} <= names
