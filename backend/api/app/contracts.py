"""Version-one domain contracts. Financial amounts are always integer minor units."""
from datetime import date
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt, model_validator

Minor = Annotated[StrictInt, Field(ge=-(2**53 - 1), le=2**53 - 1)]
NonnegativeMinor = Annotated[Minor, Field(ge=0)]
Currency = Annotated[str, Field(pattern=r"^[A-Z]{3}$")]
Basket = Literal["mandatory_regular", "mandatory_irregular", "everyday", "unresolved"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Money(Contract):
    amount_minor: Minor
    currency: Currency = "EUR"


class Owner(Contract):
    tenant_id: UUID
    user_id: UUID


class Account(Contract):
    id: UUID
    owner: Owner
    institution_id: str
    name: str
    currency: Currency
    account_type: Literal["current", "savings", "credit", "restricted"]
    included: bool = True


class BalanceSnapshot(Contract):
    id: UUID
    account_id: UUID
    amount_minor: Minor
    currency: Currency
    kind: Literal["available", "booked"]
    observed_at: AwareDatetime
    pending_reflection: Literal["included", "excluded", "unknown"]
    included_credit_minor: NonnegativeMinor = 0


class Transaction(Contract):
    id: UUID
    owner: Owner
    account_id: UUID
    provider_id: str
    amount_minor: Minor
    currency: Currency
    booked_on: date
    status: Literal["pending", "booked", "reversed"]
    merchant: Annotated[str, Field(min_length=1, max_length=2000)]
    category: str
    basket: Basket
    economic_flow: Literal["expense", "refund", "income", "internal_transfer", "liability_settlement", "unknown"]
    related_transaction_id: UUID | None = None


class Consent(Contract):
    id: UUID
    owner: Owner
    institution_id: str
    account_ids: list[UUID]
    state: Literal["requested", "authorizing", "active", "expired", "revoked", "denied"]
    expires_at: AwareDatetime | None = None
    generation: Annotated[StrictInt, Field(ge=1)] = 1


class Job(Contract):
    id: UUID
    owner: Owner
    state: Literal["queued", "running", "completed", "failed", "cancelled", "dead_letter"]
    idempotency_key: Annotated[str, Field(min_length=1, max_length=200)]
    attempts: Annotated[StrictInt, Field(ge=0)] = 0


class Period(Contract):
    start: date
    end_exclusive: date
    timezone: str = "Europe/Helsinki"

    @model_validator(mode="after")
    def ordered(self):
        if self.end_exclusive <= self.start:
            raise ValueError("The exclusive end must be after the start")
        return self


class Evidence(Contract):
    snapshot_id: str
    data_version: Annotated[StrictInt, Field(ge=1)]
    transaction_ids: list[UUID] = Field(default_factory=list)
    transaction_count: Annotated[StrictInt, Field(ge=0)] = 0
    source: Literal["synthetic_fixture"] = "synthetic_fixture"


class Blocker(Contract):
    code: str
    message: str
    action: str


class FinancialResult(Contract):
    currency: Currency = "EUR"
    amount_minor: NonnegativeMinor | None
    minimum_headroom_minor: Minor | None = None
    minimum_headroom_at: AwareDatetime | None = None
    surplus_minor: NonnegativeMinor | None = None
    shortfall_minor: NonnegativeMinor | None = None


class Analysis(Contract):
    schema_version: Literal["analysis.v1"] = "analysis.v1"
    calculation_id: UUID
    calculation_version: Literal[1] = 1
    data_version: StrictInt = 1
    status: Literal["ok", "estimated", "blocked", "superseded"]
    as_of: AwareDatetime
    result: FinancialResult
    evidence: Evidence
    assumptions: list[str] = Field(default_factory=list)
    blockers: list[Blocker] = Field(default_factory=list)

    @model_validator(mode="after")
    def coherent_result(self):
        if self.status == "blocked" and (self.result.amount_minor is not None or not self.blockers):
            raise ValueError("Blocked analyses need a null amount and at least one blocker")
        if self.status in ("ok", "estimated") and self.result.amount_minor is None:
            raise ValueError("An available analysis needs a calculated amount")
        return self


class Scenario(Contract):
    id: UUID
    owner: Owner
    baseline_data_version: StrictInt
    category: str
    reduction_percent: Annotated[Decimal, Field(ge=0, le=100)]
    months: Annotated[StrictInt, Field(ge=1, le=120)]


class Goal(Contract):
    id: UUID
    owner: Owner
    name: Annotated[str, Field(min_length=1, max_length=120)]
    target: Money
    deadline: date
    state: Literal["active", "paused", "completed"] = "active"

    @model_validator(mode="after")
    def positive_target(self):
        if self.target.amount_minor <= 0:
            raise ValueError("Goal targets must be positive")
        return self


class Allocation(Contract):
    id: UUID
    owner: Owner
    plan_id: UUID
    plan_version: Annotated[StrictInt, Field(ge=1)]
    amount_minor: Annotated[NonnegativeMinor, Field(gt=0)]
    currency: Currency = "EUR"
    idempotency_key: Annotated[str, Field(min_length=1, max_length=200)]
    goal_id: UUID | None = None


class BenchmarkSnapshot(Contract):
    id: str
    source_url: str
    table_id: str
    response_sha256: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    retrieved_at: AwareDatetime
    reference_period: str
    unit: str
    statistic_type: Literal["mean", "median", "share", "total"]
    attribution: str
    licence_url: str
    mapping_version: str


CONTRACTS = [Money, Owner, Account, BalanceSnapshot, Transaction, Consent, Job,
             Period, Evidence, Blocker, FinancialResult, Analysis, Scenario, Goal,
             Allocation, BenchmarkSnapshot]
