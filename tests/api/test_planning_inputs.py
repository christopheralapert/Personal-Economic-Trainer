from copy import deepcopy
from datetime import timedelta

from pydantic import ValidationError
import pytest

from app.planning_inputs import PlanningInputsV1, prepare_planning
from planning_support import END, NOW, POLICY, uid, valid_inputs


def check(data=None):
    return prepare_planning(PlanningInputsV1.model_validate(valid_inputs() if data is None else data),POLICY)


def codes(result):
    return {item.code for item in result.blockers}


def test_reviewed_synthetic_input_is_ready_and_explicitly_attributed():
    result = check()
    assert result.status=="ready" and result.openings[0].own_funds_minor==80000
    assert result.blockers==[] and "Synthetic" in result.assumptions[0]
    assert result.period.protection_through==END


@pytest.mark.parametrize("target,field,value,code", [
    ("accounts","synced_at",None,"SYNC_STALE_OR_MISSING"),
    ("accounts","synced_at",NOW-timedelta(hours=25),"SYNC_STALE_OR_MISSING"),
    ("accounts","synced_at",NOW+timedelta(minutes=6),"SYNC_IN_FUTURE"),
    ("accounts","coverage","unknown","ACCOUNT_COVERAGE_UNKNOWN"),
    ("accounts","coverage_through",NOW-timedelta(seconds=1),"ACCOUNT_COVERAGE_UNKNOWN"),
    ("accounts","currency","USD","UNSUPPORTED_CURRENCY"),
    ("balances","observed_at",NOW-timedelta(hours=25),"BALANCE_STALE"),
    ("balances","observed_at",NOW+timedelta(minutes=6),"BALANCE_IN_FUTURE"),
    ("balances","currency","USD","BALANCE_CURRENCY_MISMATCH"),
    ("balances","pending_reflection","unknown","PENDING_BASIS_UNKNOWN"),
    ("balances","included_credit_minor",None,"OWN_FUNDS_COMPONENTS_UNKNOWN"),
    ("balances","inaccessible_minor",None,"OWN_FUNDS_COMPONENTS_UNKNOWN"),
    ("balances","included_credit_minor",80001,"INVALID_BALANCE_COMPONENTS"),
    ("protections","amount_minor",None,"PROTECTION_AMOUNT_UNKNOWN"),
    ("protections","reviewed_through",NOW,"PROTECTION_HORIZON_UNREVIEWED"),
    ("protections","routes",None,"PROTECTION_ROUTING_UNRESOLVED"),
    ("protections","routes",[],"PROTECTION_ROUTING_UNRESOLVED"),
    ("costs","account_id",uid(99),"PAYING_ACCOUNT_UNAVAILABLE"),
    ("costs","at",END+timedelta(seconds=1),"COST_OUTSIDE_HORIZON"),
])
def test_material_unknown_or_invalid_input_blocks_precise_guidance(target,field,value,code):
    data = valid_inputs()
    data[target][0][field] = value
    result = check(data)
    assert result.status=="blocked" and result.openings is None
    assert code in codes(result)
    assert all(item.action for item in result.blockers)


def test_absent_and_duplicate_balances_are_not_inferred_from_history():
    for balances in ([],valid_inputs()["balances"]*2):
        data = valid_inputs()
        data["balances"] = balances
        assert "BALANCE_MISSING_OR_AMBIGUOUS" in codes(check(data))


def test_booked_balance_cannot_claim_pending_debits_are_already_included():
    data = valid_inputs()
    data["balances"][0]["kind"] = "booked"
    data["balances"][0]["pending_reflection"] = "included"
    assert "PENDING_BASIS_UNKNOWN" in codes(check(data))


def test_credit_and_inaccessible_funds_are_removed_without_reconstructing_balance():
    data = valid_inputs()
    data["balances"][0].update(included_credit_minor=10000,inaccessible_minor=5000)
    result = check(data)
    assert result.status=="ready" and result.openings[0].own_funds_minor==65000
    assert result.openings[0].excluded_credit_minor==10000


def test_negative_own_cash_is_preserved_for_shortfall_calculation():
    data = valid_inputs()
    data["balances"][0]["amount_minor"] = -5000
    assert check(data).openings[0].own_funds_minor==-5000


def test_credit_account_does_not_supply_cash_and_unreviewed_settlement_blocks():
    data = valid_inputs()
    credit = {**data["accounts"][0],"id":uid(3),"account_type":"credit","liquid":False}
    data["accounts"].append(credit)
    assert "LIABILITY_COVERAGE_UNKNOWN" in codes(check(data))
    credit["liability_covered"] = True
    result = check(data)
    assert result.status=="ready" and result.excluded_account_ids==[uid(3)]
    assert len(result.openings)==1


def test_missing_budget_and_obligation_review_are_not_zero_defaults():
    data = valid_inputs()
    data["protections"] = data["protections"][1:]
    data["obligations_reviewed_through"] = None
    result = check(data)
    assert {"PROTECTION_AMOUNT_UNKNOWN","OBLIGATIONS_UNREVIEWED"}<=codes(result)


def test_routed_protection_sum_is_exact_and_no_account_is_counted_twice():
    for routes in ([{"account_id":uid(1),"amount_minor":14999}],
        [{"account_id":uid(1),"amount_minor":7500}]*2,
        [{"account_id":uid(99),"amount_minor":15000}]):
        data = valid_inputs()
        data["protections"][0]["routes"] = routes
        assert check(data).status=="blocked"


def test_pending_and_future_bill_cannot_repeat_one_economic_cost():
    data = valid_inputs()
    data["pending"] = [{"id":uid(30),"account_id":uid(1),"amount_minor":35000,
        "state":"pending","economic_cost_id":uid(21)}]
    assert "DUPLICATE_COST_EFFECT" in codes(check(data))
    data["pending"][0]["state"] = "reversed"
    assert check(data).status=="ready"


def test_reservations_cannot_be_consumed_twice_or_from_the_wrong_account():
    data = valid_inputs()
    data["costs"][0]["consumes"] = [{"protection_id":uid(10),"amount_minor":15000}]
    assert check(data).status=="ready"
    extra = deepcopy(data["costs"][0])
    extra.update(id=uid(31),economic_cost_id=uid(32))
    data["costs"].append(extra)
    assert "RESERVATION_OVERCONSUMED" in codes(check(data))


def test_buffer_and_saved_commitments_are_not_released_for_unrelated_bills():
    data = valid_inputs()
    data["costs"][0]["consumes"] = [{"protection_id":uid(13),"amount_minor":10000}]
    assert "INVALID_RESERVATION_LINK" in codes(check(data))
    data["costs"][0]["consumes"] = [{"protection_id":uid(12),"amount_minor":0}]
    assert "RESERVATION_PURPOSE_MISMATCH" in codes(check(data))


def test_already_reflected_bill_cannot_release_another_current_reserve():
    data = valid_inputs()
    data["costs"][0].update(opening_reflected=True,consumes=[{"protection_id":uid(10),"amount_minor":1000}])
    assert "OPENING_COST_RELEASES_RESERVE" in codes(check(data))


def test_no_liquid_account_and_unknown_ids_are_actionable_blockers():
    data = valid_inputs()
    data["accounts"] = []
    result = check(data)
    assert {"NO_LIQUID_ACCOUNT","UNKNOWN_BALANCE_ACCOUNT","PAYING_ACCOUNT_UNAVAILABLE"}<=codes(result)


def test_long_request_retains_full_horizon_but_blocks_interactive_execution():
    data = valid_inputs()
    data["requested_to_exclusive"] = NOW+timedelta(days=180)
    result = check(data)
    assert "BACKGROUND_SCENARIO_REQUIRED" in codes(result)
    assert result.period.protection_through==NOW+timedelta(days=180)


def test_absent_explicit_components_and_float_money_are_schema_errors():
    data = valid_inputs()
    del data["balances"][0]["included_credit_minor"]
    with pytest.raises(ValidationError):
        PlanningInputsV1.model_validate(data)
    data = valid_inputs()
    data["balances"][0]["amount_minor"] = 80000.5
    with pytest.raises(ValidationError):
        PlanningInputsV1.model_validate(data)
