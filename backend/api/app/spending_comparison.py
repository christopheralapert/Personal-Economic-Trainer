"""Two bounded, version-coherent observed windows; no extrapolated spending."""
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal

from pydantic import Field, StrictInt

from .contracts import Contract, Minor
from .identity import AuthError
from .ledger import Ledger, MINOR_LIMIT, SpendingTotalsV1, bounded_money

ComparisonMode = Literal["previous_period", "previous_month", "custom"]


class SpendingChangeV1(Contract):
    gross_minor: Minor
    refunds_minor: Minor
    net_minor: Minor
    net_change_basis_points: StrictInt | None
    percentage_unavailable_reason: Literal["baseline_not_positive", "outside_supported_range"] | None


class SpendingGroupChangeV1(Contract):
    label: str
    basket: str | None
    baseline_observed_minor: Minor
    current_observed_minor: Minor
    change_minor: Minor
    baseline_transaction_count: StrictInt
    current_transaction_count: StrictInt


class SpendingFrequencyV1(Contract):
    baseline_expense_count: StrictInt
    current_expense_count: StrictInt
    expense_count_change: StrictInt
    baseline_expenses_per_day: str
    current_expenses_per_day: str
    rate_decimal_places: Literal[6] = 6
    rate_rounding: Literal["half_up"] = "half_up"


class SpendingComparisonV1(Contract):
    mode: ComparisonMode
    status: Literal["covered_comparison", "limited_comparison"]
    current: SpendingTotalsV1
    baseline: SpendingTotalsV1
    current_calendar_days: StrictInt
    baseline_calendar_days: StrictInt
    equal_duration: bool
    overlapping_windows: bool
    change: SpendingChangeV1
    frequency: SpendingFrequencyV1
    category_baskets: list[SpendingGroupChangeV1] = Field(max_length=100)
    merchants: list[SpendingGroupChangeV1] = Field(max_length=20)
    category_comparison_incomplete: bool
    merchant_comparison_incomplete: bool
    limitations: list[str]


def load_spending_comparison(connection,user,filters,*,mode,baseline_start=None,baseline_end_exclusive=None,**options):
    """Read both windows within the caller's authorized repeatable-read fence."""
    start,end=comparison_window(filters.start,filters.end_exclusive,mode,baseline_start,baseline_end_exclusive)
    current=Ledger(connection,user,filters,**options).totals()
    previous=Ledger(connection,user,filters.model_copy(update={"start":start,"end_exclusive":end}),**options).totals()
    return compare_spending(current,previous,mode)


def comparison_window(start, end_exclusive, mode, baseline_start=None, baseline_end_exclusive=None):
    """Resolve civil booking dates, including leap years and year boundaries."""
    try:
        days = (end_exclusive-start).days
        if not 1 <= days <= 3660:
            raise ValueError()
        if mode == "custom":
            if baseline_start is None or baseline_end_exclusive is None or not 1 <= (baseline_end_exclusive-baseline_start).days <= 3660:
                raise ValueError()
            return baseline_start, baseline_end_exclusive
        if baseline_start is not None or baseline_end_exclusive is not None:
            raise ValueError()
        if mode == "previous_period":
            return start-timedelta(days=days), start
        if mode != "previous_month" or start.day != 1:
            raise ValueError()
        next_month = date(start.year+1,1,1) if start.month == 12 else date(start.year,start.month+1,1)
        if end_exclusive != next_month:
            raise ValueError()
        previous = date(start.year-1,12,1) if start.month == 1 else date(start.year,start.month-1,1)
        return previous,start
    except (ValueError,OverflowError):
        raise AuthError("INVALID_COMPARISON_PERIOD",422) from None


def percentage_change(current, baseline):
    if baseline <= 0:
        return None,"baseline_not_positive"
    # Integer half-up rounding avoids floats and context-dependent division.
    numerator = (current-baseline)*10000
    magnitude = (2*abs(numerator)+baseline)//(2*baseline)
    result = magnitude if numerator >= 0 else -magnitude
    return (result,None) if abs(result) <= MINOR_LIMIT else (None,"outside_supported_range")


def group_changes(current, baseline, *, kind, cap):
    # An omitted top-N group is unknown, never an observed zero.
    if getattr(current,f"{kind}_breakdown_truncated") or getattr(baseline,f"{kind}_breakdown_truncated"):
        return [],True
    field = "category_baskets" if kind == "category" else "merchants"
    key = lambda item: (item.label,item.basket)
    current_groups = {key(item):item for item in getattr(current,field)}
    baseline_groups = {key(item):item for item in getattr(baseline,field)}
    changes = []
    for label,basket in current_groups.keys() | baseline_groups.keys():
        after,before = current_groups.get((label,basket)),baseline_groups.get((label,basket))
        after_minor,before_minor = (after.net_minor if after else 0),(before.net_minor if before else 0)
        changes.append(SpendingGroupChangeV1(label=label,basket=basket,baseline_observed_minor=before_minor,
            current_observed_minor=after_minor,change_minor=bounded_money(after_minor-before_minor),
            baseline_transaction_count=before.transaction_count if before else 0,current_transaction_count=after.transaction_count if after else 0))
    changes.sort(key=lambda item: (-abs(item.change_minor),item.label,item.basket or ""))
    return changes[:cap],len(changes)>cap


def compare_spending(current, baseline, mode):
    # Both inputs must come from one authorized repeatable-read transaction.
    first,second = current.scope,baseline.scope
    if (first.account_ids,first.currency,first.permission_version,first.data_version,first.plan_version) != (
        second.account_ids,second.currency,second.permission_version,second.data_version,second.plan_version):
        raise AuthError("DATA_CHANGED_RETRY",409)
    current_days,baseline_days = (first.end_exclusive-first.start).days,(second.end_exclusive-second.start).days
    overlapping = max(first.start,second.start) < min(first.end_exclusive,second.end_exclusive)
    equal = current_days == baseline_days
    complete = first.dataset_coverage == second.dataset_coverage == "covered_synthetic_snapshot"
    clean = current.unresolved_flow_count == baseline.unresolved_flow_count == 0
    comparable = complete and clean and not overlapping and (equal or mode == "previous_month")
    percent,reason = percentage_change(current.net_minor,baseline.net_minor)
    categories,category_incomplete = group_changes(current,baseline,kind="category",cap=100)
    merchants,merchant_incomplete = group_changes(current,baseline,kind="merchant",cap=20)
    rate = lambda count,days: str((Decimal(count)/Decimal(days)).quantize(Decimal("0.000001"),rounding=ROUND_HALF_UP))
    limitations = [
        "Changes describe observed booked records in the two named half-open Helsinki booking-date windows; they are not a forecast or a spending allowance.",
        "The same owned accounts, currency, filters and dataset version apply to both windows. Whole-finance and household coverage are not established.",
        "Refunds belong to their booking periods; valid expense counts exclude refunds, transfers, income and liability settlements.",
        "Percentage change uses net observed spending and half-up rounding to basis points (100 basis points = 1%). A nonpositive baseline has no percentage.",
    ]
    if not complete:
        limitations.append("At least one window has partial or unverified source history. Observed differences and zero rows do not establish a change in actual spending.")
    if not clean:
        limitations.append("Unresolved economic flows exist. Their counts remain visible and are not silently included as confirmed spending.")
    if not equal:
        limitations.append("The windows have different numbers of civil days. Raw totals and counts are not duration-adjusted; the separately labeled per-day expense frequencies use each actual duration.")
    if overlapping:
        limitations.append("The windows overlap and share records; they are not independent before-and-after periods.")
    if category_incomplete or merchant_incomplete:
        limitations.append("Group comparisons are incomplete. A truncated input group list is not differenced; otherwise only the largest bounded changes are returned. Full period totals and evidence remain available.")
    return SpendingComparisonV1(mode=mode,status="covered_comparison" if comparable else "limited_comparison",
        current=current,baseline=baseline,current_calendar_days=current_days,baseline_calendar_days=baseline_days,
        equal_duration=equal,overlapping_windows=overlapping,
        change=SpendingChangeV1(gross_minor=bounded_money(current.gross_minor-baseline.gross_minor),
            refunds_minor=bounded_money(current.refunds_minor-baseline.refunds_minor),net_minor=bounded_money(current.net_minor-baseline.net_minor),
            net_change_basis_points=percent,percentage_unavailable_reason=reason),
        frequency=SpendingFrequencyV1(baseline_expense_count=baseline.expense_count,current_expense_count=current.expense_count,
            expense_count_change=current.expense_count-baseline.expense_count,baseline_expenses_per_day=rate(baseline.expense_count,baseline_days),
            current_expenses_per_day=rate(current.expense_count,current_days)),category_baskets=categories,merchants=merchants,
        category_comparison_incomplete=category_incomplete,merchant_comparison_incomplete=merchant_incomplete,limitations=limitations)
