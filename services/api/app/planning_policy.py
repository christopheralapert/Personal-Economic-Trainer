"""Versioned conservative planning policy and calendar-aware protection periods."""
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AwareDatetime, Field, StrictBool, StrictInt, model_validator

from .contracts import Contract


class PlanningPolicyV1(Contract):
    calculation_version: Literal[1] = 1
    timezone: str = "Europe/Helsinki"
    currency: Literal["EUR"] = "EUR"
    balance_maximum_age_hours: StrictInt = Field(default=24, ge=1, le=168)
    maximum_future_skew_seconds: StrictInt = Field(default=300, ge=0, le=300)
    fallback_horizon_days: StrictInt = Field(default=30, ge=30, le=90)
    income_protection_days: Literal[7] = 7
    interactive_horizon_days: StrictInt = Field(default=90, ge=30, le=365)
    reservation_policy: Literal["full_horizon_upfront_linked_consumption"] = "full_horizon_upfront_linked_consumption"
    pending_policy: Literal["explicit_coverage_or_block"] = "explicit_coverage_or_block"
    routing_policy: Literal["explicit_per_account_exact_totals"] = "explicit_per_account_exact_totals"
    own_funds_policy: Literal["liquid_own_funds_only"] = "liquid_own_funds_only"
    missing_input_policy: Literal["block_material_unknowns"] = "block_material_unknowns"
    buffer_policy: Literal["explicit_reviewed_amount_no_default"] = "explicit_reviewed_amount_no_default"

    @model_validator(mode="after")
    def valid_zone(self):
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Use an available IANA timezone") from None
        return self

    @classmethod
    def from_settings(cls, settings, **overrides):
        return cls(balance_maximum_age_hours=settings.balance_maximum_age_hours,
            fallback_horizon_days=settings.fallback_horizon_days,
            interactive_horizon_days=settings.interactive_horizon_days, **overrides)


class IncomeTimingV1(Contract):
    at: AwareDatetime
    confirmed: StrictBool


class CalendarWindowV1(Contract):
    start: date
    end_exclusive: date
    from_instant: AwareDatetime
    to_instant_exclusive: AwareDatetime
    timezone: str


class ProtectionPeriodV1(Contract):
    as_of: AwareDatetime
    requested_from: AwareDatetime
    requested_to_exclusive: AwareDatetime
    protection_through: AwareDatetime
    next_confirmed_income_at: AwareDatetime | None
    reason: Literal["confirmed_income_plus_seven_days", "minimum_fallback"]
    timezone: str
    background_required: bool


def utc(value):
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise ValueError("An explicit timezone-aware instant is required")
    return value.astimezone(timezone.utc)


def local_boundary(value, zone):
    instant = datetime.combine(value, time.min, zone)
    if instant.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)!=instant.replace(tzinfo=None):
        raise ValueError("This local calendar boundary does not exist; choose an explicit instant")
    return instant.astimezone(timezone.utc)


def calendar_window(as_of, kind, policy, *, start=None, end_exclusive=None):
    zone = ZoneInfo(policy.timezone)
    today = utc(as_of).astimezone(zone).date()
    if kind=="this_week":
        first, last = today-timedelta(days=today.weekday()), today+timedelta(days=7-today.weekday())
    elif kind=="last_month":
        last = today.replace(day=1)
        first = (last-timedelta(days=1)).replace(day=1)
    elif kind=="this_month":
        first = today.replace(day=1)
        last = (first.replace(day=28)+timedelta(days=4)).replace(day=1)
    elif kind=="custom" and type(start) is date and type(end_exclusive) is date:
        first, last = start, end_exclusive
    else:
        raise ValueError("Choose a supported calendar period or explicit date boundaries")
    if first>=last:
        raise ValueError("The calendar period must be ordered")
    return CalendarWindowV1(start=first, end_exclusive=last, from_instant=local_boundary(first, zone),
        to_instant_exclusive=local_boundary(last, zone), timezone=policy.timezone)


def protection_period(as_of, policy, *, requested_to_exclusive=None, incomes=()):
    now = utc(as_of)
    zone = ZoneInfo(policy.timezone)
    local_now = now.astimezone(zone)
    requested_end = utc(requested_to_exclusive) if requested_to_exclusive is not None else calendar_window(now, "this_week", policy).to_instant_exclusive
    if requested_end<=now:
        raise ValueError("Planning requires a requested end after the calculation instant")
    reliable = [utc(item.at) for item in incomes if item.confirmed and utc(item.at)>now]
    next_income = min(reliable) if reliable else None
    if next_income is not None:
        protected_end = next_income.astimezone(zone)+timedelta(days=policy.income_protection_days)
        reason = "confirmed_income_plus_seven_days"
    else:
        protected_end = local_now+timedelta(days=policy.fallback_horizon_days)
        reason = "minimum_fallback"
    through = max(requested_end, protected_end.astimezone(timezone.utc))
    interactive_end = (local_now+timedelta(days=policy.interactive_horizon_days)).astimezone(timezone.utc)
    return ProtectionPeriodV1(as_of=now, requested_from=now, requested_to_exclusive=requested_end,
        protection_through=through, next_confirmed_income_at=next_income, reason=reason,
        timezone=policy.timezone, background_required=through>interactive_end)
