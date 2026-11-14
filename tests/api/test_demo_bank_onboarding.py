"""Public simulator exercises registered adapters, never identity or live AIS."""
import json
import time
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.settings import Settings
from app import demo_banks
from app.live_banking_provider import EnableBankingClient
from app.synthetic_registry import SYNTHETIC_INSTITUTIONS, SyntheticBankId
from typing import get_args


@pytest.fixture
def demo(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Public demo must never reach a live provider")
    monkeypatch.setattr(EnableBankingClient, "request", forbidden)
    with TestClient(create_app(Settings(environment="test", allow_demo=True, auth_enabled=False))) as client:
        yield client


def send(client, action, token=None, institution="s-bank-demo"):
    return client.post("/v1/demo/banks/command", json={"action": action, "institution": institution, "token": token})


def test_public_simulated_consent_import_and_replay_are_fixture_only(demo):
    banks = demo.get("/v1/demo/banks").json()
    assert {bank["id"] for bank in banks} == set(SYNTHETIC_INSTITUTIONS) == set(get_args(SyntheticBankId))
    assert {country:sum(bank["country"]==country for bank in banks) for country in ("EE","FI")} == {"EE":4,"FI":4}
    assert all(bank["mode"] == "synthetic" and not bank["payments_supported"] for bank in banks)
    selected = send(demo, "select").json()
    assert selected["state"] == "consent"
    assert send(demo, "import", selected["token"]).status_code == 409
    approved = send(demo, "approve", selected["token"]).json()
    imported = send(demo, "import", approved["token"])
    assert imported.status_code == 200
    data = imported.json()
    assert data["mode"] == "simulated" and data["booked_transactions"] > 0
    assert all(row["status"] == "booked" and row["currency"] == "EUR" for row in data["transactions"])
    assert len({row["reference"] for row in data["transactions"]}) == data["booked_transactions"]
    assert send(demo, "import", approved["token"]).json() == data
    assert demo.get("/v1/dashboard").status_code == 404
    assert demo.post("/v1/live-banking/connect", json={}).status_code == 404


def test_cancel_invalid_state_expiry_and_bank_binding(demo):
    selected = send(demo, "select").json()
    assert send(demo, "cancel", selected["token"]).json()["state"] == "cancelled"
    assert send(demo, "approve", selected["token"], "north-demo").status_code == 409
    assert send(demo, "approve", "not-a-simulation-token").status_code == 409
    payload = demo_banks._cipher.decrypt(selected["token"].encode())
    expired = demo_banks._cipher.encrypt_at_time(payload, int(time.time()) - 601).decode()
    assert send(demo, "approve", expired).status_code == 409
    forged = json.loads(payload); forged["stage"] = "connected"
    assert send(demo, "import", json.dumps(forged)).status_code == 409


def test_simulator_is_not_registered_in_private_only_deployment():
    with TestClient(create_app(Settings(environment="test", allow_demo=False, auth_enabled=False))) as client:
        assert client.get("/v1/demo/banks").status_code == 404


@pytest.mark.parametrize("institution",SYNTHETIC_INSTITUTIONS)
def test_each_visible_fictional_bank_supports_complete_flow(demo,institution):
    selected=send(demo,"select",institution=institution).json()
    assert selected["name"]==SYNTHETIC_INSTITUTIONS[institution]["name"]
    assert send(demo,"cancel",selected["token"],institution).json()["state"]=="cancelled"
    selected=send(demo,"select",institution=institution).json()
    approved=send(demo,"approve",selected["token"],institution).json()
    imported=send(demo,"import",approved["token"],institution)
    assert imported.status_code==200
    data=imported.json()
    assert data["state"]=="imported" and data["booked_transactions"]>0
    assert all(row["currency"]=="EUR" and row["status"]=="booked" for row in data["transactions"])
    assert len({row["reference"] for row in data["transactions"]})==data["booked_transactions"]
    assert send(demo,"import",approved["token"],institution).json()==data
