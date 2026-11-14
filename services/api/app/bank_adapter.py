"""Provider-neutral read-only banking boundary. No browser/model authority lives here."""
from dataclasses import dataclass
from datetime import date, datetime
from typing import Annotated, Callable, Literal, Protocol
from uuid import UUID

from pydantic import AwareDatetime, Field, StrictBool, StrictInt

from .contracts import Basket, Contract, Currency, Minor, NonnegativeMinor
from .database import TrustedScope

from .synthetic_registry import SyntheticBankId

BankId = SyntheticBankId
SourceReference = Annotated[str, Field(min_length=1,max_length=200)]


class BankError(Exception):
    """Safe code only; never raw provider text or credentials."""
    def __init__(self,code: str,*,retryable=False,retry_after_seconds=None):
        self.code,self.retryable,self.retry_after_seconds = code,retryable,retry_after_seconds
        super().__init__(code)


@dataclass(frozen=True)
class BankSession:
    """Construct only from verified membership and owned durable connection state."""
    scope: TrustedScope
    connection_id: UUID
    generation: int
    account_references: tuple[str,...]
    expires_at: datetime | None


BankOperation = Literal["authorize", "discover", "read", "revoke"]
BankGuard = Callable[[BankSession,BankOperation],None]


class BankCapabilitiesV1(Contract):
    id: BankId
    name: str
    country: Literal["EE", "FI"] = "FI"
    mode: Literal["synthetic"] = "synthetic"
    notice: str
    currencies: list[Currency]
    account_types: list[Literal["current", "savings", "credit", "restricted"]]
    balance_kind: Literal["available", "booked"]
    pending_reflection: Literal["included", "excluded", "unknown"]
    supports_pending: StrictBool
    maximum_page_size: StrictInt = Field(ge=1,le=200)
    history_from: date
    minimum_refresh_seconds: StrictInt = Field(ge=1,le=3600)
    consent_seconds: StrictInt = Field(ge=60,le=86400)
    timeout_seconds: StrictInt = Field(ge=1,le=15)
    timezone: str = "Europe/Helsinki"
    payments_supported: Literal[False] = False


class BankAccountV1(Contract):
    reference: SourceReference
    canonical_reference: SourceReference
    name: str = Field(max_length=200)
    currency: Currency
    account_type: Literal["current", "savings", "credit", "restricted"]


class BankAuthorizationV1(Contract):
    reference: SourceReference
    available_accounts: list[BankAccountV1] = Field(max_length=50)
    expires_at: AwareDatetime
    mode: Literal["synthetic"] = "synthetic"
    notice: str


class BankGrantV1(Contract):
    reference: SourceReference
    account_references: list[SourceReference] = Field(min_length=1,max_length=50)
    expires_at: AwareDatetime
    mode: Literal["synthetic"] = "synthetic"


class BankBalanceV1(Contract):
    reference: SourceReference
    account_reference: SourceReference
    amount_minor: Minor
    currency: Currency
    kind: Literal["available", "booked"]
    pending_reflection: Literal["included", "excluded", "unknown"]
    included_credit_minor: NonnegativeMinor
    inaccessible_minor: NonnegativeMinor | None
    observed_at: AwareDatetime
    source_version: str = Field(max_length=100)


class BankTransactionV1(Contract):
    reference: SourceReference
    account_reference: SourceReference
    revision: StrictInt = Field(ge=1,le=2**53-1)
    amount_minor: Minor
    currency: Currency
    booked_on: date
    status: Literal["booked", "pending", "reversed"]
    merchant: str = Field(min_length=1,max_length=2000)
    category: str = Field(max_length=100)
    basket: Basket
    economic_flow: Literal["expense", "refund", "income", "internal_transfer", "liability_settlement", "unknown"]
    related_reference: SourceReference | None = None
    related_institution: BankId | None = None


class BankTransactionPageV1(Contract):
    rows: list[BankTransactionV1] = Field(max_length=200)
    next_cursor: str | None
    source_version: str = Field(max_length=100)
    observed_at: AwareDatetime
    coverage_from: date
    coverage_to_exclusive: date
    complete: StrictBool


class BankRevocationV1(Contract):
    acknowledged: Literal[True] = True
    mode: Literal["synthetic"] = "synthetic"


class BankAdapter(Protocol):
    def capabilities(self) -> BankCapabilitiesV1: ...
    def begin_consent(self,session: BankSession) -> BankAuthorizationV1: ...
    def complete_consent(self,session: BankSession,selected: tuple[str,...]) -> BankGrantV1: ...
    def list_accounts(self,session: BankSession) -> list[BankAccountV1]: ...
    def fetch_balances(self,session: BankSession,account_reference: str,*,as_of: datetime) -> list[BankBalanceV1]: ...
    def fetch_transactions(self,session: BankSession,account_reference: str,*,as_of: datetime,
        start: date,end_exclusive: date,cursor: str | None=None,limit: int=100) -> BankTransactionPageV1: ...
    def revoke_consent(self,session: BankSession) -> BankRevocationV1: ...
