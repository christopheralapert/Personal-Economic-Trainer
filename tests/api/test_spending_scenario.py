from datetime import datetime,timezone
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.identity import AuthError
from app.spending_scenario import SpendingReductionArgumentsV1,SpendingReductionV1,spending_reduction
from test_category_crosswalk import spending

NOW=datetime(2026,11,5,10,tzinfo=timezone.utc)


def request(**changes):
    return SpendingReductionArgumentsV1(**{**dict(start="2026-10-01",end_exclusive="2026-11-01",category="dining",
        change={"kind":"percentage","reduction_basis_points":2000}),**changes})


def baseline(gross=25000,refund=0):
    result=spending(("dining",gross,refund,"everyday"))
    result.scope.dataset_coverage="covered_synthetic_snapshot"
    result.evidence_filters.category="dining"
    result.evidence_filters.spending_only=True
    return result


def test_twenty_percent_counterfactual_reconciles_without_changing_baseline_or_inventing_future_savings():
    totals=baseline(30000,5000);before=totals.model_dump(mode="json")
    result=spending_reduction(request(),totals,now=NOW)
    assert result.status=="estimated" and result.result.amount_minor==5000 and result.counterfactual_net_minor==20000
    assert result.result_kind=="hypothetical_cost_reduction" and result.persisted is False
    assert result.baseline.model_dump(mode="json")==before==totals.model_dump(mode="json")
    assert any("not safe-to-save" in item for item in result.assumptions)
    result.baseline.scope.account_ids.clear()
    assert totals.scope.account_ids==[UUID(int=1)]


@pytest.mark.parametrize("net,bps,expected",[(1,5000,1),(1,4999,0),(3,5000,2),(100,0,0),(100,10000,100),(0,2000,0),(2**53-1,10000,2**53-1)])
def test_percentage_rounds_once_with_exact_safe_integer_arithmetic(net,bps,expected):
    result=spending_reduction(request(change={"kind":"percentage","reduction_basis_points":bps}),baseline(net),now=NOW)
    assert result.status=="estimated" and result.result.amount_minor==expected and result.counterfactual_net_minor==net-expected


@pytest.mark.parametrize("amount",[0,1500,25000])
def test_explicit_fixed_reduction_including_zero_is_unpersisted(amount):
    result=spending_reduction(request(change={"kind":"fixed_amount","reduction_minor":amount}),baseline(),now=NOW)
    assert result.result.amount_minor==amount and result.counterfactual_net_minor==25000-amount


@pytest.mark.parametrize("change",[
    {"kind":"percentage","reduction_basis_points":-1},{"kind":"percentage","reduction_basis_points":10001},
    {"kind":"percentage","reduction_basis_points":20.5},{"kind":"percentage","reduction_basis_points":True},
    {"kind":"percentage","reduction_basis_points":"2000"},{"kind":"fixed_amount","reduction_minor":-1},
    {"kind":"fixed_amount","reduction_minor":2**53},{"kind":"fixed_amount","reduction_minor":True},
    {"kind":"fixed_amount","reduction_minor":1,"confirmed":True},
    {"kind":"percentage","reduction_basis_points":2000,"reduction_minor":1000},
])
def test_change_is_closed_strict_and_bounded(change):
    with pytest.raises(ValidationError): request(change=change)


@pytest.mark.parametrize("condition,code",[
    ("unverified","SCENARIO_HISTORY_INCOMPLETE"),("partial","SCENARIO_HISTORY_INCOMPLETE"),
    ("empty_scope","SCENARIO_HISTORY_INCOMPLETE"),("flows","SCENARIO_CLASSIFICATION_UNRESOLVED"),
    ("basket","SCENARIO_CLASSIFICATION_UNRESOLVED"),("truncated","SCENARIO_CATEGORY_BREAKDOWN_INCOMPLETE"),
    ("refunds","SCENARIO_REFUND_DOMINATED"),("too_large","SCENARIO_REDUCTION_EXCEEDS_BASELINE"),
])
def test_incomplete_or_infeasible_counterfactual_withholds_derived_amounts(condition,code):
    totals=baseline();body=request()
    if condition in ("unverified","partial"): totals.scope.dataset_coverage=condition
    elif condition=="empty_scope": totals.scope.account_ids=[]
    elif condition=="flows": totals.unresolved_flow_count=1
    elif condition=="basket": totals.category_baskets[0].basket="unresolved"
    elif condition=="truncated": totals.category_breakdown_truncated=True
    elif condition=="refunds": totals=baseline(0,100)
    else: body=request(change={"kind":"fixed_amount","reduction_minor":25001})
    result=spending_reduction(body,totals,now=NOW)
    assert result.status=="blocked" and result.result.amount_minor is None and result.counterfactual_net_minor is None
    assert code in {block.code for block in result.blockers}


@pytest.mark.parametrize("changes",[{"category":"taxi"},{"merchant":"Other"},{"currency":"USD"},{"account_ids":[str(UUID(int=2))]},{"expected_data_version":2}])
def test_authorized_baseline_must_match_the_exact_request_scope(changes):
    with pytest.raises(AuthError) as error: spending_reduction(request(**changes),baseline(),now=NOW)
    assert error.value.code=="INVALID_SCENARIO_SCOPE"


def test_empty_category_and_incoherent_result_do_not_become_valid_scenarios():
    with pytest.raises(ValidationError): request(category=" ")
    result=spending_reduction(request(),baseline(),now=NOW).model_dump(mode="json")
    result["status"]="blocked"
    with pytest.raises(ValidationError): SpendingReductionV1.model_validate(result)
