from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from pydantic import ValidationError
import pytest

from app.planning_policy import IncomeTimingV1, PlanningPolicyV1, calendar_window, protection_period
from app.settings import Settings

ZONE = ZoneInfo("Europe/Helsinki")
NOW = datetime(2026,11,4,tzinfo=ZONE)
POLICY = PlanningPolicyV1()


def test_this_week_and_fallback_are_distinct_exact_boundaries():
    result = protection_period(NOW, POLICY)
    assert result.requested_from==NOW
    assert result.requested_to_exclusive.astimezone(ZONE)==datetime(2026,11,9,tzinfo=ZONE)
    assert result.protection_through.astimezone(ZONE)==datetime(2026,12,4,tzinfo=ZONE)
    assert result.reason=="minimum_fallback" and not result.background_required


def test_monday_still_protects_the_coming_week():
    monday = datetime(2026,11,9,tzinfo=ZONE)
    assert protection_period(monday,POLICY).requested_to_exclusive.astimezone(ZONE)==monday+timedelta(days=7)


def test_earliest_future_confirmed_income_controls_protection():
    incomes = [IncomeTimingV1(at=NOW+timedelta(days=20),confirmed=True),
        IncomeTimingV1(at=NOW+timedelta(days=1),confirmed=False),
        IncomeTimingV1(at=NOW-timedelta(days=1),confirmed=True),
        IncomeTimingV1(at=NOW+timedelta(days=3),confirmed=True)]
    result = protection_period(NOW,POLICY,incomes=incomes)
    assert result.next_confirmed_income_at==NOW+timedelta(days=3)
    assert result.protection_through==NOW+timedelta(days=10)
    assert result.reason=="confirmed_income_plus_seven_days"


def test_requested_end_can_extend_beyond_the_income_protection():
    result = protection_period(NOW,POLICY,requested_to_exclusive=NOW+timedelta(days=40),
        incomes=[IncomeTimingV1(at=NOW+timedelta(days=1),confirmed=True)])
    assert result.protection_through==NOW+timedelta(days=40)


def test_long_scenarios_are_flagged_without_truncation():
    end = NOW+timedelta(days=180)
    result = protection_period(NOW,POLICY,requested_to_exclusive=end)
    assert result.background_required and result.protection_through==end


def test_distant_confirmed_income_can_require_background_work():
    result = protection_period(NOW,POLICY,incomes=[IncomeTimingV1(at=NOW+timedelta(days=100),confirmed=True)])
    assert result.background_required and result.protection_through==NOW+timedelta(days=107)


def test_calendar_windows_cover_year_and_leap_boundaries():
    january = calendar_window(datetime(2027,1,1,tzinfo=ZONE),"last_month",POLICY)
    assert (january.start,january.end_exclusive)==(date(2026,12,1),date(2027,1,1))
    march = calendar_window(datetime(2028,3,15,tzinfo=ZONE),"last_month",POLICY)
    assert (march.end_exclusive-march.start).days==29


def test_helsinki_date_uses_local_midnight_not_utc_date():
    instant = datetime(2026,10,31,22,30,tzinfo=timezone.utc)
    result = calendar_window(instant,"last_month",POLICY)
    assert (result.start,result.end_exclusive)==(date(2026,10,1),date(2026,11,1))


@pytest.mark.parametrize("day,hours", [(datetime(2026,3,25,tzinfo=ZONE),167),
    (datetime(2026,10,21,tzinfo=ZONE),169)])
def test_calendar_weeks_preserve_dst_instead_of_assuming_168_hours(day,hours):
    result = calendar_window(day,"this_week",POLICY)
    assert (result.to_instant_exclusive-result.from_instant).total_seconds()/3600==hours
    assert result.from_instant.astimezone(ZONE).hour==0
    assert result.to_instant_exclusive.astimezone(ZONE).hour==0


def test_fallback_uses_thirty_local_calendar_days_across_dst():
    now = datetime(2026,3,15,12,tzinfo=ZONE)
    end = protection_period(now,POLICY).protection_through
    assert end.astimezone(ZONE)==datetime(2026,4,14,12,tzinfo=ZONE)
    assert end-now.astimezone(timezone.utc)==timedelta(days=30,hours=-1)


@pytest.mark.parametrize("value", [datetime(2026,11,4), NOW-timedelta(seconds=1), NOW])
def test_invalid_requested_instants_are_rejected(value):
    with pytest.raises(ValueError):
        protection_period(NOW,POLICY,requested_to_exclusive=value)


def test_missing_inputs_do_not_gain_fabricated_money_defaults():
    assert POLICY.buffer_policy=="explicit_reviewed_amount_no_default"
    assert POLICY.pending_policy=="explicit_coverage_or_block"
    assert POLICY.routing_policy=="explicit_per_account_exact_totals"
    assert not any(name.endswith("minor") for name in type(POLICY).model_fields)


def test_settings_are_the_single_source_of_configurable_thresholds():
    settings = Settings(balance_maximum_age_hours=12,fallback_horizon_days=45,interactive_horizon_days=60)
    policy = PlanningPolicyV1.from_settings(settings)
    assert (policy.balance_maximum_age_hours,policy.fallback_horizon_days,policy.interactive_horizon_days)==(12,45,60)
    with pytest.raises(ValidationError):
        PlanningPolicyV1(timezone="not/a/timezone")
    with pytest.raises(ValidationError):
        PlanningPolicyV1(fallback_horizon_days=0)
    with pytest.raises(ValidationError):
        PlanningPolicyV1(balance_maximum_age_hours=True)
