"""Validate server-owned planning facts before any actionable amount is calculated."""
from datetime import timedelta
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, StrictBool, StrictInt

from .contracts import Contract, Currency, Minor, NonnegativeMinor
from .planning_policy import IncomeTimingV1, PlanningPolicyV1, ProtectionPeriodV1, protection_period, utc

ProtectionKind = Literal["essentials", "irregular", "savings", "buffer"]


class PlanningAccountV1(Contract):
    id: UUID
    currency: Currency
    account_type: Literal["current", "savings", "credit", "restricted"]
    liquid: StrictBool
    material: StrictBool
    synced_at: AwareDatetime | None
    coverage: Literal["verified", "user_confirmed", "unknown"]
    coverage_through: AwareDatetime | None
    liability_covered: StrictBool | None


class PlanningBalanceV1(Contract):
    id: UUID
    account_id: UUID
    amount_minor: Minor
    currency: Currency
    kind: Literal["available", "booked"]
    observed_at: AwareDatetime
    pending_reflection: Literal["included", "excluded", "unknown"]
    included_credit_minor: NonnegativeMinor | None
    inaccessible_minor: NonnegativeMinor | None


class ProtectionRouteV1(Contract):
    account_id: UUID
    amount_minor: NonnegativeMinor


class PlanningProtectionV1(Contract):
    id: UUID
    kind: ProtectionKind
    amount_minor: NonnegativeMinor | None
    reviewed_through: AwareDatetime | None
    routes: list[ProtectionRouteV1] | None = Field(max_length=50)


class ReservationConsumptionV1(Contract):
    protection_id: UUID
    amount_minor: NonnegativeMinor


class PlanningPendingV1(Contract):
    id: UUID
    account_id: UUID
    amount_minor: NonnegativeMinor
    state: Literal["pending", "booked", "reversed"]
    economic_cost_id: UUID
    kind: Literal["bill", "essential", "irregular", "savings", "liability"] = "bill"
    consumes: list[ReservationConsumptionV1] = Field(default_factory=list, max_length=50)


class PlanningCostV1(Contract):
    id: UUID
    economic_cost_id: UUID
    account_id: UUID
    at: AwareDatetime
    amount_minor: NonnegativeMinor
    amount_basis: Literal["reviewed", "reviewed_upper_bound", "unreviewed"] = "reviewed"
    lower_amount_minor: NonnegativeMinor | None = None
    opening_reflected: StrictBool
    kind: Literal["bill", "essential", "irregular", "savings", "liability"]
    consumes: list[ReservationConsumptionV1] = Field(default_factory=list, max_length=50)


class PlanningIncomeV1(Contract):
    id: UUID
    account_id: UUID
    at: AwareDatetime
    amount_minor: NonnegativeMinor
    confirmed: StrictBool


class PlanningTransferV1(Contract):
    id: UUID
    from_account_id: UUID
    to_account_id: UUID
    at: AwareDatetime
    amount_minor: NonnegativeMinor


class PlanningInputsV1(Contract):
    data_version: StrictInt = Field(ge=1)
    plan_version: StrictInt = Field(ge=1)
    as_of: AwareDatetime
    requested_to_exclusive: AwareDatetime | None = None
    accounts: list[PlanningAccountV1] = Field(max_length=50)
    balances: list[PlanningBalanceV1] = Field(max_length=50)
    protections: list[PlanningProtectionV1] = Field(max_length=4)
    obligations_reviewed_through: AwareDatetime | None
    pending: list[PlanningPendingV1] = Field(default_factory=list, max_length=2000)
    costs: list[PlanningCostV1] = Field(default_factory=list, max_length=2000)
    incomes: list[PlanningIncomeV1] = Field(default_factory=list, max_length=500)
    transfers: list[PlanningTransferV1] = Field(default_factory=list, max_length=100)
    source: Literal["synthetic_user_confirmed", "verified"]


class PlanningBlockerV1(Contract):
    code: str
    action: str
    account_id: UUID | None = None
    item_id: UUID | None = None


class NormalizedOpeningV1(Contract):
    account_id: UUID
    snapshot_id: UUID
    own_funds_minor: Minor
    excluded_credit_minor: NonnegativeMinor
    excluded_inaccessible_minor: NonnegativeMinor
    pending_reflection: Literal["included", "excluded"]


class PreparedPlanningV1(Contract):
    status: Literal["ready", "blocked"]
    period: ProtectionPeriodV1
    blockers: list[PlanningBlockerV1]
    openings: list[NormalizedOpeningV1] | None
    excluded_account_ids: list[UUID]
    assumptions: list[str]


def prepare_planning(inputs: PlanningInputsV1, policy: PlanningPolicyV1) -> PreparedPlanningV1:
    now = utc(inputs.as_of)
    period = protection_period(now, policy, requested_to_exclusive=inputs.requested_to_exclusive,
        incomes=[IncomeTimingV1(at=item.at, confirmed=item.confirmed) for item in inputs.incomes])
    blockers, openings, excluded = [], [], []
    def block(code, action, account=None, item=None):
        blockers.append(PlanningBlockerV1(code=code, action=action, account_id=account, item_id=item))
    maximum_age = timedelta(hours=policy.balance_maximum_age_hours)
    future_skew = timedelta(seconds=policy.maximum_future_skew_seconds)
    accounts = {item.id:item for item in inputs.accounts}
    if len(accounts)!=len(inputs.accounts):
        block("DUPLICATE_ACCOUNT", "review_account_scope")
    liquid = {key:item for key,item in accounts.items() if item.liquid and item.account_type in ("current", "savings")}
    if not liquid:
        block("NO_LIQUID_ACCOUNT", "choose_liquid_accounts")
    for account in accounts.values():
        if account.id not in liquid:
            excluded.append(account.id)
            if account.account_type=="credit" and account.material and account.liability_covered is not True:
                block("LIABILITY_COVERAGE_UNKNOWN", "review_settlement_obligations", account.id)
            continue
        if account.currency!=policy.currency:
            block("UNSUPPORTED_CURRENCY", "supply_reviewed_currency_scope", account.id)
        if account.coverage=="unknown" or account.coverage_through is None or utc(account.coverage_through)<now:
            block("ACCOUNT_COVERAGE_UNKNOWN", "refresh_or_review_account_coverage", account.id)
        if account.synced_at is None or now-utc(account.synced_at)>maximum_age:
            block("SYNC_STALE_OR_MISSING", "refresh_or_confirm_current_account", account.id)
        elif utc(account.synced_at)-now>future_skew:
            block("SYNC_IN_FUTURE", "correct_source_timestamp", account.id)
        matches = [item for item in inputs.balances if item.account_id==account.id]
        if len(matches)!=1:
            block("BALANCE_MISSING_OR_AMBIGUOUS", "supply_one_current_typed_balance", account.id)
            continue
        balance = matches[0]
        if balance.currency!=account.currency:
            block("BALANCE_CURRENCY_MISMATCH", "correct_balance_currency", account.id, balance.id)
        if now-utc(balance.observed_at)>maximum_age:
            block("BALANCE_STALE", "refresh_or_confirm_current_balance", account.id, balance.id)
        if utc(balance.observed_at)-now>future_skew:
            block("BALANCE_IN_FUTURE", "correct_source_timestamp", account.id, balance.id)
        if balance.pending_reflection=="unknown" or (balance.kind=="booked" and balance.pending_reflection!="excluded"):
            block("PENDING_BASIS_UNKNOWN", "review_pending_balance_semantics", account.id, balance.id)
        if balance.included_credit_minor is None or balance.inaccessible_minor is None:
            block("OWN_FUNDS_COMPONENTS_UNKNOWN", "review_credit_and_inaccessible_funds", account.id, balance.id)
        elif balance.included_credit_minor+balance.inaccessible_minor>max(0,balance.amount_minor):
            block("INVALID_BALANCE_COMPONENTS", "correct_balance_components", account.id, balance.id)
        elif balance.pending_reflection!="unknown":
            openings.append(NormalizedOpeningV1(account_id=account.id, snapshot_id=balance.id,
                own_funds_minor=balance.amount_minor-balance.included_credit_minor-balance.inaccessible_minor,
                excluded_credit_minor=balance.included_credit_minor, excluded_inaccessible_minor=balance.inaccessible_minor,
                pending_reflection=balance.pending_reflection))
    for balance in inputs.balances:
        if balance.account_id not in accounts:
            block("UNKNOWN_BALANCE_ACCOUNT", "review_account_scope", balance.account_id, balance.id)
    if len({item.id for item in inputs.balances})!=len(inputs.balances):
        block("DUPLICATE_BALANCE_ID", "review_balance_provenance")
    if not -(2**53-1)<=sum(item.own_funds_minor for item in openings)<=2**53-1:
        block("MONETARY_RANGE_EXCEEDED", "narrow_planning_account_scope")
    protections = {item.kind:item for item in inputs.protections}
    protection_ids = {item.id:item for item in inputs.protections}
    if len(protections)!=len(inputs.protections) or len(protection_ids)!=len(inputs.protections):
        block("DUPLICATE_PROTECTION", "review_protections")
    for kind in ("essentials", "irregular", "savings", "buffer"):
        protection = protections.get(kind)
        if protection is None or protection.amount_minor is None:
            block("PROTECTION_AMOUNT_UNKNOWN", "review_"+kind)
            continue
        if protection.reviewed_through is None or utc(protection.reviewed_through)<period.protection_through:
            block("PROTECTION_HORIZON_UNREVIEWED", "review_"+kind+"_through_horizon", item=protection.id)
        routes = protection.routes
        if routes is None or sum(item.amount_minor for item in routes)!=protection.amount_minor or len({item.account_id for item in routes})!=len(routes):
            block("PROTECTION_ROUTING_UNRESOLVED", "route_"+kind+"_exactly_once", item=protection.id)
        elif any(item.account_id not in liquid for item in routes):
            block("PROTECTION_ACCOUNT_UNAVAILABLE", "choose_liquid_protection_accounts", item=protection.id)
    if inputs.obligations_reviewed_through is None or utc(inputs.obligations_reviewed_through)<period.protection_through:
        block("OBLIGATIONS_UNREVIEWED", "review_obligations_through_horizon")
    pending_costs, cost_ids, event_ids, consumed = set(), set(), set(), {}
    def validate_consumption(item, reflected):
        if len({link.protection_id for link in item.consumes})!=len(item.consumes) or sum(link.amount_minor for link in item.consumes)>item.amount_minor:
            block("INVALID_RESERVATION_CONSUMPTION", "review_reservation_links", item=item.id)
        for link in item.consumes:
            protection = protection_ids.get(link.protection_id)
            if protection is None or protection.kind=="buffer":
                block("INVALID_RESERVATION_LINK", "link_a_consumable_protection", item=item.id)
                continue
            permitted = {"essential":{"essentials"}, "irregular":{"irregular"}, "savings":{"savings"},
                "bill":{"essentials","irregular"}, "liability":{"essentials","irregular"}}[item.kind]
            if protection.kind not in permitted:
                block("RESERVATION_PURPOSE_MISMATCH", "review_reservation_purpose", item=item.id)
            route_amount = sum(route.amount_minor for route in (protection.routes or []) if route.account_id==item.account_id)
            key = (protection.id, item.account_id)
            if reflected and link.amount_minor:
                block("OPENING_COST_RELEASES_RESERVE", "reconcile_reflected_cost_and_remaining_reserve", item=item.id)
            consumed[key] = consumed.get(key,0)+link.amount_minor
            if consumed[key]>route_amount:
                block("RESERVATION_OVERCONSUMED", "review_reservation_links", item.account_id, item.id)
    for item in inputs.pending:
        if item.id in event_ids or (item.state=="pending" and item.economic_cost_id in pending_costs):
            block("DUPLICATE_PENDING_EFFECT", "reconcile_pending_records", item=item.id)
        event_ids.add(item.id)
        if item.account_id not in liquid:
            block("PENDING_ACCOUNT_UNAVAILABLE", "review_pending_account", item.account_id, item.id)
        if item.state=="pending":
            pending_costs.add(item.economic_cost_id)
        reflected = item.state!="pending" or any(balance.account_id==item.account_id and balance.pending_reflection=="included" for balance in inputs.balances)
        validate_consumption(item,reflected)
    for cost in inputs.costs:
        if cost.amount_basis=="unreviewed" and not cost.opening_reflected:
            block("UNCERTAIN_COST_UNREVIEWED", "review_protective_upper_cost", item=cost.id)
        if cost.lower_amount_minor is not None and cost.lower_amount_minor>cost.amount_minor:
            block("COST_RANGE_INVALID", "review_ordered_cost_bounds", item=cost.id)
        if cost.id in event_ids or cost.economic_cost_id in cost_ids or cost.economic_cost_id in pending_costs:
            block("DUPLICATE_COST_EFFECT", "reconcile_cost_funding_state", item=cost.id)
        event_ids.add(cost.id)
        cost_ids.add(cost.economic_cost_id)
        if cost.account_id not in liquid:
            block("PAYING_ACCOUNT_UNAVAILABLE", "choose_liquid_paying_account", cost.account_id, cost.id)
        if not cost.opening_reflected and utc(cost.at)>period.protection_through:
            block("COST_OUTSIDE_HORIZON", "review_cost_period_or_fund_longer_reserve", item=cost.id)
        validate_consumption(cost,cost.opening_reflected)
    for item in inputs.incomes:
        if item.id in event_ids:
            block("DUPLICATE_EVENT_ID", "review_event_provenance", item=item.id)
        event_ids.add(item.id)
        if item.account_id not in liquid:
            block("INCOME_ACCOUNT_UNAVAILABLE", "review_income_account", item.account_id, item.id)
    for item in inputs.transfers:
        if item.id in event_ids or item.from_account_id==item.to_account_id:
            block("INVALID_TRANSFER_ASSUMPTION", "review_transfer_assumption", item=item.id)
        event_ids.add(item.id)
        if item.from_account_id not in liquid or item.to_account_id not in liquid:
            block("TRANSFER_ACCOUNT_UNAVAILABLE", "choose_liquid_transfer_accounts", item=item.id)
        if utc(item.at)<now or utc(item.at)>period.protection_through:
            block("TRANSFER_OUTSIDE_HORIZON", "review_transfer_timing", item=item.id)
    if period.background_required:
        block("BACKGROUND_SCENARIO_REQUIRED", "submit_long_scenario_job")
    assumptions = ["Synthetic user-confirmed inputs; no bank verification."] if inputs.source=="synthetic_user_confirmed" else []
    assumptions += ["EUR only; no FX conversion.", "Full-horizon protections are earmarked upfront; no automatic replenishment.",
        "Only confirmed future external income is included. Transfers are explicit conditional assumptions and never executed."]
    return PreparedPlanningV1(status="blocked" if blockers else "ready", period=period, blockers=blockers,
        openings=None if blockers else sorted(openings,key=lambda item:str(item.account_id)),
        excluded_account_ids=sorted(excluded,key=str), assumptions=assumptions)
