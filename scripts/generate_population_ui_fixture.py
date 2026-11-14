"""Deterministic UI transport examples from the real population engine.

Authored ledger/source facts are synthetic and UI-only. Public survey values,
mapping and calculation results come from the verified bundled artifacts.
No network, database, model credentials or provider request is used.
"""
from datetime import datetime,timezone
import json
from pathlib import Path
import sys
from uuid import UUID

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"services/api"))

from app.category_crosswalk import load_crosswalk
from app.ledger import SpendingGroupV1,SpendingTotalsV1
from app.population_cohorts import bundled_cohort_catalog
from app.population_comparison import PopulationComparisonRequestV1,compare_population,unavailable_comparison
from app.public_routes import bundled_public_context

NOW=datetime(2026,11,4,10,tzinfo=timezone.utc)


def main():
    policy=load_crosswalk()
    catalog=bundled_cohort_catalog()
    public=bundled_public_context()
    account_id=str(UUID(int=1))
    source=dict(account_id=account_id,connection_id=str(UUID(int=2)),institution_id="s-bank-demo",mode="synthetic",
        consent_state="active",granted=True,sync_health="fresh",observed_at=NOW.isoformat(),history_from="2026-08-01",
        history_to_exclusive="2026-11-05",last_success_at=NOW.isoformat(),last_error_code=None,source_version="ui-only.v1",timezone="Europe/Helsinki")
    groups=[SpendingGroupV1(label="taxi",basket="everyday",gross_minor=12000,refunds_minor=2000,net_minor=10000,transaction_count=2),
        SpendingGroupV1(label="groceries",basket="mandatory_regular",gross_minor=5000,refunds_minor=0,net_minor=5000,transaction_count=1)]
    totals=SpendingTotalsV1(scope=dict(account_ids=[account_id],currency="EUR",start="2026-10-01",end_exclusive="2026-11-01",permission_version=1,
        data_version=1,plan_version=1,dataset_coverage="covered_synthetic_snapshot",sources=[source]),gross_minor=17000,refunds_minor=2000,net_minor=15000,
        expense_count=2,refund_count=1,unresolved_flow_count=0,nonconsumption_count=0,category_baskets=groups,merchants=[],category_breakdown_truncated=False,
        merchant_breakdown_truncated=False,evidence_filters=dict(start="2026-10-01",end_exclusive="2026-11-01"),evidence_transaction_ids=[],limitations=[])
    base=dict(household_code="1",reference_period="2022",start="2026-10-01",end_exclusive="2026-11-01",currency="EUR",coicop_codes=["07322","01"],
        comparison_basis="monthly_equivalent",household_coverage_confirmed=True,allow_short_period_approximation=True,allow_reference_year_mismatch=True)
    suppressed=next(item for item in public.observations if item.source_status)
    scenarios={}
    for name,changes in [
        ("partial",{}),
        ("unconfirmed",dict(household_coverage_confirmed=False,allow_short_period_approximation=False,allow_reference_year_mismatch=False)),
        ("taxi",dict(coicop_codes=["07322"])),
        ("annual_short",dict(comparison_basis="annual_observed")),
        ("suppressed",dict(household_code=suppressed.household_code,coicop_codes=[suppressed.coicop_code])),
        ("stale",{}),("unavailable",{}),
    ]:
        body=PopulationComparisonRequestV1(**{**base,**changes})
        observed=totals.model_copy(deep=True)
        if name=="stale":
            observed.scope.dataset_coverage="partial"
            observed.scope.sources[0].sync_health="stale"
        result=unavailable_comparison(body,NOW) if name=="unavailable" else compare_population(body,observed,public,catalog,policy,now=NOW,
            taxonomy="moneylens.synthetic.categories.v1",known_owned_scope_complete=True,material_bank_sources_complete=name!="stale")
        scenarios[name]=dict(request=body.model_dump(mode="json",exclude_none=True),result=result.model_dump(mode="json"))
    session=json.loads((ROOT/"fixtures/synthetic/planning-ui.v1.json").read_text(encoding="utf-8"))["session"]
    fixture=dict(clock=NOW.isoformat(),session=session,cohorts=dict(available=True,catalog=catalog.model_dump(mode="json"),reason=None),
        crosswalk=dict(available=True,policy=policy.view().model_dump(mode="json"),reason=None),
        accounts=[dict(id=account_id,name="Everyday synthetic account",currency="EUR",account_type="current",included=True,source=source)],scenarios=scenarios)
    (ROOT/"fixtures/synthetic/population-ui.v1.json").write_text(json.dumps(fixture,sort_keys=True,indent=2)+"\n",encoding="utf-8",newline="\n")
    print("Generated UI-only population fixture from the real engine; no network request made.")


if __name__=="__main__":
    main()
