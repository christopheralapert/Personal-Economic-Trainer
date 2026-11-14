from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.planning import ForecastEvent, forecast, reduction

NOW = datetime(2026, 11, 3, 22, tzinfo=timezone.utc)
END = NOW + timedelta(days=30)


def event(day, amount, kind="outflow", reserve=0):
    return ForecastEvent(at=NOW + timedelta(days=day), amount_minor=amount, kind=kind,
                         reservation_consumed_minor=reserve)


def test_base_fixture_surplus_is_200_euros():
    result = forecast(80000, 15000, 10000, NOW, END, [event(16, -35000)])
    assert result.surplus_minor == 20000
    assert result.shortfall_minor == 0


def test_early_shortfall_is_not_hidden_by_payday():
    result = forecast(10000, 0, 0, NOW, END, [event(1,-15000), event(3,20000,"income")])
    assert result.surplus_minor == 0
    assert result.shortfall_minor == 5000
    assert result.minimum_headroom_at == NOW + timedelta(days=1)


def test_same_day_debits_precede_income():
    result = forecast(10000, 0, 0, NOW, END, [event(1,20000,"income"), event(1,-15000)])
    assert result.shortfall_minor == 5000


def test_linked_irregular_bill_consumes_reserve_once():
    result = forecast(80000, 30000, 0, NOW, END, [event(2,-50000,reserve=30000)])
    assert result.surplus_minor == 30000


def test_consuming_an_essential_budget_does_not_charge_it_twice():
    result = forecast(80000, 15000, 10000, NOW, END, [event(2,-15000,reserve=15000), event(16,-35000)])
    assert result.surplus_minor == 20000


def test_a_reserve_cannot_be_released_by_income():
    with pytest.raises(ValueError):
        forecast(10000, 5000, 0, NOW, END, [event(2,10000,"income",reserve=5000)])


def test_more_reserve_cannot_be_consumed_than_exists():
    with pytest.raises(ValueError):
        forecast(10000, 1000, 0, NOW, END, [event(2,-5000,reserve=2000)])


def test_event_outside_horizon_is_not_silently_dropped():
    with pytest.raises(ValueError):
        forecast(10000, 0, 0, NOW, END, [event(31,-1000)])


def test_delayed_income_exposes_shortfall():
    baseline = forecast(50000, 0, 0, NOW, END, [event(7,100000,"income"),event(10,-60000)])
    stress = forecast(50000, 0, 0, NOW, END, [event(12,100000,"income"),event(10,-60000)])
    assert baseline.surplus_minor == 50000
    assert stress.shortfall_minor == 10000


def test_higher_buffer_never_increases_surplus():
    low = forecast(80000, 15000, 10000, NOW, END, [event(16,-35000)])
    high = forecast(80000, 15000, 20000, NOW, END, [event(16,-35000)])
    assert high.surplus_minor < low.surplus_minor


def test_dining_scenario_uses_decimal_round_half_up():
    assert reduction(25000, Decimal(20),12) == (5000,60000)
    assert reduction(5, Decimal(10),1) == (1,1)


@pytest.mark.parametrize("percent", [Decimal(-1), Decimal(101), Decimal("NaN")])
def test_invalid_scenarios_fail(percent):
    with pytest.raises(ValueError):
        reduction(25000,percent)
