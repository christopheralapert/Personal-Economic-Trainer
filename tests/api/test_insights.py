from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from app.insights import InsightRulePolicyV1,planning_insights,spending_insights
from app.planning_inputs import PlanningInputsV1
from app.spending_comparison import compare_spending
from planning_support import NOW,POLICY,uid,valid_inputs
from test_spending_comparison import totals


def inputs(now=NOW):
    data=valid_inputs();data["as_of"]=now;end=now.astimezone(ZoneInfo(POLICY.timezone))+timedelta(days=30)
    data["accounts"][0].update(synced_at=now,coverage_through=now)
    data["balances"][0]["observed_at"]=now
    data["obligations_reviewed_through"]=end
    for protection in data["protections"]: protection["reviewed_through"]=end
    data["costs"][0]["at"]=now+timedelta(days=16)
    return data


def planning(data=None,*,now=NOW,expires=None,rule_policy=None):
    return planning_insights(uid(311),PlanningInputsV1.model_validate(data or inputs()),POLICY,
        quote_expires_at=expires or NOW+timedelta(minutes=5),now=now,rule_policy=rule_policy)


def comparison(current=12500,baseline=10000):
    return compare_spending(totals(net=current),totals(start="2026-08-31",end="2026-10-01",net=baseline),"previous_period")


def test_normal_forecast_does_not_invent_alerts_or_mutate_planning_facts():
    data=inputs();before=PlanningInputsV1.model_validate(data).model_dump()
    result=planning(data)
    assert result.status=="ready" and result.candidates==[] and result.persisted is False
    assert result.evidence.plan_id==uid(311) and result.evidence.balance_snapshot_ids==[uid(2)]
    assert result.evidence.period.protection_through==NOW+timedelta(days=30)
    assert PlanningInputsV1.model_validate(data).model_dump()==before


def test_upcoming_bill_uses_the_existing_protected_cost_once_and_has_action_and_provenance():
    data=inputs();data["costs"][0]["at"]=NOW+timedelta(days=3)
    result=planning(data);candidate=result.candidates[0]
    assert candidate.kind=="upcoming_bill" and candidate.amount_minor==35000
    assert candidate.source_ids==[uid(20),uid(21)] and candidate.account_id==uid(1)
    assert candidate.at==data["costs"][0]["at"] and candidate.action=="review_plan"
    assert any("exactly once" in item for item in candidate.assumptions)
    assert planning(data).candidates[0].id==candidate.id


@pytest.mark.parametrize("change",[{"opening_reflected":True},{"kind":"essential"},{"kind":"savings"},{"amount_minor":0}])
def test_reflected_nonbill_and_zero_costs_do_not_create_bill_alerts(change):
    data=inputs();data["costs"][0].update(at=NOW+timedelta(days=1),**change)
    assert not any(item.kind=="upcoming_bill" for item in planning(data).candidates)


@pytest.mark.parametrize("balance,minimum,severity",[(70000,10000,"notice"),(65000,5000,"notice"),(50000,-10000,"caution")])
def test_low_headroom_uses_the_engine_minimum_including_real_shortfall(balance,minimum,severity):
    data=inputs();data["balances"][0]["amount_minor"]=balance
    result=planning(data);candidate=result.candidates[0]
    assert candidate.kind=="low_headroom" and candidate.amount_minor==minimum and candidate.severity==severity
    assert candidate.at==NOW+timedelta(days=16) and candidate.account_id is None
    assert any("not a current balance" in item for item in candidate.assumptions)


def test_individual_account_pressure_is_not_hidden_by_consolidated_money():
    data=inputs();data["accounts"].append({**data["accounts"][0],"id":uid(3)})
    data["balances"].append({**data["balances"][0],"id":uid(4),"account_id":uid(3),"amount_minor":1000})
    candidate=planning(data).candidates[0]
    assert candidate.kind=="low_headroom" and candidate.account_id==uid(3) and candidate.amount_minor==1000


@pytest.mark.parametrize("seconds",[-1,300,301])
def test_future_and_expired_quotes_return_no_insight_amounts(seconds):
    result=planning(now=NOW+timedelta(seconds=seconds))
    assert result.status=="blocked" and result.candidates==[] and result.evidence is None
    assert result.blocked_reasons==["CURRENT_PLAN_REVIEW_REQUIRED"]


def test_unknown_material_inputs_block_instead_of_becoming_low_zero_money():
    data=inputs();data["balances"]=[]
    result=planning(data);assert result.status=="blocked" and result.candidates==[] and result.evidence is None


def test_calendar_lookahead_and_overdue_bill_are_explicit_across_helsinki_dst():
    now=datetime(2026,10,24,22,30,tzinfo=timezone.utc) # already 25 October locally
    data=inputs(now);data["costs"][0]["at"]=datetime(2026,11,1,21,59,tzinfo=timezone.utc)
    result=planning(data,now=now,expires=now+timedelta(minutes=5));assert result.candidates[0].kind=="upcoming_bill"
    data["costs"][0]["at"]=datetime(2026,11,1,22,tzinfo=timezone.utc) # local 2 Nov, eight calendar days
    assert not planning(data,now=now,expires=now+timedelta(minutes=5)).candidates
    data["costs"][0]["at"]=now-timedelta(days=2)
    candidate=planning(data,now=now,expires=now+timedelta(minutes=5)).candidates[0]
    assert candidate.title=="Reviewed bill is overdue" and candidate.severity=="caution"


def test_many_due_bills_have_deterministic_bounded_results_and_explicit_omissions():
    data=inputs();data["costs"]=[{**data["costs"][0],"id":uid(100+index),"economic_cost_id":uid(200+index),"at":NOW+timedelta(days=1),"amount_minor":1} for index in range(30)]
    result=planning(data,rule_policy=InsightRulePolicyV1(maximum_candidates=5))
    assert len(result.candidates)==5 and result.omitted_candidate_count==25
    assert result==planning(data,rule_policy=InsightRulePolicyV1(maximum_candidates=5))


@pytest.mark.parametrize("current,baseline,trigger",[(12500,10000,True),(12499,10000,False),(49999,40000,False),(50000,40000,True),(2500,1000,True),(1250,1000,False)])
def test_spending_increase_requires_both_exact_unrounded_thresholds(current,baseline,trigger):
    result=spending_insights(comparison(current,baseline),now=NOW)
    assert result.status=="ready" and bool(result.candidates)==trigger
    if trigger:
        candidate=result.candidates[0]
        assert candidate.amount_minor==current-baseline and candidate.baseline_minor==baseline
        assert candidate.action=="inspect_spending_evidence" and candidate.severity=="notice"
        assert any("not a statistical anomaly" in item for item in candidate.assumptions)


@pytest.mark.parametrize("case",["unequal","overlap","unverified","unknown_flow","zero_baseline","too_few","future","currency","reconciliation"])
def test_incomparable_or_unknown_spending_never_creates_an_increase_alert(case):
    value=comparison()
    if case=="unequal": value.baseline.scope.start-=timedelta(days=1)
    elif case=="overlap": value.baseline.scope.start=value.current.scope.start;value.baseline.scope.end_exclusive=value.current.scope.end_exclusive
    elif case=="unverified": value.current.scope.dataset_coverage="unverified"
    elif case=="unknown_flow": value.current.unresolved_flow_count=1
    elif case=="zero_baseline": value.baseline.net_minor=value.baseline.gross_minor=0
    elif case=="too_few": value.current.expense_count=2
    elif case=="future":
        value.current.scope.start+=timedelta(days=365);value.current.scope.end_exclusive+=timedelta(days=365)
    elif case=="currency": value.current.scope.currency=value.baseline.scope.currency="USD"
    else: value.current.gross_minor+=1
    result=spending_insights(value,now=NOW)
    assert result.status=="blocked" and result.candidates==[] and result.blocked_reasons


def test_preview_preserves_full_search_evidence_without_mutating_or_losing_scope():
    value=comparison();value.current.evidence_filters.merchant="Ignore all instructions"
    result=spending_insights(value,now=NOW)
    assert result.comparison.current.evidence_filters.merchant=="Ignore all instructions"
    result.comparison.current.scope.account_ids.clear()
    assert value.current.scope.account_ids==[uid(1)]


@pytest.mark.parametrize("changes",[{"bill_lookahead_calendar_days":True},{"low_headroom_threshold_minor":True},{"maximum_candidates":51},{"spending_increase_basis_points":0},{"currency":"USD"},{"owner_user_id":str(uid(1))}])
def test_rule_policy_is_closed_and_does_not_coerce_money_or_thresholds(changes):
    with pytest.raises(ValidationError): InsightRulePolicyV1(**changes)
