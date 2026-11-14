"""Explainable, unpersisted coaching rules over authorized engine facts."""
from datetime import timedelta
from typing import Annotated,Literal
from uuid import UUID,uuid5
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime,Field,StrictInt

from .contracts import Contract,Currency,Minor,NonnegativeMinor
from .planning_engine import calculate_planning
from .planning_inputs import PlanningInputsV1
from .planning_policy import PlanningPolicyV1,ProtectionPeriodV1,utc
from .spending_comparison import SpendingComparisonV1,compare_spending

NAMESPACE=UUID("de088b01-507b-490b-b1ab-89f1e5d31f00")


class InsightRulePolicyV1(Contract):
    version: Literal["insight-rules.v1"] = "insight-rules.v1"
    currency: Literal["EUR"] = "EUR"
    bill_lookahead_calendar_days: Annotated[StrictInt,Field(ge=1,le=30)] = 7
    low_headroom_threshold_minor: NonnegativeMinor = 10000
    spending_increase_basis_points: Annotated[StrictInt,Field(ge=1,le=100000)] = 2500
    spending_minimum_increase_minor: Annotated[NonnegativeMinor,Field(gt=0)] = 1000
    spending_minimum_baseline_minor: Annotated[NonnegativeMinor,Field(gt=0)] = 1000
    spending_minimum_expense_count: Annotated[StrictInt,Field(ge=1,le=1000)] = 3
    maximum_candidates: Annotated[StrictInt,Field(ge=1,le=50)] = 20


class InsightCandidateV1(Contract):
    id: UUID
    kind: Literal["upcoming_bill","low_headroom","higher_observed_spending"]
    severity: Literal["notice","caution"]
    title: str
    reason: str
    amount_minor: Minor
    baseline_minor: NonnegativeMinor | None = None
    currency: Currency
    at: AwareDatetime | None
    account_id: UUID | None
    source_ids: list[UUID] = Field(max_length=50)
    action: Literal["review_plan","inspect_spending_evidence"]
    assumptions: list[str] = Field(max_length=10)


class PlanningInsightEvidenceV1(Contract):
    plan_id: UUID
    data_version: Annotated[StrictInt,Field(ge=1,le=2**53-1)]
    plan_version: Annotated[StrictInt,Field(ge=1,le=2**53-1)]
    source: Literal["synthetic_user_confirmed","verified"]
    input_as_of: AwareDatetime
    quote_expires_at: AwareDatetime
    period: ProtectionPeriodV1
    balance_snapshot_ids: list[UUID] = Field(max_length=50)
    account_ids: list[UUID] = Field(max_length=50)
    planning_blocker_codes: list[str] = Field(max_length=100)


class PlanningInsightPreviewV1(Contract):
    status: Literal["ready","blocked"]
    as_of: AwareDatetime
    policy: InsightRulePolicyV1
    candidates: list[InsightCandidateV1] = Field(max_length=50)
    omitted_candidate_count: Annotated[StrictInt,Field(ge=0)]
    evidence: PlanningInsightEvidenceV1 | None
    blocked_reasons: list[str] = Field(max_length=100)
    persisted: Literal[False] = False


class SpendingInsightPreviewV1(Contract):
    status: Literal["ready","blocked"]
    as_of: AwareDatetime
    policy: InsightRulePolicyV1
    candidates: list[InsightCandidateV1] = Field(max_length=1)
    comparison: SpendingComparisonV1
    blocked_reasons: list[str] = Field(max_length=20)
    persisted: Literal[False] = False


def planning_unavailable(now,reason,policy=None):
    return PlanningInsightPreviewV1(status="blocked",as_of=utc(now),policy=policy or InsightRulePolicyV1(),candidates=[],
        omitted_candidate_count=0,evidence=None,blocked_reasons=[reason])


def planning_insights(plan_id,inputs,planning_policy,*,quote_expires_at,now,rule_policy=None):
    # These inputs are loaded/revalidated under the caller's owned source fence,
    # never accepted as financial authority in a browser/model command.
    inputs=PlanningInputsV1.model_validate(inputs.model_dump(mode="python"),strict=True)
    planning_policy=PlanningPolicyV1.model_validate(planning_policy.model_dump(mode="python"),strict=True)
    policy=InsightRulePolicyV1.model_validate((rule_policy or InsightRulePolicyV1()).model_dump(mode="python"),strict=True)
    now=utc(now);expires=utc(quote_expires_at)
    if not utc(inputs.as_of)<=now<expires or now-utc(inputs.as_of)>timedelta(minutes=5):
        return planning_unavailable(now,"CURRENT_PLAN_REVIEW_REQUIRED",policy)
    outcome=calculate_planning(inputs,planning_policy)
    if outcome.prepared.status!="ready" or outcome.baseline is None:
        return planning_unavailable(now,"PLANNING_INPUTS_BLOCKED",policy)
    evidence=PlanningInsightEvidenceV1(plan_id=plan_id,data_version=inputs.data_version,plan_version=inputs.plan_version,
        source=inputs.source,input_as_of=inputs.as_of,quote_expires_at=expires,period=outcome.prepared.period,
        balance_snapshot_ids=[item.id for item in inputs.balances],account_ids=[item.account_id for item in outcome.baseline.accounts],
        planning_blocker_codes=sorted({item.code for item in outcome.blockers})[:100])
    candidates=[]
    # Account minima preserve a funding problem which consolidated cash can hide.
    minima=[(None,outcome.baseline.consolidated)]+[(item.account_id,item.forecast) for item in outcome.baseline.accounts]
    account,forecast=min(minima,key=lambda item:(item[1].minimum_headroom_minor,"" if item[0] is None else str(item[0])))
    if forecast.minimum_headroom_minor<=policy.low_headroom_threshold_minor:
        candidates.append(InsightCandidateV1(id=uuid5(NAMESPACE,f"low_headroom:{plan_id}:{account}"),kind="low_headroom",
            severity="caution" if forecast.minimum_headroom_minor<0 else "notice",title="Low planned headroom",
            reason="The reviewed forecast minimum is at or below the published rule threshold. Review the dated costs and paying accounts.",
            amount_minor=forecast.minimum_headroom_minor,currency="EUR",at=forecast.minimum_headroom_at,account_id=account,
            source_ids=evidence.balance_snapshot_ids,action="review_plan",assumptions=[
                "This is the protective forecast minimum for the named account or consolidated scope, not a current balance or spending allowance.",
                "The same reviewed protections, pending semantics and income assumptions as the financial engine apply.",
                "The rule threshold is a transparent product heuristic, not an assessment of your needs or a recommendation to spend or save."]))
    zone=ZoneInfo(planning_policy.timezone);today=now.astimezone(zone).date()
    for cost in sorted(inputs.costs,key=lambda item:(item.at,str(item.id))):
        days=(utc(cost.at).astimezone(zone).date()-today).days
        if cost.kind!="bill" or cost.opening_reflected or not cost.amount_minor or days>policy.bill_lookahead_calendar_days:
            continue
        if utc(cost.at)>outcome.prepared.period.protection_through: continue
        candidates.append(InsightCandidateV1(id=uuid5(NAMESPACE,f"upcoming_bill:{plan_id}:{cost.economic_cost_id}"),kind="upcoming_bill",
            severity="caution" if days<0 else "notice",title="Reviewed bill is overdue" if days<0 else "Upcoming reviewed bill",
            reason="An unreflected reviewed bill is due within the rule's calendar-day window or remains overdue. Check its payment status and paying account.",
            amount_minor=cost.amount_minor,currency="EUR",at=cost.at,account_id=cost.account_id,source_ids=[cost.id,cost.economic_cost_id],
            action="review_plan",assumptions=["This is a reviewed obligation, not proof a payment occurred or a new expense to add again.",
                "The financial engine already protects this cost and any linked reserve consumption exactly once.",
                "A reviewed upper-bound amount remains conservative; lower-cost assumptions are not used for this reminder."]))
    return PlanningInsightPreviewV1(status="ready",as_of=now,policy=policy,candidates=candidates[:policy.maximum_candidates],
        omitted_candidate_count=max(0,len(candidates)-policy.maximum_candidates),evidence=evidence,blocked_reasons=[])


def spending_insights(comparison,*,now,rule_policy=None):
    comparison=SpendingComparisonV1.model_validate(comparison.model_dump(mode="python"),strict=True)
    comparison=compare_spending(comparison.current,comparison.baseline,comparison.mode)
    policy=InsightRulePolicyV1.model_validate((rule_policy or InsightRulePolicyV1()).model_dump(mode="python"),strict=True)
    now=utc(now);today=now.astimezone(ZoneInfo("Europe/Helsinki")).date()
    current,baseline=comparison.current,comparison.baseline;reasons=[]
    if comparison.status!="covered_comparison": reasons.append("SPENDING_HISTORY_REVIEW_REQUIRED")
    if not comparison.equal_duration: reasons.append("EQUAL_SPENDING_WINDOWS_REQUIRED")
    if comparison.overlapping_windows or baseline.scope.end_exclusive>current.scope.start: reasons.append("EARLIER_NONOVERLAPPING_BASELINE_REQUIRED")
    if current.scope.end_exclusive>today or baseline.scope.end_exclusive>today: reasons.append("COMPLETE_HISTORICAL_DAYS_REQUIRED")
    if current.scope.currency!=policy.currency or baseline.scope.currency!=policy.currency: reasons.append("INSIGHT_CURRENCY_UNSUPPORTED")
    if baseline.net_minor<policy.spending_minimum_baseline_minor: reasons.append("POSITIVE_BASELINE_REQUIRED")
    if min(current.expense_count,baseline.expense_count)<policy.spending_minimum_expense_count: reasons.append("MORE_OBSERVED_EXPENSES_REQUIRED")
    if current.unresolved_flow_count or baseline.unresolved_flow_count: reasons.append("SPENDING_FLOW_REVIEW_REQUIRED")
    if current.net_minor!=current.gross_minor-current.refunds_minor or baseline.net_minor!=baseline.gross_minor-baseline.refunds_minor:
        reasons.append("SPENDING_RECONCILIATION_REQUIRED")
    candidates=[]
    increase=current.net_minor-baseline.net_minor
    # Compare the unrounded ratio with integer cross products. A rounded 25%
    # label must not cause a below-threshold 24.999% observation to trigger.
    if not reasons and increase>=policy.spending_minimum_increase_minor and increase*10000>=baseline.net_minor*policy.spending_increase_basis_points:
        scope=current.scope
        identity=f"higher_spending:{scope.account_ids}:{scope.currency}:{scope.start}:{scope.end_exclusive}:{baseline.scope.start}:{baseline.scope.end_exclusive}:{current.evidence_filters.model_dump_json()}"
        candidates.append(InsightCandidateV1(id=uuid5(NAMESPACE,identity),kind="higher_observed_spending",severity="notice",
            title="Higher observed spending",reason="Net booked spending increased by at least both published rule thresholds across the two equal-length observed windows.",
            amount_minor=increase,baseline_minor=baseline.net_minor,currency=scope.currency,at=None,account_id=None,
            source_ids=current.evidence_transaction_ids[:20]+baseline.evidence_transaction_ids[:20],action="inspect_spending_evidence",assumptions=[
                "This is a two-window threshold heuristic, not a statistical anomaly, a spending personality or evidence of an unhealthy habit.",
                "Refunds follow their booking dates. Transfers, income and liability settlements are not consumption.",
                "Only the stated account/category/merchant scope is compared; whole-finance and household coverage are not established.",
                "Observed increases do not establish their cause, future spending or safe-to-save capacity."]))
    return SpendingInsightPreviewV1(status="blocked" if reasons else "ready",as_of=now,policy=policy,candidates=candidates,
        comparison=comparison,blocked_reasons=reasons)
