"""Closed bounded date/account filters shared by deterministic analysis queries."""
from datetime import date
from typing import Annotated
from uuid import UUID

from pydantic import Field,StrictInt,model_validator

from .contracts import Contract,Currency
from .ledger import LedgerFilterV1


class AnalysisWindowV1(Contract):
    start: date
    end_exclusive: date
    currency: Currency = "EUR"
    account_ids: list[UUID] | None = Field(default=None,min_length=1,max_length=50)
    category: str | None = Field(default=None,max_length=100)
    merchant: str | None = Field(default=None,max_length=200)
    expected_data_version: Annotated[StrictInt,Field(ge=1,le=2**53-1)] | None = None

    @model_validator(mode="after")
    def bounded_window(self):
        if not 1<=(self.end_exclusive-self.start).days<=366:
            raise ValueError("Choose one to 366 observed calendar days; larger requests need a separate background service")
        if self.account_ids is not None and len(set(self.account_ids))!=len(self.account_ids):
            raise ValueError("Choose distinct account identities")
        return self

    def filters(self):
        return LedgerFilterV1(**self.model_dump(include={"start","end_exclusive","currency","account_ids","category","merchant"}))
