"""Account-aware dated cash flow. All values are minor units; no model calls."""
from datetime import timedelta
from typing import Literal
from uuid import UUID, uuid5
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime

from .contracts import Contract, Minor, NonnegativeMinor
from .planning import Forecast
from .planning_inputs import PlanningBlockerV1, PlanningInputsV1, PreparedPlanningV1, prepare_planning
from .planning_policy import PlanningPolicyV1, utc

LEDGER_NAMESPACE = UUID("b3664c53-1b39-472d-a519-7f76613c5cb6")
LIMIT = 2**53-1


class CashEffectV1(Contract):
    account_id: UUID
    amount_minor: Minor


class ReserveReleaseV1(Contract):
    protection_id: UUID
    account_id: UUID
    amount_minor: NonnegativeMinor


class ForecastEntryV1(Contract):
    id: UUID
    source_id: UUID
    economic_cost_id: UUID | None
    at: AwareDatetime
    kind: Literal["pending", "outflow", "transfer", "income"]
    effects: list[CashEffectV1]
    releases: list[ReserveReleaseV1]


class AccountForecastV1(Contract):
    account_id: UUID
    forecast: Forecast


class ForecastScenarioV1(Contract):
    status: Literal["estimated", "blocked"]
    amount_minor: NonnegativeMinor | None
    consolidated: Forecast
    accounts: list[AccountForecastV1]
    routing_limited: bool
    event_count: int
    evidence_entry_ids: list[UUID]
    blockers: list[PlanningBlockerV1]


class PlanningOutcomeV1(Contract):
    data_version: int
    plan_version: int
    calculation_version: Literal[1] = 1
    currency: Literal["EUR"] = "EUR"
    status: Literal["estimated", "blocked"]
    amount_minor: NonnegativeMinor | None
    prepared: PreparedPlanningV1
    baseline: ForecastScenarioV1 | None
    absent_income: ForecastScenarioV1 | None
    delayed_income: ForecastScenarioV1 | None
    lower_cost_scenario: ForecastScenarioV1 | None
    cost_assumptions: list["CostAssumptionV1"]
    conditional_transfers: ForecastScenarioV1 | None
    conditional_transfer_ids: list[UUID]
    stress_delay_days: int
    assumptions: list[str]
    blockers: list[PlanningBlockerV1]


class CostAssumptionV1(Contract):
    source_id: UUID
    protective_amount_minor: NonnegativeMinor
    reviewed_lower_amount_minor: NonnegativeMinor | None
    basis: Literal["reviewed", "reviewed_upper_bound", "unreviewed"]
    interpretation: Literal["deterministic_assumption_not_confidence_interval"] = "deterministic_assumption_not_confidence_interval"


class AllocationProposalV1(Contract):
    status: Literal["estimated", "blocked"]
    surplus_minor: NonnegativeMinor | None
    desired_discretionary_minor: NonnegativeMinor | None
    savings_capacity_minor: NonnegativeMinor | None
    chosen_savings_minor: NonnegativeMinor | None
    remaining_spending_minor: NonnegativeMinor | None
    blockers: list[PlanningBlockerV1]
    persisted: Literal[False] = False


def money(value):
    if not -LIMIT<=value<=LIMIT:
        raise ValueError("MONETARY_RANGE_EXCEEDED")
    return value


def build_forecast_ledger(inputs, prepared, *, income_mode="baseline", delay_days=7, transfers=False, cost_mode="protective"):
    if prepared.status!="ready":
        raise ValueError("Planning inputs must pass validation before ledger construction")
    if income_mode not in ("baseline", "absent", "delayed"):
        raise ValueError("Unknown income scenario")
    if cost_mode not in ("protective", "reviewed_lower"):
        raise ValueError("Unknown cost scenario")
    now, through = prepared.period.as_of, prepared.period.protection_through
    reflection = {item.account_id:item.pending_reflection for item in prepared.openings}
    entries = []
    def append(source, kind, at, effects, releases=(), economic_cost_id=None):
        entries.append(ForecastEntryV1(id=uuid5(LEDGER_NAMESPACE,f"{source}:{kind}:{income_mode}:{cost_mode}"),
            source_id=source, economic_cost_id=economic_cost_id, at=utc(at), kind=kind,
            effects=[CashEffectV1(account_id=account,amount_minor=amount) for account,amount in effects],
            releases=list(releases)))
    for pending in inputs.pending:
        if pending.state=="pending" and reflection[pending.account_id]=="excluded":
            # An authorized hold can settle immediately; protect it at t0.
            append(pending.id,"pending",now,[(pending.account_id,-pending.amount_minor)],
                [ReserveReleaseV1(protection_id=link.protection_id,account_id=pending.account_id,amount_minor=link.amount_minor)
                    for link in pending.consumes],pending.economic_cost_id)
    for cost in inputs.costs:
        if not cost.opening_reflected:
            amount = cost.lower_amount_minor if cost_mode=="reviewed_lower" and cost.lower_amount_minor is not None else cost.amount_minor
            releases,unfunded = [],amount
            for link in cost.consumes:
                used = min(link.amount_minor,unfunded)
                releases.append(ReserveReleaseV1(protection_id=link.protection_id,account_id=cost.account_id,amount_minor=used))
                unfunded -= used
            append(cost.id,"outflow",max(now,utc(cost.at)),[(cost.account_id,-amount)],releases,cost.economic_cost_id)
    for income in inputs.incomes:
        if not income.confirmed or utc(income.at)<=now or income_mode=="absent":
            continue
        at = utc(income.at)
        if income_mode=="delayed":
            at = (at.astimezone(ZoneInfo(prepared.period.timezone))+timedelta(days=delay_days)).astimezone(now.tzinfo)
        if at<=through:
            append(income.id,"income",at,[(income.account_id,income.amount_minor)])
    if transfers:
        for transfer in inputs.transfers:
            # One atomic zero-sum operation: no fake consolidated cash dip/income.
            append(transfer.id,"transfer",transfer.at,
                [(transfer.from_account_id,-transfer.amount_minor),(transfer.to_account_id,transfer.amount_minor)])
    priority = {"pending":0,"outflow":0,"transfer":1,"income":2}
    return tuple(sorted(entries,key=lambda item:(item.at,priority[item.kind],str(item.id))))


def evaluate_ledger(inputs, prepared, entries):
    if prepared.status!="ready":
        raise ValueError("Planning inputs must pass validation before evaluation")
    cash = {item.account_id:item.own_funds_minor for item in prepared.openings}
    reserves, buffers = {}, {key:0 for key in cash}
    for protection in inputs.protections:
        for route in protection.routes:
            if protection.kind=="buffer":
                buffers[route.account_id] += route.amount_minor
            else:
                reserves[(protection.id,route.account_id)] = route.amount_minor
    remaining = {account:sum(amount for (_,key),amount in reserves.items() if key==account) for account in cash}
    headrooms = {account:money(amount-remaining[account]-buffers[account]) for account,amount in cash.items()}
    minima, times = dict(headrooms), {key:prepared.period.as_of for key in cash}
    consolidated = money(sum(headrooms.values()))
    consolidated_min, consolidated_at = consolidated, prepared.period.as_of
    for entry in entries:
        if not prepared.period.as_of<=entry.at<=prepared.period.protection_through:
            raise ValueError("Forecast entry is outside the explicit protection horizon")
        touched = set()
        for effect in entry.effects:
            cash[effect.account_id] = money(cash[effect.account_id]+effect.amount_minor)
            touched.add(effect.account_id)
        for release in entry.releases:
            key = (release.protection_id,release.account_id)
            if release.amount_minor>reserves.get(key,0):
                raise ValueError("Forecast entry overconsumes a routed reserve")
            reserves[key] -= release.amount_minor
            remaining[release.account_id] -= release.amount_minor
            touched.add(release.account_id)
        consolidated_change = 0
        for account in touched:
            headroom = money(cash[account]-remaining[account]-buffers[account])
            consolidated_change += headroom-headrooms[account]
            headrooms[account] = headroom
            if headroom<minima[account]:
                minima[account],times[account] = headroom,entry.at
        consolidated = money(consolidated+consolidated_change)
        if consolidated<consolidated_min:
            consolidated_min,consolidated_at = consolidated,entry.at
    account_results = [AccountForecastV1(account_id=account,forecast=Forecast(minimum_headroom_minor=value,
        minimum_headroom_at=times[account],surplus_minor=max(0,value),shortfall_minor=max(0,-value)))
        for account,value in sorted(minima.items(),key=lambda item:str(item[0]))]
    combined = Forecast(minimum_headroom_minor=consolidated_min,minimum_headroom_at=consolidated_at,
        surplus_minor=max(0,consolidated_min),shortfall_minor=max(0,-consolidated_min))
    blockers = []
    if not combined.shortfall_minor:
        blockers = [PlanningBlockerV1(code="ACCOUNT_LIQUIDITY_SHORTFALL",action="review_dated_transfer_or_payment_route",account_id=item.account_id)
            for item in account_results if item.forecast.shortfall_minor]
    routable = money(sum(item.forecast.surplus_minor for item in account_results))
    capacity = min(combined.surplus_minor,routable)
    return ForecastScenarioV1(status="blocked" if blockers else "estimated",amount_minor=None if blockers else capacity,
        consolidated=combined,accounts=account_results,routing_limited=capacity<combined.surplus_minor,
        event_count=len(entries),evidence_entry_ids=[item.id for item in entries[:20]],blockers=blockers)


def calculate_planning(inputs: PlanningInputsV1, policy: PlanningPolicyV1, *, stress_delay_days=7):
    if type(stress_delay_days) is not int or not 1<=stress_delay_days<=30:
        raise ValueError("Income stress delay must be between one and thirty calendar days")
    prepared = prepare_planning(inputs,policy)
    assumptions = prepared.assumptions+[
        "Dated debits precede credits at the same instant; overdue uncovered costs apply immediately.",
        "Baseline excludes all proposed account transfers. Conditional transfers are assumptions, never payments.",
        "Income stress uses the same protection horizon; delayed receipts beyond it are excluded.",
        "Routable immediate allowance also respects the sum of independent account minima.",
        "Deterministic estimates, not statistical confidence intervals; review uncertain costs at their protective amount."]
    baseline = absent = delayed = conditional = lower = None
    cost_assumptions = [CostAssumptionV1(source_id=item.id,protective_amount_minor=item.amount_minor,
        reviewed_lower_amount_minor=item.lower_amount_minor,basis=item.amount_basis) for item in inputs.costs
        if not item.opening_reflected and (item.lower_amount_minor is not None or item.amount_basis!="reviewed")]
    blockers = list(prepared.blockers)
    if not blockers:
        try:
            baseline = evaluate_ledger(inputs,prepared,build_forecast_ledger(inputs,prepared))
            absent = evaluate_ledger(inputs,prepared,build_forecast_ledger(inputs,prepared,income_mode="absent"))
            delayed = evaluate_ledger(inputs,prepared,build_forecast_ledger(inputs,prepared,income_mode="delayed",delay_days=stress_delay_days))
            if any(item.lower_amount_minor is not None and not item.opening_reflected for item in inputs.costs):
                lower = evaluate_ledger(inputs,prepared,build_forecast_ledger(inputs,prepared,cost_mode="reviewed_lower"))
            if inputs.transfers:
                conditional = evaluate_ledger(inputs,prepared,build_forecast_ledger(inputs,prepared,transfers=True))
            blockers = baseline.blockers
        except ValueError as exc:
            if str(exc)!="MONETARY_RANGE_EXCEEDED":
                raise
            baseline = absent = delayed = conditional = lower = None
            blockers = [PlanningBlockerV1(code="MONETARY_RANGE_EXCEEDED",action="narrow_planning_scope_or_amounts")]
    return PlanningOutcomeV1(data_version=inputs.data_version,plan_version=inputs.plan_version,
        status="blocked" if blockers else "estimated",amount_minor=None if blockers else baseline.amount_minor,
        prepared=prepared,baseline=baseline,absent_income=absent,delayed_income=delayed,lower_cost_scenario=lower,
        cost_assumptions=cost_assumptions,conditional_transfers=conditional,
        conditional_transfer_ids=[item.id for item in inputs.transfers],stress_delay_days=stress_delay_days,
        assumptions=assumptions,blockers=blockers)


def propose_allocation(outcome, *, desired_discretionary_minor, chosen_savings_minor=None):
    for value in (desired_discretionary_minor,chosen_savings_minor):
        if value is not None and (type(value) is not int or not 0<=value<=LIMIT):
            raise ValueError("Allocation choices must be nonnegative integer minor units")
    blockers = list(outcome.blockers)
    available = outcome.amount_minor
    capacity = remaining = None
    if desired_discretionary_minor is None:
        blockers.append(PlanningBlockerV1(code="DISCRETIONARY_PREFERENCE_UNKNOWN",action="choose_discretionary_amount_or_explicit_alternatives"))
    if available is not None and desired_discretionary_minor is not None:
        capacity = max(0,available-desired_discretionary_minor)
        if desired_discretionary_minor>available:
            blockers.append(PlanningBlockerV1(code="DISCRETIONARY_PREFERENCE_EXCEEDS_SURPLUS",action="review_spending_preference_and_shortfall"))
        if chosen_savings_minor is not None and chosen_savings_minor>capacity:
            blockers.append(PlanningBlockerV1(code="SAVINGS_EXCEED_CAPACITY",action="reduce_savings_or_discretionary_preference"))
        if not blockers and chosen_savings_minor is not None:
            remaining = available-chosen_savings_minor
    return AllocationProposalV1(status="blocked" if blockers else "estimated",surplus_minor=available,
        desired_discretionary_minor=desired_discretionary_minor,savings_capacity_minor=capacity,
        chosen_savings_minor=chosen_savings_minor,remaining_spending_minor=remaining,blockers=blockers)
