"""Pure deterministic forecast primitives; no model or bank access."""
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal

from pydantic import AwareDatetime, Field, StrictInt

from .contracts import Contract, Minor, NonnegativeMinor


class ForecastEvent(Contract):
    at: AwareDatetime
    amount_minor: Minor
    kind: Literal["income", "outflow"]
    reservation_consumed_minor: NonnegativeMinor = 0

    def validate_effect(self) -> None:
        if self.kind == "income" and (self.amount_minor < 0 or self.reservation_consumed_minor):
            raise ValueError("Income cannot consume a reservation or be negative")
        if self.kind == "outflow" and (self.amount_minor > 0 or self.reservation_consumed_minor > -self.amount_minor):
            raise ValueError("An outflow consumes at most its absolute amount")


class Forecast(Contract):
    minimum_headroom_minor: Minor
    minimum_headroom_at: AwareDatetime
    surplus_minor: NonnegativeMinor
    shortfall_minor: NonnegativeMinor


def forecast(opening_minor: int, reserved_minor: int, buffer_minor: int,
             as_of: datetime, through: datetime, events: list[ForecastEvent]) -> Forecast:
    if any(type(x) is not int for x in (opening_minor, reserved_minor, buffer_minor)):
        raise ValueError("Money inputs must be integer minor units")
    if min(reserved_minor, buffer_minor) < 0:
        raise ValueError("Protections cannot be negative")
    if as_of.utcoffset() is None or through.utcoffset() is None or through <= as_of:
        raise ValueError("An ordered timezone-aware horizon is required")
    cash, reservation = opening_minor, reserved_minor
    minimum, minimum_at = cash - reservation - buffer_minor, as_of
    # On a shared timestamp, debits precede credits conservatively.
    for event in sorted(events, key=lambda item: (item.at, item.kind == "income")):
        event.validate_effect()
        if not as_of <= event.at <= through:
            raise ValueError("Forecast events must fall within the explicit horizon")
        if event.reservation_consumed_minor > reservation:
            raise ValueError("Cannot consume more than the remaining reservation")
        cash += event.amount_minor
        reservation -= event.reservation_consumed_minor
        headroom = cash - reservation - buffer_minor
        if headroom < minimum:
            minimum, minimum_at = headroom, event.at
    return Forecast(minimum_headroom_minor=minimum, minimum_headroom_at=minimum_at,
                    surplus_minor=max(0, minimum), shortfall_minor=max(0, -minimum))


def reduction(baseline_minor: int, percent: Decimal, months: int = 12) -> tuple[int, int]:
    if type(baseline_minor) is not int or baseline_minor < 0:
        raise ValueError("Baseline must be nonnegative integer minor units")
    if not percent.is_finite() or not 0 <= percent <= 100:
        raise ValueError("Reduction must be between zero and 100 percent")
    if type(months) is not int or not 1 <= months <= 120:
        raise ValueError("Choose between 1 and 120 months")
    monthly = int((Decimal(baseline_minor) * percent / 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return monthly, monthly * months
