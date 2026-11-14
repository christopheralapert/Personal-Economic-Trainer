from datetime import date
from uuid import UUID

import pytest

from app.identity import AuthError
from app.ledger import LedgerScopeV1,SpendingGroupV1,SpendingTotalsV1
from app.spending_comparison import compare_spending,comparison_window,percentage_change


@pytest.mark.parametrize("start,end,mode,expected",[
    ("2026-11-01","2026-12-01","previous_month",("2026-10-01","2026-11-01")),
    ("2026-01-01","2026-02-01","previous_month",("2025-12-01","2026-01-01")),
    ("2024-03-01","2024-04-01","previous_month",("2024-02-01","2024-03-01")),
    ("2026-03-01","2026-04-01","previous_month",("2026-02-01","2026-03-01")),
    ("2026-03-29","2026-03-31","previous_period",("2026-03-27","2026-03-29")),
    ("2026-10-25","2026-10-27","previous_period",("2026-10-23","2026-10-25")),
])
def test_calendar_and_matched_windows_preserve_civil_days(start,end,mode,expected):
    result=comparison_window(date.fromisoformat(start),date.fromisoformat(end),mode)
    assert tuple(value.isoformat() for value in result)==expected


@pytest.mark.parametrize("start,end,mode,baseline",[
    (date(2026,10,2),date(2026,11,1),"previous_month",()),
    (date(2026,10,1),date(2026,10,30),"previous_month",()),
    (date(2026,10,1),date(2026,11,1),"custom",()),
    (date(2026,10,1),date(2026,11,1),"custom",(date(2026,9,1),None)),
    (date(2026,10,1),date(2026,11,1),"previous_period",(date(2026,9,1),date(2026,10,1))),
    (date(1,1,1),date(1,1,2),"previous_period",()),
    (date(9999,12,1),date(9999,12,31),"previous_month",()),
    (date(2026,10,1),date(2026,10,1),"previous_period",()),
    (date(2000,1,1),date(2026,10,1),"previous_period",()),
])
def test_invalid_and_overflow_windows_are_safe(start,end,mode,baseline):
    with pytest.raises(AuthError,match="INVALID_COMPARISON_PERIOD"):
        comparison_window(start,end,mode,*baseline)


@pytest.mark.parametrize("current,baseline,result",[
    (150,100,(5000,None)),(50,100,(-5000,None)),(20001,20000,(1,None)),(19999,20000,(-1,None)),
    (0,0,(None,"baseline_not_positive")),(0,-100,(None,"baseline_not_positive")),
    (2**53-1,1,(None,"outside_supported_range")),
])
def test_percentages_use_exact_symmetric_half_up_basis_points(current,baseline,result):
    assert percentage_change(current,baseline)==result


def totals(*,start="2026-10-01",end="2026-11-01",net=100,coverage="covered_synthetic_snapshot",unresolved=0,**changes):
    scope=LedgerScopeV1(account_ids=[UUID(int=1)],currency="EUR",start=date.fromisoformat(start),end_exclusive=date.fromisoformat(end),
        data_version=1,permission_version=1,plan_version=1,dataset_coverage=coverage)
    return SpendingTotalsV1(scope=scope,gross_minor=max(net,0),refunds_minor=max(-net,0),net_minor=net,
        expense_count=3,refund_count=0,unresolved_flow_count=unresolved,nonconsumption_count=0,category_baskets=[],merchants=[],
        category_breakdown_truncated=False,merchant_breakdown_truncated=False,
        evidence_filters=dict(start=start,end_exclusive=end),evidence_transaction_ids=[],limitations=[],**changes)


def test_unequal_calendar_months_disclose_duration_and_rates():
    current=totals(net=150)
    baseline=totals(start="2026-09-01",end="2026-10-01")
    result=compare_spending(current,baseline,"previous_month")
    assert result.status=="covered_comparison" and not result.equal_duration
    assert result.change.net_minor==50 and result.change.net_change_basis_points==5000
    assert result.frequency.current_expenses_per_day=="0.096774"
    assert result.frequency.baseline_expenses_per_day=="0.100000"
    assert any("different numbers of civil days" in line for line in result.limitations)


@pytest.mark.parametrize("changes",[{"coverage":"partial"},{"coverage":"unverified"},{"unresolved":1}])
def test_incomplete_source_or_flow_never_becomes_unqualified_change(changes):
    current=totals(net=0,**changes)
    result=compare_spending(current,totals(start="2026-08-31",end="2026-10-01"),"previous_period")
    assert result.status=="limited_comparison" and result.change.net_minor==-100


def test_overlap_and_custom_unequal_windows_are_labeled():
    result=compare_spending(totals(),totals(start="2026-10-15",end="2026-10-25"),"custom")
    assert result.status=="limited_comparison" and result.overlapping_windows and not result.equal_duration
    assert any("overlap" in line for line in result.limitations)


def test_truncated_groups_are_unknown_instead_of_zero_in_differences():
    current=totals()
    current.merchant_breakdown_truncated=True
    current.merchants=[SpendingGroupV1(label="Taxi",gross_minor=100,refunds_minor=0,net_minor=100,transaction_count=1)]
    result=compare_spending(current,totals(start="2026-08-31",end="2026-10-01"),"previous_period")
    assert result.merchants==[] and result.merchant_comparison_incomplete


def test_group_keys_keep_baskets_separate_and_union_changes_bounded():
    current=totals()
    current.category_baskets=[SpendingGroupV1(label="food",basket=basket,gross_minor=100,refunds_minor=0,net_minor=100,transaction_count=1)
        for basket in ("everyday","mandatory_regular")]
    current.merchants=[SpendingGroupV1(label=str(index),gross_minor=index,refunds_minor=0,net_minor=index,transaction_count=1) for index in range(20)]
    baseline=totals(start="2026-08-31",end="2026-10-01")
    baseline.merchants=[SpendingGroupV1(label="previous",gross_minor=50,refunds_minor=0,net_minor=50,transaction_count=1)]
    result=compare_spending(current,baseline,"previous_period")
    assert len(result.category_baskets)==2 and {item.basket for item in result.category_baskets}=={"everyday","mandatory_regular"}
    assert len(result.merchants)==20 and result.merchant_comparison_incomplete
    assert result.merchants[0].change_minor==-50


def test_changed_version_and_overflow_differences_fail_explicitly():
    current,baseline=totals(net=2**53-1),totals(start="2026-08-31",end="2026-10-01",net=-(2**53-1))
    with pytest.raises(AuthError,match="AMOUNT_RANGE_EXCEEDED"):
        compare_spending(current,baseline,"previous_period")
    baseline.scope.data_version=2
    with pytest.raises(AuthError,match="DATA_CHANGED_RETRY"):
        compare_spending(current,baseline,"previous_period")
