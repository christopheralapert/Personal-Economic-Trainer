from datetime import datetime, timezone
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.contracts import Analysis, Evidence, FinancialResult, Money, Period
from app.settings import Settings


@pytest.mark.parametrize("value", [1.5, True, "100", 2**53])
def test_money_rejects_unsafe_or_coerced_values(value):
    with pytest.raises(ValidationError):
        Money(amount_minor=value, currency="EUR")


def test_money_preserves_signed_minor_units():
    assert Money(amount_minor=-1290).amount_minor == -1290


def test_unknown_contract_fields_are_rejected():
    with pytest.raises(ValidationError):
        Money(amount_minor=100, tenant_id="client-chosen")


def test_period_requires_an_exclusive_ordered_end():
    with pytest.raises(ValidationError):
        Period(start="2026-11-04", end_exclusive="2026-11-04")


def test_blocked_analysis_cannot_claim_an_available_amount():
    with pytest.raises(ValidationError):
        Analysis(calculation_id=uuid4(), status="blocked", as_of=datetime.now(timezone.utc),
                 result=FinancialResult(amount_minor=100),
                 evidence=Evidence(snapshot_id="test", data_version=1))


def test_demo_cannot_be_implicitly_enabled_in_production():
    with pytest.raises(ValidationError):
        Settings(environment="production", allow_demo=True)
    assert Settings(environment="production", allow_demo=False).allow_demo is False


def test_live_mode_is_not_a_fake_configuration_switch():
    with pytest.raises(ValidationError):
        Settings(data_mode="live")
