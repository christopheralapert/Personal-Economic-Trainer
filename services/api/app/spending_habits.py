"""Descriptive spending patterns over an immutable authorized observation window."""
from typing import Annotated,Literal

from pydantic import AwareDatetime,Field,StrictInt

from .analysis_inputs import AnalysisWindowV1
from .contracts import Contract,Minor,NonnegativeMinor
from .identity import AuthError
from .ledger import SpendingTotalsV1,bounded_money


class SpendingHabitsArgumentsV1(AnalysisWindowV1):
    pass


class HabitAmountV1(Contract):
    label: str = Field(max_length=100)
    gross_minor: NonnegativeMinor
    refunds_minor: NonnegativeMinor
    net_minor: Minor
    booked_entry_count: Annotated[StrictInt,Field(ge=0,le=2**53-1)]
    gross_share_basis_points: Annotated[StrictInt,Field(ge=0,le=10000)] | None


class CategoryHabitV1(HabitAmountV1):
    interpretation: Literal["leading_observed_category"] = "leading_observed_category"
    practical_choice: Literal["inspect_purchases_and_choose_what_to_keep_or_change"] = "inspect_purchases_and_choose_what_to_keep_or_change"
    explanation_topic: Literal["opportunity_cost"] = "opportunity_cost"


class SpendingHabitsV1(Contract):
    transform_version: Literal["spending-habits.v1"] = "spending-habits.v1"
    result_kind: Literal["observed_spending_patterns"] = "observed_spending_patterns"
    as_of: AwareDatetime
    status: Literal["observed","limited","no_observations"]
    baseline: SpendingTotalsV1
    category_patterns: list[CategoryHabitV1] = Field(max_length=3)
    basket_breakdown: list[HabitAmountV1] = Field(max_length=100)
    reasons: list[str] = Field(max_length=12)
    limitations: list[str] = Field(max_length=12)
    persisted: Literal[False] = False


def spending_habits(body,totals,*,now):
    # Validate and copy even internal typed objects: callers must not be able to
    # mutate cached evidence through the returned descriptive result.
    body=SpendingHabitsArgumentsV1.model_validate(body.model_dump(mode="python"),strict=True)
    totals=SpendingTotalsV1.model_validate(totals.model_dump(mode="python"),strict=True)
    scope,filters=totals.scope,totals.evidence_filters
    if (scope.start,scope.end_exclusive,scope.currency,filters.start,filters.end_exclusive,filters.currency,
        filters.category,filters.merchant,filters.status,filters.spending_only)!=(
        body.start,body.end_exclusive,body.currency,body.start,body.end_exclusive,body.currency,
        body.category,body.merchant,"booked",True) or (
        body.account_ids is not None and set(body.account_ids)!=set(scope.account_ids)) or (
        body.expected_data_version is not None and body.expected_data_version!=scope.data_version):
        raise AuthError("INVALID_HABIT_SCOPE",422)
    groups=totals.category_baskets
    if totals.gross_minor-totals.refunds_minor!=totals.net_minor or any(
        group.gross_minor-group.refunds_minor!=group.net_minor or group.transaction_count<0 for group in groups) or any(
        count<0 for count in (totals.expense_count,totals.refund_count,totals.unresolved_flow_count,totals.nonconsumption_count)):
        raise AuthError("HABIT_EVIDENCE_INVALID",409)
    if not totals.category_breakdown_truncated and (
        sum(group.gross_minor for group in groups)!=totals.gross_minor or
        sum(group.refunds_minor for group in groups)!=totals.refunds_minor or
        sum(group.transaction_count for group in groups)!=totals.expense_count+totals.refund_count):
        raise AuthError("HABIT_EVIDENCE_INVALID",409)
    reasons=[]
    if scope.dataset_coverage!="covered_synthetic_snapshot" or not scope.account_ids:
        reasons.append("INCOMPLETE_OBSERVED_HISTORY")
    if totals.unresolved_flow_count: reasons.append("UNRESOLVED_ECONOMIC_FLOWS")
    if totals.category_breakdown_truncated: reasons.append("CATEGORY_BREAKDOWN_TRUNCATED")
    if any(group.basket not in ("mandatory_regular","mandatory_irregular","everyday") for group in groups):
        reasons.append("UNREVIEWED_BASKET_CLASSIFICATION")
    if body.category is not None or body.merchant is not None: reasons.append("FILTERED_OBSERVATIONS")
    if totals.refunds_minor>totals.gross_minor: reasons.append("REFUND_DOMINATED_PERIOD")
    if not totals.gross_minor: reasons.append("NO_OBSERVED_PURCHASE_AMOUNT")
    categories,baskets={},{}
    if not totals.category_breakdown_truncated:
        for group in groups:
            for target,key in ((categories,group.label),(baskets,group.basket or "unresolved")):
                value=target.setdefault(key,[0,0,0])
                value[0]+=group.gross_minor;value[1]+=group.refunds_minor;value[2]+=group.transaction_count
    def amount(label,values):
        gross,refunds,count=values
        # Integer half-up ratio of gross purchases. Refunds retain their own
        # amount and booking window; negative category net never creates a
        # negative, over-100% or invented net-spending share.
        share=(2*gross*10000+totals.gross_minor)//(2*totals.gross_minor) if totals.gross_minor else None
        return dict(label=label,gross_minor=bounded_money(gross),refunds_minor=bounded_money(refunds),
            net_minor=bounded_money(gross-refunds),booked_entry_count=count,gross_share_basis_points=share)
    leading=sorted(categories.items(),key=lambda item:(-item[1][0],item[0]))
    status="no_observations" if not (totals.expense_count or totals.refund_count) else "limited" if reasons else "observed"
    return SpendingHabitsV1(as_of=now,status=status,baseline=totals,
        category_patterns=[CategoryHabitV1(**amount(label,values)) for label,values in leading[:3] if values[0]>0],
        basket_breakdown=[HabitAmountV1(**amount(label,values)) for label,values in sorted(baskets.items())],
        reasons=reasons,limitations=[
            "These are descriptions of the named accounts, filters and booking period, not personality traits, diagnoses or a spending score.",
            "Leading categories are ranked by gross booked purchase amount, with alphabetical tie-breaking; refunds and net amounts stay separate.",
            "Shares use gross booked purchase amounts and integer half-up basis points. Separately rounded shares may not sum to exactly 100 percent.",
            "Entry counts include booked expenses and refunds, not visits, purchase frequency or proof that a habit will continue.",
            "Incomplete history and unresolved flows limit these observations; no matches do not prove no spending.",
            "Baskets retain source classifications. Recurrence and a category name do not establish that a purchase is essential.",
            "Evidence IDs are a bounded sample; the explicit versioned filters identify the full observation scope.",
            "Choosing what to keep or change is personal. These patterns do not calculate a future saving promise or safe-to-spend allowance."])
