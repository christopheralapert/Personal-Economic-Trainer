"""Author fixed-clock acceptance vectors independently of bank/customer/model services."""
import argparse
from copy import deepcopy
from datetime import datetime,timedelta
import hashlib
import json
from pathlib import Path
import sys

from generate_demo import generate as demo_fixture,ident

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"backend/api"))
from app.demo import Profile
from app.contracts import Transaction
from app.planning_inputs import PlanningInputsV1

VERSION="acceptance.v1"
NOW="2026-11-04T00:00:00+02:00"
THROUGH="2026-12-04T00:00:00+02:00"
NAMES=("base","uncertain_income","early_shortfall","missing_balance","pending_already_reflected")


def at(days):
    return (datetime.fromisoformat(NOW)+timedelta(days=days)).isoformat()


def planning(profile,key):
    first,second=profile["accounts"]
    return {"data_version":1,"plan_version":1,"as_of":NOW,
        "requested_to_exclusive":"2026-11-09T00:00:00+02:00",
        "source":"synthetic_user_confirmed","obligations_reviewed_through":THROUGH,
        "accounts":[dict(id=account["id"],currency="EUR",account_type="current",liquid=True,material=True,
            synced_at=NOW,coverage="user_confirmed",coverage_through=NOW,liability_covered=None)
            for account in profile["accounts"]],
        "balances":[{**balance,"inaccessible_minor":0} for balance in profile["balances"]],
        "protections":[dict(id=ident(f"{key}-{kind}"),kind=kind,amount_minor=amount,reviewed_through=THROUGH,
            routes=[dict(account_id=account,amount_minor=amount)] if amount else [])
            for kind,amount,account in (("essentials",15000,first["id"]),("irregular",0,first["id"]),
                ("savings",0,first["id"]),("buffer",10000,second["id"]))],
        "costs":[dict(id=ident(f"{key}-bill"),economic_cost_id=ident(f"{key}-bill-effect"),account_id=first["id"],
            at=at(28),amount_minor=35000,opening_reflected=False,kind="bill")]}


def build():
    profiles=demo_fixture()["profiles"]
    histories=[];classifications=[];deliveries=[]
    for index,profile in enumerate(profiles):
        profile["fixture_version"]=VERSION
        key=f"household-{'ab'[index]}"
        owner=profile["accounts"][0]["owner"]
        pending={**profile["transactions"][0],"id":ident(f"{key}-pending"),"provider_id":"authored-pending-1",
            "amount_minor":-1250,"booked_on":"2026-11-03","status":"pending","merchant":"Synthetic pending purchase",
            "category":"shopping","basket":"everyday"}
        profile["transactions"].append(pending)
        # Identical purchases remain separate economic events, not duplicates by content.
        for number in (1,2):
            profile["transactions"].append({**profile["transactions"][10],"id":ident(f"{key}-identical-{number}"),
                "provider_id":f"authored-identical-{number}","amount_minor":-125,"merchant":"Synthetic cafe"})
        booked={**pending,"status":"booked","amount_minor":-1200}
        deliveries.append({"owner":owner,"source":"authored-pages.v1","initial":
            {"cursor":"page-1","revision":1,"observed_at":NOW,"records":[pending]},
            "replayed_initial":{"cursor":"page-1","revision":1,"observed_at":NOW,"records":[deepcopy(pending)]},
            "booked_update":{"cursor":"page-2","revision":2,"observed_at":at(1),"records":[booked]},
            "replayed_booked":{"cursor":"page-2","revision":2,"observed_at":at(1),"records":[deepcopy(booked)]},
            "expected":{"economic_effect_count":1,"final_status":"booked","final_amount_minor":-1200,
                "final_transaction_id":pending["id"],"liquidity_already_reflected":True}})
        histories.append({"owner":owner,"id":ident(f"{key}-conversation"),"messages":[
            {"id":ident(f"{key}-message"),"role":"user","created_at":NOW,
                "content":"How much did I spend on taxis last month?" if index==0 else "What is safe for me to spend this week?"}]})
        classifications.append({"owner":owner,"transaction_id":profile["transactions"][2]["id"],
            "source":"authored-uncertainty-example","rule_version":"claims.v1","confidence_basis_points":3500,
            "necessity":"unknown","recurrence":"unknown","reason":"Transport label alone does not establish purpose."})
        # Validate strict domain contracts, without loading or changing the public demo.
        Profile.model_validate(profile)
        for record in (pending,booked): Transaction.model_validate(record)

    cases=[]
    for name in NAMES:
        profile=profiles[1] if name in ("uncertain_income","early_shortfall") else profiles[0]
        data=planning(profile,name)
        first=data["accounts"][0]
        expected={"status":"estimated","amount_minor":20000,"shortfall_minor":0,"blocker_codes":[],
            "protection_through":THROUGH,"horizon_reason":"minimum_fallback"}
        if name in ("uncertain_income","early_shortfall"):
            for balance in data["balances"]: balance["amount_minor"]=10000 if balance["account_id"]==first["id"] else 0
            for protection in data["protections"]: protection.update(amount_minor=0,routes=[])
            data["costs"][0].update(at=at(1),amount_minor=15000)
            data["incomes"]=[dict(id=ident(f"{name}-income"),account_id=first["id"],at=at(3),
                amount_minor=20000,confirmed=name=="early_shortfall")]
            expected.update(amount_minor=0,shortfall_minor=5000,minimum_headroom_at=at(1))
            if name=="early_shortfall":
                expected.update(protection_through=at(10),horizon_reason="confirmed_income_plus_seven_days")
        elif name=="missing_balance":
            data["balances"]=[balance for balance in data["balances"] if balance["account_id"]!=first["id"]]
            expected.update(status="blocked",amount_minor=None,shortfall_minor=None,
                blocker_codes=["BALANCE_MISSING_OR_AMBIGUOUS"])
        elif name=="pending_already_reflected":
            data["pending"]=[dict(id=ident("reflected-pending"),account_id=first["id"],amount_minor=1250,
                economic_cost_id=ident("reflected-pending-effect"),state="pending",kind="bill")]
        cases.append({"name":name,"owner":profile["accounts"][0]["owner"],
            "inputs":PlanningInputsV1.model_validate(data).model_dump(mode="json"),"expected":expected})

    return {"fixture_version":VERSION,"seed":311045,"as_of":NOW,"timezone":"Europe/Helsinki","currency":"EUR",
        "notice":"Independently authored synthetic acceptance data, not organizer/customer records or executable source code.",
        "profiles":profiles,"conversations":histories,"classification_evidence":classifications,
        "recurring_obligations":[{"owner":profile["accounts"][0]["owner"],"account_id":profile["accounts"][0]["id"],
            "evidence_transaction_ids":[profile["transactions"][6]["id"]],"amount_minor":35000,"currency":"EUR",
            "cadence":"monthly","day_of_month":2,"next_at":at(28),"necessity":"essential",
            "reviewed":True,"source":"authored-synthetic-confirmation"} for profile in profiles],
        "source_deliveries":deliveries,"planning_cases":cases,
        "historical_expectations":{"period":{"start":"2026-10-01","end_exclusive":"2026-11-01"},
            "taxi":{"gross_minor":4000,"count":2},"dining":{"gross_minor":25000,"reduction_percent":20,"savings_minor":5000},
            "groceries":{"gross_minor":12100,"refunds_minor":300,"net_minor":11800},
            "internal_transfer":{"debit_minor":-10000,"credit_minor":10000,"consolidated_consumption_minor":0},
            "identical_purchases":{"count":2,"gross_minor":250}}}


def rendered():
    raw=(json.dumps(build(),indent=2,sort_keys=True)+"\n").encode("utf-8")
    manifest={"fixture_version":VERSION,"generator":"scripts/generate_acceptance_fixture.py",
        "mapping":"moneylens.domain.v1+planning-inputs.v1","seed":311045,"as_of":NOW,"timezone":"Europe/Helsinki",
        "runtime":{"python":"3.12","money":"integer minor units","randomness":"none; UUIDv5 named identities"},
        "files":[{"path":"acceptance.v1.json","size_bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()}]}
    return {"acceptance.v1.json":raw,"acceptance.v1.manifest.json":(json.dumps(manifest,indent=2,sort_keys=True)+"\n").encode("utf-8")}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,default=ROOT/"fixtures/synthetic")
    parser.add_argument("--check",action="store_true",help="Verify exact generated bytes without changing files")
    args=parser.parse_args()
    for name,raw in rendered().items():
        target=args.output/name
        if args.check:
            if not target.is_file() or target.read_bytes()!=raw: raise SystemExit(f"Synthetic fixture differs: {name}")
        else:
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
    print("Verified" if args.check else "Generated",VERSION,"with fixed clock and no external requests.")


if __name__=="__main__": main()
