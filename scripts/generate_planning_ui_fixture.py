"""Generate deterministic UI-only transport fixtures from the real domain engine.

No database, model credential or provider request is used. These browser mocks
complement the separately verified real HTTP/PostgreSQL planning tests.
"""
from datetime import timedelta
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT / "services/api"))
sys.path.insert(0,str(ROOT / "tests/api"))

from app.planning_engine import calculate_planning
from app.planning_inputs import PlanningInputsV1, ProtectionRouteV1
from app.planning_routes import plan_view
from app.planning_policy import protection_period
from app.planning_review import ReviewContextV1
from planning_support import NOW, POLICY, uid, valid_inputs


def main():
    inputs = PlanningInputsV1.model_validate(valid_inputs())
    context = ReviewContextV1(data_version=1,plan_version=1,as_of=NOW,policy=POLICY,period=protection_period(NOW,POLICY),
        accounts=[dict(id=uid(1),name="Everyday account",currency="EUR",account_type="current",
            balance={**inputs.balances[0].model_dump(),"inaccessible_minor":None})],
        obligations=[dict(id=uid(20),account_id=uid(1),amount_minor=35000,currency="EUR",due_at=NOW+timedelta(days=16))],
        pending=[],existing_reservations_require_review=False,assumptions=["UI-only synthetic transport fixture."])
    states = {}
    for name,version,saving in (("saved",2,0),("reserved",3,5000),("released",4,0)):
        copy = inputs.model_copy(deep=True)
        copy.plan_version = version
        protection = next(item for item in copy.protections if item.kind=="savings")
        protection.amount_minor = saving
        protection.routes = [ProtectionRouteV1(account_id=uid(1),amount_minor=saving)] if saving else []
        view = plan_view(dict(id=uid(50),state="active",data_version=1,plan_version=version,as_of=NOW,
            source=copy.source,balance_snapshot_ids=[uid(2)],expires_at=NOW+timedelta(minutes=5),current=True,
            calculation=calculate_planning(copy,POLICY)))
        states[name] = dict(plan=view.model_dump(mode="json"),review={"plan_id":str(uid(50)),"current":True,
            "inputs":copy.model_dump(mode="json"),"policy":POLICY.model_dump(mode="json")})
    receipt = dict(id=str(uid(60)),plan_id=str(uid(50)),reserve_id=str(uid(61)),account_id=str(uid(1)),amount_minor=5000,
        currency="EUR",state="active",accepted_plan_version=3,acceptance_snapshot=dict(data_version=1,plan_version=3,
            surplus_before_minor=20000,remaining_spending_at_acceptance_minor=15000,desired_discretionary_minor=10000,
            as_of=NOW.isoformat()),accepted_at=NOW.isoformat(),released_at=None,bank_transfer_executed=False)
    body = dict(clock=NOW.isoformat(),context=context.model_dump(mode="json"),states=states,receipt=receipt,
        session=dict(session_id=str(uid(102)),owner=dict(tenant_id=str(uid(100)),user_id=str(uid(101))),display_name="Synthetic Aino",
            synthetic=True,permission_version=1,expires_at=(NOW+timedelta(hours=1)).isoformat(),csrf_token="ui-only-csrf-not-a-real-session"))
    path = ROOT / "fixtures/synthetic/planning-ui.v1.json"
    path.write_text(json.dumps(body,sort_keys=True,indent=2)+"\n",encoding="utf-8",newline="\n")
    print("Generated UI-only planning fixture; no network request made.")


if __name__=="__main__":
    main()
