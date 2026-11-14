"""Shared immutable planning reservation receipts."""
from typing import Annotated,Literal
from uuid import UUID

from pydantic import AwareDatetime,Field,StrictInt

from .contracts import Contract,NonnegativeMinor

Version=Annotated[StrictInt,Field(ge=1,le=2**53-1)]


class AllocationSnapshotV1(Contract):
    data_version: Version
    plan_version: Version
    surplus_before_minor: NonnegativeMinor
    remaining_spending_at_acceptance_minor: NonnegativeMinor
    desired_discretionary_minor: NonnegativeMinor
    as_of: AwareDatetime


class AllocationReceiptV1(Contract):
    id: UUID
    plan_id: UUID
    reserve_id: UUID
    account_id: UUID
    amount_minor: Annotated[NonnegativeMinor,Field(gt=0)]
    currency: Literal["EUR"]
    state: Literal["active","released"]
    accepted_plan_version: Version
    acceptance_snapshot: AllocationSnapshotV1
    accepted_at: AwareDatetime
    released_at: AwareDatetime | None
    bank_transfer_executed: Literal[False]
