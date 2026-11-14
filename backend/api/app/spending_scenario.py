"""Historical cost-reduction counterfactual; no forecast or saving allowance."""
from typing import Annotated,Literal

from pydantic import AwareDatetime,Field,StrictInt,model_validator

from .analysis_inputs import AnalysisWindowV1
from .contracts import Blocker,Contract,FinancialResult,NonnegativeMinor
from .identity import AuthError
from .ledger import SpendingTotalsV1,bounded_money


class PercentageReductionV1(Contract):
    kind: Literal["percentage"]
    reduction_basis_points: Annotated[StrictInt,Field(ge=0,le=10000)]


class FixedReductionV1(Contract):
    kind: Literal["fixed_amount"]
    reduction_minor: NonnegativeMinor


ReductionChangeV1=PercentageReductionV1|FixedReductionV1


class SpendingReductionArgumentsV1(AnalysisWindowV1):
    category: str = Field(min_length=1,max_length=100)
    change: ReductionChangeV1

    @model_validator(mode="after")
    def named_category(self):
        if not self.category.strip():
            raise ValueError("Choose an explicit source category")
        return self


class SpendingReductionV1(Contract):
    transform_version: Literal["spending-reduction.v1"] = "spending-reduction.v1"
    status: Literal["estimated","blocked"]
    result_kind: Literal["hypothetical_cost_reduction"] = "hypothetical_cost_reduction"
    as_of: AwareDatetime
    baseline: SpendingTotalsV1
    change: ReductionChangeV1
    result: FinancialResult
    counterfactual_net_minor: NonnegativeMinor | None
    blockers: list[Blocker]
    assumptions: list[str]
    persisted: Literal[False] = False

    @model_validator(mode="after")
    def coherent_result(self):
        if self.status=="blocked":
            if self.result.amount_minor is not None or self.counterfactual_net_minor is not None or not self.blockers:
                raise ValueError("Blocked scenarios require reasons and null derived amounts")
        elif self.result.amount_minor is None or self.counterfactual_net_minor is None or self.blockers or (
            self.result.amount_minor+self.counterfactual_net_minor!=self.baseline.net_minor):
            raise ValueError("Estimated scenarios must reconcile to the observed net baseline")
        return self


def spending_reduction(body,totals,*,now):
    scope,filters=totals.scope,totals.evidence_filters
    if (scope.start,scope.end_exclusive,scope.currency,filters.category,filters.merchant,filters.status,filters.spending_only)!=(
        body.start,body.end_exclusive,body.currency,body.category,body.merchant,"booked",True) or (
        body.account_ids is not None and set(body.account_ids)!=set(scope.account_ids)):
        raise AuthError("INVALID_SCENARIO_SCOPE",422)
    if (filters.start,filters.end_exclusive,filters.currency)!=(body.start,body.end_exclusive,body.currency) or (
        body.expected_data_version is not None and body.expected_data_version!=scope.data_version):
        raise AuthError("INVALID_SCENARIO_SCOPE",422)
    blockers=[]
    def block(code,message,action): blockers.append(Blocker(code=code,message=message,action=action))
    if scope.dataset_coverage!="covered_synthetic_snapshot" or not scope.account_ids:
        block("SCENARIO_HISTORY_INCOMPLETE","Published account history does not cover this entire observed period.","publish_complete_history_or_choose_covered_window")
    if totals.unresolved_flow_count or any(group.basket=="unresolved" for group in totals.category_baskets):
        block("SCENARIO_CLASSIFICATION_UNRESOLVED","Some relevant transactions have an unresolved economic purpose or basket.","review_relevant_transaction_classification")
    if totals.category_breakdown_truncated:
        block("SCENARIO_CATEGORY_BREAKDOWN_INCOMPLETE","The selected category breakdown is incomplete.","review_complete_category_evidence")
    if totals.net_minor<0:
        block("SCENARIO_REFUND_DOMINATED","Refunds exceed purchases in this booking period.","review_refund_dates_and_period")
    delta=None
    if body.change.kind=="fixed_amount":
        if body.change.reduction_minor>max(0,totals.net_minor):
            block("SCENARIO_REDUCTION_EXCEEDS_BASELINE","The chosen reduction exceeds this period's observed net category spending.","reduce_the_requested_amount_or_change_observed_window")
        elif not blockers: delta=body.change.reduction_minor
    elif not blockers:
        # Nonnegative integer half-up rounding, applied once to the window's net.
        delta=bounded_money((totals.net_minor*body.change.reduction_basis_points+5000)//10000)
    return SpendingReductionV1(status="blocked" if blockers else "estimated",as_of=now,baseline=totals.model_copy(deep=True),
        change=body.change.model_copy(deep=True),result=FinancialResult(currency=body.currency,amount_minor=delta),
        counterfactual_net_minor=None if delta is None else bounded_money(totals.net_minor-delta),blockers=blockers,assumptions=[
            "This counterfactual changes only the named observed category/account/merchant/date scope; it does not modify recorded transactions.",
            "The baseline is booked expenses minus refunds in their booking period. Pending records, income, transfers and liability settlements are excluded.",
            "Percentage reduction applies once to net spending; 2000 basis points means 20%. Integer minor units round half-up once, not per purchase.",
            "The counterfactual assumes the specified reduction was possible in this historical period. It does not extrapolate a monthly or annual future baseline.",
            "A hypothetical cost reduction is not safe-to-save capacity, a spending allowance, a confirmed saving or a bank transfer. Other household expenses and future income are not inferred.",
        ])
