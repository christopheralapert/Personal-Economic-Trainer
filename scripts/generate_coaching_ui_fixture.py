"""Export synthetic coaching transport facts from the actual rules and contracts.

These deterministic browser fixtures make no network, database or model call.
The real HTTP/SQL and leased worker journeys remain separate integration tests.
"""
from datetime import date,timedelta
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"backend/api"))
sys.path.insert(0,str(ROOT/"tests/api"))

from app.coaching import CoachingPreferencesViewV1,CoachingSnapshotV1,coaching_state
from app.insight_records import InsightSummaryV1,InsightViewV1,PlanningStoredEvidenceV1,SpendingStoredEvidenceV1
from app.insights import planning_insights,spending_insights
from app.ledger import LedgerScopeV1,SpendingTotalsV1
from app.planning_inputs import PlanningInputsV1
from app.spending_comparison import compare_spending
from planning_support import NOW,POLICY,uid,valid_inputs


def totals(start,end,amount,transaction):
    return SpendingTotalsV1(scope=LedgerScopeV1(account_ids=[uid(1)],currency="EUR",start=date.fromisoformat(start),
        end_exclusive=date.fromisoformat(end),data_version=1,permission_version=1,plan_version=1,
        dataset_coverage="covered_synthetic_snapshot"),gross_minor=amount,refunds_minor=0,net_minor=amount,
        expense_count=3,refund_count=0,unresolved_flow_count=0,nonconsumption_count=0,category_baskets=[],merchants=[],
        category_breakdown_truncated=False,merchant_breakdown_truncated=False,
        evidence_filters=dict(start=start,end_exclusive=end),evidence_transaction_ids=[uid(transaction+index) for index in range(3)],
        limitations=["UI-only synthetic booked records; no bank provider was called."])


def main():
    preferences={}
    for name,enabled,version,pause in [("default",False,1,None),("enabled",True,2,None),("paused",True,3,NOW+timedelta(hours=24))]:
        snapshot=CoachingSnapshotV1(id=uid(401),version=version,coaching_enabled=enabled,bill_insights=True,
            headroom_insights=True,spending_insights=True,paused_until=pause,created_at=None if version==1 else NOW,
            updated_at=None if version==1 else NOW)
        preferences[name]=CoachingPreferencesViewV1(**snapshot.model_dump(),as_of=NOW,state=coaching_state(snapshot,NOW)).model_dump(mode="json")
    inputs=valid_inputs();inputs["balances"][0]["amount_minor"]=65000;inputs["costs"][0]["at"]=NOW+timedelta(days=3)
    planned=planning_insights(uid(311),PlanningInputsV1.model_validate(inputs),POLICY,now=NOW,quote_expires_at=NOW+timedelta(minutes=5))
    observed=spending_insights(compare_spending(totals("2026-10-01","2026-11-01",12500,501),
        totals("2026-08-31","2026-10-01",10000,511),"previous_period"),now=NOW)
    records=[]
    for preview in [planned,observed]:
        evidence=PlanningStoredEvidenceV1(policy=preview.policy,planning=preview.evidence,omitted_candidate_count=preview.omitted_candidate_count) if preview is planned else SpendingStoredEvidenceV1(policy=preview.policy,comparison=preview.comparison)
        for candidate in preview.candidates:
            records.append(InsightViewV1(id=candidate.id,status="active",version=1,candidate=candidate,data_version=1,plan_version=1,
                preferences_version=2,generated_at=NOW,expires_at=NOW+timedelta(minutes=5) if preview is planned else NOW+timedelta(hours=12),
                created_at=NOW,updated_at=NOW,dismissed_at=None,current=True,current_blockers=[],evidence=evidence))
    assert {item.candidate.kind:item.candidate.amount_minor for item in records}=={
        "low_headroom":5000,"upcoming_bill":35000,"higher_observed_spending":2500}
    summaries=[InsightSummaryV1(**item.model_dump(exclude={"evidence"}),evidence_kind=item.evidence.kind).model_dump(mode="json") for item in records]
    body=dict(clock=NOW.isoformat(),preferences=preferences,records=[item.model_dump(mode="json") for item in records],summaries=summaries,
        accounts=[dict(id=str(uid(1)),name="Everyday account",currency="EUR",account_type="current",included=True)],
        job=dict(id=str(uid(451)),type="coaching.refresh",state="queued",attempts=0,max_attempts=3,available_at=NOW.isoformat(),
            lease_until=None,finished_at=None,last_error_code=None))
    target=ROOT/"fixtures/synthetic/coaching-ui.v1.json"
    target.write_text(json.dumps(body,indent=2,sort_keys=True)+"\n",encoding="utf-8",newline="\n")
    print("Exported synthetic coaching UI fixture; no provider request made.")


if __name__=="__main__": main()
