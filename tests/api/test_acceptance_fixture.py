"""Acceptance inputs must reconcile to domain ownership and actual engine outcomes."""
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys

import pytest

from app.demo import Profile
from app.planning_engine import calculate_planning
from app.planning_inputs import PlanningInputsV1
from app.planning_policy import PlanningPolicyV1

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"scripts"))
from generate_acceptance_fixture import rendered
from generate_demo import generate

ARTIFACT=json.loads((ROOT/"fixtures/synthetic/acceptance.v1.json").read_text(encoding="utf-8"))


def test_acceptance_bytes_are_reproducible_and_public_demo_is_unchanged():
    for name,raw in rendered().items():
        assert (ROOT/"fixtures/synthetic"/name).read_bytes()==raw
    descriptor=json.loads((ROOT/"fixtures/synthetic/acceptance.v1.manifest.json").read_text())["files"][0]
    raw=(ROOT/"fixtures/synthetic/acceptance.v1.json").read_bytes()
    assert len(raw)==descriptor["size_bytes"] and hashlib.sha256(raw).hexdigest()==descriptor["sha256"]
    assert generate()==json.loads((ROOT/"fixtures/synthetic/demo.v1.json").read_text())


def test_profiles_histories_links_and_boundary_expectations_are_owned():
    owners=[];all_accounts=set();all_messages=set()
    for raw,history,delivery,classification in zip(ARTIFACT["profiles"],ARTIFACT["conversations"],
            ARTIFACT["source_deliveries"],ARTIFACT["classification_evidence"],strict=True):
        profile=Profile.model_validate(raw)
        owner=profile.accounts[0].owner.model_dump(mode="json");owners.append(owner["user_id"])
        accounts={str(account.id) for account in profile.accounts}
        assert not accounts & all_accounts;all_accounts.update(accounts)
        assert len({account.institution_id for account in profile.accounts})==2
        assert all(account.owner.model_dump(mode="json")==owner for account in profile.accounts)
        assert profile.available_balance_minor==80000
        rows={str(row.id):row for row in profile.transactions}
        assert len(rows)==len(profile.transactions)
        assert all(row.owner.model_dump(mode="json")==owner and str(row.account_id) in accounts for row in rows.values())
        for row in rows.values():
            if row.related_transaction_id:
                linked=rows[str(row.related_transaction_id)]
                if row.economic_flow=="internal_transfer":
                    assert linked.related_transaction_id==row.id and linked.account_id!=row.account_id
                    assert row.amount_minor+linked.amount_minor==0
                else: assert row.economic_flow=="refund" and linked.economic_flow=="expense"
        assert profile.october_taxi_count==2 and profile.october_spending["taxi"]==4000
        assert profile.october_spending["dining"]==25000 and profile.october_spending["groceries"]==11800
        identical=[row for row in rows.values() if row.provider_id.startswith("authored-identical-")]
        assert len(identical)==2 and sum(-row.amount_minor for row in identical)==250
        assert classification["owner"]==history["owner"]==delivery["owner"]==owner
        assert rows[classification["transaction_id"]].basket=="unresolved"
        assert classification["confidence_basis_points"]<5000
        messages={message["id"] for message in history["messages"]}
        assert messages and not messages & all_messages;all_messages.update(messages)
        assert delivery["initial"]==delivery["replayed_initial"] and delivery["booked_update"]==delivery["replayed_booked"]
        provisional,booked=delivery["initial"]["records"][0],delivery["booked_update"]["records"][0]
        assert provisional["id"]==booked["id"]==delivery["expected"]["final_transaction_id"]
        assert provisional["provider_id"]==booked["provider_id"] and provisional["amount_minor"]!=booked["amount_minor"]
    assert len(set(owners))==2


@pytest.mark.parametrize("case",ARTIFACT["planning_cases"],ids=lambda case:case["name"])
def test_authored_vectors_use_the_real_planning_engine(case):
    profile=next(profile for profile in ARTIFACT["profiles"] if profile["accounts"][0]["owner"]==case["owner"])
    data=PlanningInputsV1.model_validate(case["inputs"])
    assert {str(account.id) for account in data.accounts}=={account["id"] for account in profile["accounts"]}
    result=calculate_planning(data,PlanningPolicyV1())
    expected=case["expected"]
    assert result.status==expected["status"] and result.amount_minor==expected["amount_minor"]
    assert {blocker.code for blocker in result.blockers}==set(expected["blocker_codes"])
    assert result.prepared.period.requested_to_exclusive==datetime.fromisoformat("2026-11-09T00:00:00+02:00")
    assert result.prepared.period.protection_through==datetime.fromisoformat(expected["protection_through"])
    assert result.prepared.period.reason==expected["horizon_reason"]
    if expected["shortfall_minor"] is None:
        assert result.baseline is None
    else:
        assert result.baseline.consolidated.shortfall_minor==expected["shortfall_minor"]
        if "minimum_headroom_at" in expected:
            assert result.baseline.consolidated.minimum_headroom_at==datetime.fromisoformat(expected["minimum_headroom_at"])
