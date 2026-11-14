"""Public, fixed-clock synthetic fixture. No user selection or private bank data."""
import json
from datetime import datetime
from pathlib import Path
from uuid import UUID, NAMESPACE_URL, uuid5

from pydantic import AwareDatetime, computed_field

from .contracts import Account, BalanceSnapshot, Contract, Transaction, NonnegativeMinor

ROOT = Path(__file__).resolve().parents[3]


def demo_id(name: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"https://moneylens.invalid/synthetic/{name}")


class Profile(Contract):
    mode: str = "synthetic"
    name: str
    fixture_version: str
    as_of: AwareDatetime
    accounts: list[Account]
    balances: list[BalanceSnapshot]
    transactions: list[Transaction]
    bills_minor: NonnegativeMinor
    essentials_minor: NonnegativeMinor
    buffer_minor: NonnegativeMinor

    @computed_field
    @property
    def available_balance_minor(self) -> int:
        return sum(item.amount_minor - item.included_credit_minor for item in self.balances)

    @computed_field
    @property
    def october_spending(self) -> dict[str, int]:
        totals: dict[str, int] = {}
        for tx in self.transactions:
            if tx.status == "booked" and "2026-10-01" <= tx.booked_on.isoformat() < "2026-11-01" and tx.economic_flow in ("expense", "refund"):
                totals[tx.category] = totals.get(tx.category, 0) - tx.amount_minor
        return totals

    @computed_field
    @property
    def october_taxi_count(self) -> int:
        return sum(1 for tx in self.transactions if tx.status == "booked" and tx.category == "taxi" and "2026-10-01" <= tx.booked_on.isoformat() < "2026-11-01")


def profile() -> Profile:
    raw = json.loads((ROOT / "fixtures/synthetic/demo.v1.json").read_text(encoding="utf-8"))
    # Other profiles exist solely for ownership/security fixtures, not this public endpoint.
    return Profile.model_validate(raw["profiles"][0])
