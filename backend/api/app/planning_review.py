"""Bind explicit synthetic user reviews to owned database facts, never client balances."""
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, StrictBool, StrictInt, model_validator
from psycopg.rows import dict_row

from .contracts import Contract, Currency, Minor, NonnegativeMinor
from .identity import AuthError, authorized_transaction
from .bank_access import bank_account_access, planning_sources_ready
from .bank_sources import AccountSourceV1, source_evidence
from .planning_engine import calculate_planning
from .planning_inputs import (PlanningAccountV1, PlanningBalanceV1, PlanningCostV1, PlanningIncomeV1,
    PlanningInputsV1, PlanningPendingV1, PlanningProtectionV1, PlanningTransferV1)
from .planning_policy import IncomeTimingV1, PlanningPolicyV1, ProtectionPeriodV1, protection_period, utc
from .planning_store import fingerprint

Version = Annotated[StrictInt, Field(ge=1, le=2**53-1)]


class AccountReviewV1(Contract):
    account_id: UUID
    balance_snapshot_id: UUID | None
    inaccessible_minor: NonnegativeMinor | None
    coverage_confirmed: StrictBool
    liability_covered: StrictBool | None


class CreateReviewedPlanV1(Contract):
    key: Annotated[str, Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")]
    expected_data_version: Version
    expected_plan_version: Version
    accounts: list[AccountReviewV1] = Field(min_length=1, max_length=50)
    protections: list[PlanningProtectionV1] = Field(max_length=4)
    obligations_reviewed_through: AwareDatetime | None
    requested_to_exclusive: AwareDatetime | None = None
    extra_costs: list[PlanningCostV1] = Field(default_factory=list, max_length=500)
    incomes: list[PlanningIncomeV1] = Field(default_factory=list, max_length=500)
    transfers: list[PlanningTransferV1] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def representable_instants(self):
        def check(value):
            if isinstance(value,datetime):
                utc(value)
            elif isinstance(value,dict):
                for child in value.values():
                    check(child)
            elif isinstance(value,list):
                for child in value:
                    check(child)
        try:
            check(self.model_dump())
        except (OverflowError,ValueError):
            raise ValueError("Use planning instants representable in UTC") from None
        return self


class ReviewAccountContextV1(Contract):
    id: UUID
    name: str
    currency: Currency
    account_type: Literal["current", "savings", "credit", "restricted"]
    balance: PlanningBalanceV1 | None
    source: AccountSourceV1 | None = None


class SourceObligationV1(Contract):
    id: UUID
    account_id: UUID
    amount_minor: NonnegativeMinor
    currency: Currency
    due_at: AwareDatetime


class SourcePendingV1(Contract):
    id: UUID
    account_id: UUID
    amount_minor: Minor
    currency: Currency


class ReviewContextV1(Contract):
    data_version: Version
    plan_version: Version
    as_of: AwareDatetime
    source: Literal["synthetic_user_confirmed"] = "synthetic_user_confirmed"
    policy: PlanningPolicyV1
    period: ProtectionPeriodV1
    accounts: list[ReviewAccountContextV1]
    obligations: list[SourceObligationV1]
    pending: list[SourcePendingV1]
    existing_reservations_require_review: StrictBool
    assumptions: list[str]


class PlanningReview:
    """Initial synthetic review workflow; provider-verified review remains a release gate."""
    def __init__(self, store, policy):
        self.store, self.policy = store, policy
        self.connection, self.user, self.owner = store.connection, store.user, store.owner

    def require_source(self):
        if not self.user.synthetic:
            raise AuthError("PLANNING_SOURCE_NOT_READY",409)

    def rows(self, query, params=()):
        with self.connection.cursor(row_factory=dict_row) as cursor:
            return cursor.execute(query, params).fetchall()

    def facts(self):
        # All queries are bounded and run inside the caller's scoped snapshot.
        accounts = self.rows("""SELECT id,name,currency,account_type FROM moneylens.accounts
            WHERE tenant_id=%s AND owner_user_id=%s AND included ORDER BY id LIMIT 51""",self.owner)
        if len(accounts)>50:
            raise AuthError("NARROW_ACCOUNT_SCOPE",409)
        ids = [row["id"] for row in accounts]
        bank_account_access(self.connection,self.user,ids,now=utc(self.store.clock()))
        balances = self.rows("""SELECT snapshot.* FROM unnest(%s::uuid[]) AS chosen(account_id)
            CROSS JOIN LATERAL (SELECT id,account_id,amount_minor,currency,balance_kind AS kind,
                observed_at,pending_reflection,included_credit_minor FROM moneylens.analysis_balances
                WHERE tenant_id=%s AND owner_user_id=%s AND account_id=chosen.account_id
                ORDER BY observed_at DESC,id DESC LIMIT 1) AS snapshot""",(ids,*self.owner))
        pending = self.rows("""SELECT id,account_id,amount_minor,currency FROM moneylens.analysis_transactions
            WHERE tenant_id=%s AND owner_user_id=%s AND account_id=ANY(%s) AND status='pending'
            ORDER BY id LIMIT 501""",(*self.owner,ids))
        obligations = self.rows("""SELECT id,account_id,amount_minor,currency,due_at FROM moneylens.obligations
            WHERE tenant_id=%s AND owner_user_id=%s AND state='planned' ORDER BY id LIMIT 501""",self.owner)
        if len(pending)>500 or len(obligations)>500:
            raise AuthError("PLANNING_BACKGROUND_REVIEW_REQUIRED",409)
        reserved = self.store.one("""SELECT id FROM moneylens.reserves WHERE tenant_id=%s AND owner_user_id=%s
            AND amount_minor>consumed_minor+released_minor LIMIT 1""",self.owner) is not None
        return accounts,balances,pending,obligations,reserved

    def context(self):
        self.require_source()
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            accounts,balances,pending,obligations,reserved = self.facts()
            state, now = self.store.state(),utc(self.store.clock())
            by_account = {row["account_id"]:row for row in balances}
            sources=source_evidence(self.connection,self.user,[row["id"] for row in accounts],now=now,
                maximum_age_hours=self.policy.balance_maximum_age_hours)
            return ReviewContextV1(**state,as_of=now,policy=self.policy,period=protection_period(now,self.policy),
                accounts=[ReviewAccountContextV1(**row,balance=PlanningBalanceV1(**by_account[row["id"]],inaccessible_minor=None)
                    if row["id"] in by_account else None,source=sources.get(row["id"])) for row in accounts],
                obligations=obligations,pending=pending,existing_reservations_require_review=reserved,
                assumptions=["Synthetic account facts; coverage and future costs require explicit user review.",
                    "Freshness uses the source balance observation time; opening this form does not refresh the bank.",
                    "All included accounts must be reviewed. Stored planned obligations and pending debits cannot be omitted.",
                    "Pending receipts are excluded from income. Unmatched future bills and pending debits are protected separately.",
                    "Existing unspent reservations require reconciliation before a replacement review."])

    def inputs(self,body):
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            planning_sources_ready(self.connection,self.user,utc(self.store.clock()))
            state = self.store.state()
            if (state["data_version"],state["plan_version"])!=(body.expected_data_version,body.expected_plan_version):
                raise AuthError("PLANNING_VERSION_CHANGED",409)
            accounts,balances,pending,obligations,reserved = self.facts()
            if reserved:
                raise AuthError("EXISTING_RESERVATIONS_REQUIRE_REVIEW",409)
            reviews = {item.account_id:item for item in body.accounts}
            if len(reviews)!=len(body.accounts) or set(reviews)!={row["id"] for row in accounts}:
                raise AuthError("PLANNING_SCOPE_CHANGED",409)
            now = utc(self.store.clock())
            try:
                period = protection_period(now,self.policy,requested_to_exclusive=body.requested_to_exclusive,
                    incomes=[IncomeTimingV1(at=item.at,confirmed=item.confirmed) for item in body.incomes])
            except (OverflowError,ValueError):
                raise AuthError("INVALID_PLANNING_PERIOD",422) from None
            by_account = {row["account_id"]:row for row in balances}
            bound_accounts,bound_balances = [],[]
            for row in accounts:
                review,balance = reviews[row["id"]],by_account.get(row["id"])
                liquid = row["account_type"] in ("current","savings")
                if review.balance_snapshot_id is not None and (balance is None or balance["id"]!=review.balance_snapshot_id):
                    raise AuthError("PLANNING_BALANCE_CHANGED",409)
                if liquid and balance is not None and review.balance_snapshot_id is None:
                    raise AuthError("PLANNING_BALANCE_CHANGED",409)
                bound_accounts.append(PlanningAccountV1(id=row["id"],currency=row["currency"],account_type=row["account_type"],
                    liquid=liquid,material=True,synced_at=balance["observed_at"] if balance else None,
                    coverage="user_confirmed" if review.coverage_confirmed else "unknown",
                    coverage_through=now if review.coverage_confirmed else None,liability_covered=review.liability_covered))
                if liquid and balance:
                    bound_balances.append(PlanningBalanceV1(**balance,inaccessible_minor=review.inaccessible_minor))
            for row in pending+obligations:
                if row["currency"]!=self.policy.currency:
                    raise AuthError("MIXED_CURRENCY_SCOPE",409)
            # Source costs are authoritative. Extra reviewed assumptions cannot
            # replace them or mark them already reflected in an opening balance.
            source_costs = [PlanningCostV1(id=row["id"],economic_cost_id=row["id"],account_id=row["account_id"],
                at=row["due_at"],amount_minor=row["amount_minor"],opening_reflected=False,kind="bill")
                for row in obligations if utc(row["due_at"])<=period.protection_through]
            source_pending = [PlanningPendingV1(id=row["id"],economic_cost_id=row["id"],account_id=row["account_id"],
                amount_minor=-row["amount_minor"],state="pending") for row in pending if row["amount_minor"]<0]
            return PlanningInputsV1(data_version=state["data_version"],plan_version=state["plan_version"],as_of=now,
                requested_to_exclusive=body.requested_to_exclusive,accounts=bound_accounts,balances=bound_balances,
                protections=body.protections,obligations_reviewed_through=body.obligations_reviewed_through,
                pending=source_pending,costs=source_costs+body.extra_costs,incomes=body.incomes,transfers=body.transfers,
                source="synthetic_user_confirmed")

    def create(self,body):
        self.require_source()
        digest = fingerprint({"command":"synthetic.plan.review.v1","body":body.model_dump(mode="json")})
        prior = self.store.replay_creation(key=body.key,digest=digest)
        if prior is not None:
            return prior,prior["calculation"]
        try:
            inputs = self.inputs(body)
        except AuthError as exc:
            if exc.code in ("PLANNING_VERSION_CHANGED","DATA_CHANGED_RETRY"):
                prior = self.store.replay_creation(key=body.key,digest=digest)
                if prior is not None:
                    return prior,prior["calculation"]
            raise
        outcome = calculate_planning(inputs,self.policy)
        if outcome.status=="blocked":
            return None,outcome
        view = self.store.create(inputs,self.policy,key=body.key,command_digest=digest)
        return view,view["calculation"]
