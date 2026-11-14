from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings


@pytest.fixture
def client():
    return TestClient(create_app(Settings(environment="test", allow_demo=True)))


def test_health_describes_actual_dependency_readiness(client):
    result = client.get("/health/ready")
    assert result.status_code == 200
    assert result.json()["status"] == "demo_ready"
    assert result.json()["database"] == "not_connected"
    assert result.headers["cache-control"] == "private, no-store"
    assert result.headers["x-request-id"]


def test_profile_is_explicitly_synthetic_and_does_not_expose_other_profile(client):
    result = client.get("/v1/demo/profile")
    data = result.json()
    assert data["mode"] == "synthetic"
    assert len(data["accounts"]) == 2
    assert sum(x["amount_minor"] for x in data["balances"]) == 80000
    assert data["available_balance_minor"] == 80000
    assert data["october_spending"]["taxi"] == 4000
    assert data["october_spending"]["groceries"] == 11800
    assert "transfer" not in data["october_spending"]
    assert data["october_taxi_count"] == 2
    assert len({tx["owner"]["user_id"] for tx in data["transactions"]}) == 1


def test_week_and_protection_horizons_are_distinct(client):
    data = client.post("/v1/demo/plan",json={"savings_minor":5000}).json()
    assert data["requested_to_exclusive"] == "2026-11-09"
    assert datetime.fromisoformat(data["protection_through"]).date().isoformat() == "2026-12-04"
    assert data["analysis"]["result"]["surplus_minor"] == 20000
    assert data["remaining_spending_minor"] == 15000
    assert data["persisted"] is False


def test_excessive_saving_is_blocked_not_clamped(client):
    data = client.post("/v1/demo/plan",json={"savings_minor":20001}).json()
    assert data["analysis"]["status"] == "blocked"
    assert data["analysis"]["result"]["amount_minor"] is None
    assert data["remaining_spending_minor"] is None


def test_demo_retains_long_protection_period_and_returns_actionable_job_block():
    client = TestClient(create_app(Settings(environment="test",fallback_horizon_days=90,interactive_horizon_days=30)))
    response = client.post("/v1/demo/plan",json={})
    assert response.status_code==200
    analysis = response.json()["analysis"]
    assert analysis["status"]=="blocked" and analysis["result"]["amount_minor"] is None
    assert analysis["blockers"][0]["code"]=="BACKGROUND_SCENARIO_REQUIRED"


@pytest.mark.parametrize("body", [{"savings_minor":1.5},{"savings_minor":True},{"savings_minor":-1},{"savings_minor":0,"user_id":"other"}])
def test_invalid_planning_inputs_are_rejected_without_echo(client,body):
    result = client.post("/v1/demo/plan",json=body)
    assert result.status_code == 422
    assert result.json()["error"]["code"] == "INVALID_REQUEST"
    assert '"input"' not in result.text


def test_scenario_uses_complete_october_baseline(client):
    data = client.post("/v1/demo/scenario",json={"percent":20,"months":12}).json()
    assert data["baseline_minor"] == 25000
    assert data["monthly_reduction_minor"] == 5000
    assert data["total_reduction_minor"] == 60000


def test_repeated_proposals_do_not_reserve_funds(client):
    for _ in range(2):
        assert client.post("/v1/demo/plan",json={"savings_minor":5000}).json()["remaining_spending_minor"] == 15000
    assert client.post("/v1/demo/plan",json={"savings_minor":0}).json()["remaining_spending_minor"] == 20000


def test_public_demo_can_be_disabled_in_production():
    client = TestClient(create_app(Settings(environment="production",allow_demo=False)))
    assert client.get("/v1/demo/profile").status_code == 404
    assert client.post("/v1/demo/plan",json={}).status_code == 404
