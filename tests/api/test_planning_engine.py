from copy import deepcopy
from datetime import timedelta

import pytest

from app.planning_engine import build_forecast_ledger, calculate_planning, propose_allocation
from app.planning_inputs import PlanningInputsV1, prepare_planning
from planning_support import END, NOW, POLICY, uid, valid_inputs


def plan(data=None):
    return calculate_planning(PlanningInputsV1.model_validate(data or valid_inputs()),POLICY)


def without_protections(data):
    for protection in data["protections"]:
        protection.update(amount_minor=0,routes=[])
    return data


def income(number, day, amount, account=1, confirmed=True):
    return {"id":uid(number),"account_id":uid(account),"at":NOW+timedelta(days=day),
        "amount_minor":amount,"confirmed":confirmed}


def second_account(data, *, first=10000, second=90000):
    data["accounts"].append({**data["accounts"][0],"id":uid(3)})
    data["balances"][0]["amount_minor"] = first
    data["balances"].append({**data["balances"][0],"id":uid(4),"account_id":uid(3),"amount_minor":second})
    return data


def test_full_base_forecast_matches_documented_200_euros():
    result = plan()
    assert result.status=="estimated" and result.amount_minor==20000
    assert result.baseline.consolidated.shortfall_minor==0
    assert result.baseline.consolidated.minimum_headroom_at==NOW+timedelta(days=16)
    assert result.baseline.event_count==1
    assert result.absent_income.amount_minor==result.delayed_income.amount_minor==20000


def test_missing_material_balance_is_null_and_not_a_calculated_zero():
    data = valid_inputs()
    data["balances"] = []
    result = plan(data)
    assert result.status=="blocked" and result.amount_minor is None and result.baseline is None
    assert result.blockers[0].action


def test_early_shortfall_survives_a_large_later_salary():
    data = without_protections(valid_inputs())
    data["balances"][0]["amount_minor"] = 10000
    data["costs"][0].update(at=NOW+timedelta(days=1),amount_minor=15000)
    data["incomes"] = [income(40,7,100000)]
    result = plan(data)
    assert result.status=="estimated" and result.amount_minor==0
    assert result.baseline.consolidated.minimum_headroom_minor==-5000
    assert result.baseline.consolidated.minimum_headroom_at==NOW+timedelta(days=1)


def test_simultaneous_debit_is_protected_before_same_instant_income():
    data = without_protections(valid_inputs())
    data["balances"][0]["amount_minor"] = 10000
    data["costs"][0].update(at=NOW+timedelta(days=1),amount_minor=15000)
    data["incomes"] = [income(40,1,100000)]
    assert plan(data).baseline.consolidated.shortfall_minor==5000


@pytest.mark.parametrize("basis,reflection,opening,expected", [
    ("available","included",75000,65000),
    ("available","excluded",80000,65000),
    ("booked","excluded",80000,65000),
])
def test_pending_is_reserved_once_from_explicit_balance_basis(basis,reflection,opening,expected):
    data = without_protections(valid_inputs())
    data["costs"] = []
    data["balances"][0].update(kind=basis,pending_reflection=reflection,amount_minor=opening)
    data["protections"][3].update(amount_minor=10000,routes=[{"account_id":uid(1),"amount_minor":10000}])
    data["pending"] = [{"id":uid(30),"economic_cost_id":uid(31),"account_id":uid(1),"amount_minor":5000,"state":"pending"}]
    assert plan(data).amount_minor==expected


def test_reversed_and_booked_pending_records_create_no_second_hold():
    data = without_protections(valid_inputs())
    data["costs"] = []
    data["pending"] = [{"id":uid(30),"economic_cost_id":uid(31),"account_id":uid(1),"amount_minor":5000,"state":"reversed"},
        {"id":uid(32),"economic_cost_id":uid(33),"account_id":uid(1),"amount_minor":5000,"state":"booked"}]
    assert plan(data).amount_minor==80000


def test_uncovered_pending_essential_consumes_its_reserve_once():
    data = valid_inputs()
    data["pending"] = [{"id":uid(30),"economic_cost_id":uid(31),"account_id":uid(1),"amount_minor":5000,
        "state":"pending","kind":"essential","consumes":[{"protection_id":uid(10),"amount_minor":5000}]}]
    assert plan(data).amount_minor==20000
    data["balances"][0]["pending_reflection"] = "included"
    assert plan(data).status=="blocked"


def test_funded_repair_releases_only_its_linked_300_euro_reserve():
    data = without_protections(valid_inputs())
    data["protections"][1].update(amount_minor=30000,routes=[{"account_id":uid(1),"amount_minor":30000}])
    data["costs"][0].update(kind="irregular",amount_minor=50000,
        consumes=[{"protection_id":uid(11),"amount_minor":30000}])
    assert plan(data).amount_minor==30000


def test_dated_essentials_consume_the_upfront_budget_instead_of_double_charging():
    data = valid_inputs()
    data["costs"].append({**data["costs"][0],"id":uid(30),"economic_cost_id":uid(31),
        "kind":"essential","amount_minor":15000,"at":NOW+timedelta(days=2),
        "consumes":[{"protection_id":uid(10),"amount_minor":15000}]})
    assert plan(data).amount_minor==20000


def test_opening_reflected_bill_is_not_paid_again_and_overdue_bill_is_immediate():
    data = without_protections(valid_inputs())
    data["costs"][0]["opening_reflected"] = True
    assert plan(data).amount_minor==80000
    data["costs"][0].update(opening_reflected=False,at=NOW-timedelta(days=2))
    result = plan(data)
    assert result.amount_minor==45000 and result.baseline.consolidated.minimum_headroom_at==NOW


def test_protection_endpoint_is_evaluated_inclusively():
    data = valid_inputs()
    data["costs"][0]["at"] = END
    assert plan(data).amount_minor==20000
    assert plan(data).baseline.consolidated.minimum_headroom_at==END


def test_savings_already_in_an_excluded_account_are_not_reserved_again():
    data = valid_inputs()
    data["accounts"].append({**data["accounts"][0],"id":uid(3),"account_type":"restricted","liquid":False,"material":False})
    data["balances"].append({**data["balances"][0],"id":uid(4),"account_id":uid(3),"amount_minor":5000})
    result = plan(data)
    assert result.amount_minor==20000 and result.prepared.excluded_account_ids==[uid(3)]


def test_future_income_cannot_release_upfront_essentials():
    data = valid_inputs()
    data["requested_to_exclusive"] = END
    data["incomes"] = [income(40,1,100000)]
    result = plan(data)
    assert result.baseline.consolidated.minimum_headroom_minor==55000
    assert result.absent_income.amount_minor==20000


def test_speculative_income_is_excluded_from_baseline():
    data = valid_inputs()
    data["incomes"] = [income(40,1,100000,confirmed=False)]
    assert plan(data).amount_minor==20000


def test_income_stress_exposes_deficit_while_baseline_remains_feasible():
    data = without_protections(valid_inputs())
    data["balances"][0]["amount_minor"] = 50000
    data["costs"][0].update(at=NOW+timedelta(days=10),amount_minor=60000)
    data["incomes"] = [income(40,7,100000)]
    result = plan(data)
    assert result.amount_minor==50000
    assert result.absent_income.consolidated.shortfall_minor==10000
    assert result.delayed_income.consolidated.shortfall_minor==10000
    assert result.delayed_income.consolidated.minimum_headroom_at==NOW+timedelta(days=10)


def test_other_bank_money_does_not_silently_cover_the_paying_account():
    data = second_account(without_protections(valid_inputs()))
    data["costs"][0].update(at=NOW+timedelta(days=1),amount_minor=15000)
    result = plan(data)
    assert result.status=="blocked" and result.amount_minor is None
    assert result.baseline.consolidated.surplus_minor==85000
    assert result.baseline.accounts[0].forecast.shortfall_minor==5000
    assert result.blockers[0].code=="ACCOUNT_LIQUIDITY_SHORTFALL"


def test_explicit_feasible_transfer_is_a_separate_conditional_scenario():
    data = second_account(without_protections(valid_inputs()))
    data["costs"][0].update(at=NOW+timedelta(days=1),amount_minor=15000)
    data["transfers"] = [{"id":uid(50),"from_account_id":uid(3),"to_account_id":uid(1),
        "at":NOW,"amount_minor":6000}]
    result = plan(data)
    assert result.status=="blocked" and result.amount_minor is None
    assert result.conditional_transfers.status=="estimated" and result.conditional_transfers.amount_minor==85000
    assert result.conditional_transfers.consolidated.surplus_minor==result.baseline.consolidated.surplus_minor
    assert result.conditional_transfer_ids==[uid(50)]
    assert data["balances"][0]["amount_minor"]==10000


def test_infeasible_transfer_and_same_instant_late_transfer_do_not_fix_guidance():
    data = second_account(without_protections(valid_inputs()),second=1000)
    data["costs"][0].update(at=NOW+timedelta(days=1),amount_minor=15000)
    data["transfers"] = [{"id":uid(50),"from_account_id":uid(3),"to_account_id":uid(1),"at":NOW,"amount_minor":6000}]
    result = plan(data)
    assert result.conditional_transfers.consolidated.shortfall_minor==4000
    data["balances"][1]["amount_minor"] = 90000
    data["transfers"][0]["at"] = NOW+timedelta(days=1)
    assert plan(data).conditional_transfers.status=="blocked"


def test_transfer_has_exactly_zero_consolidated_income_or_spending_effect():
    data = second_account(without_protections(valid_inputs()),first=50000,second=50000)
    data["costs"] = []
    data["transfers"] = [{"id":uid(50),"from_account_id":uid(3),"to_account_id":uid(1),"at":NOW,"amount_minor":1000}]
    result = plan(data)
    assert result.baseline.consolidated.surplus_minor==result.conditional_transfers.consolidated.surplus_minor==100000
    prepared = prepare_planning(PlanningInputsV1.model_validate(data),POLICY)
    ledger = build_forecast_ledger(PlanningInputsV1.model_validate(data),prepared,transfers=True)
    assert len(ledger)==1 and sum(effect.amount_minor for effect in ledger[0].effects)==0


def test_routable_allowance_respects_independent_account_minima():
    data = second_account(without_protections(valid_inputs()),first=20000,second=20000)
    data["costs"][0].update(at=NOW+timedelta(days=1),amount_minor=15000)
    data["costs"].append({**data["costs"][0],"id":uid(30),"economic_cost_id":uid(31),
        "account_id":uid(3),"at":NOW+timedelta(days=4),"amount_minor":35000})
    data["incomes"] = [income(40,1,20000,account=3),income(41,3,20000)]
    result = plan(data)
    assert result.status=="estimated" and result.amount_minor==10000
    assert result.baseline.consolidated.surplus_minor==25000 and result.baseline.routing_limited


def test_shared_allocation_and_accepted_reserve_are_never_double_counted():
    result = plan()
    proposal = propose_allocation(result,desired_discretionary_minor=10000,chosen_savings_minor=5000)
    assert proposal.status=="estimated" and proposal.savings_capacity_minor==10000
    assert proposal.remaining_spending_minor==15000 and not proposal.persisted
    assert proposal.remaining_spending_minor+proposal.chosen_savings_minor==result.amount_minor
    data = valid_inputs()
    data["protections"][2].update(amount_minor=5000,routes=[{"account_id":uid(1),"amount_minor":5000}])
    assert plan(data).amount_minor==15000
    assert plan().amount_minor==20000


def test_savings_choices_require_declared_discretionary_preference():
    result = plan()
    assert propose_allocation(result,desired_discretionary_minor=None).status=="blocked"
    assert propose_allocation(result,desired_discretionary_minor=10000,chosen_savings_minor=10001).status=="blocked"
    assert propose_allocation(result,desired_discretionary_minor=20001,chosen_savings_minor=0).status=="blocked"
    for invalid in (-1,1.5,True):
        with pytest.raises(ValueError):
            propose_allocation(result,desired_discretionary_minor=invalid)


def test_protected_cost_increases_cannot_increase_surplus_and_inputs_are_immutable():
    data = valid_inputs()
    original = deepcopy(data)
    low = plan(data)
    assert data==original
    for amount in (11000,20000,40000,80000):
        changed = deepcopy(data)
        changed["protections"][3].update(amount_minor=amount,routes=[{"account_id":uid(1),"amount_minor":amount}])
        assert plan(changed).amount_minor<=low.amount_minor
        changed = deepcopy(data)
        changed["costs"][0]["amount_minor"] += amount
        assert plan(changed).amount_minor<=low.amount_minor


def test_money_overflow_returns_an_actionable_block_instead_of_float_or_crash():
    data = without_protections(valid_inputs())
    data["balances"][0]["amount_minor"] = 2**53-1
    data["costs"][0].update(at=NOW+timedelta(days=2),amount_minor=1)
    data["incomes"] = [income(40,1,1)]
    result = plan(data)
    assert result.status=="blocked" and result.amount_minor is None
    assert result.blockers[0].code=="MONETARY_RANGE_EXCEEDED"


def test_ledger_ids_are_stable_and_complete_count_is_distinct_from_evidence_sample():
    data = without_protections(valid_inputs())
    data["costs"] = [{**data["costs"][0],"id":uid(100+index),"economic_cost_id":uid(200+index),"amount_minor":1}
        for index in range(30)]
    first, second = plan(data), plan(data)
    assert first.baseline.event_count==30 and len(first.baseline.evidence_entry_ids)==20
    assert first.baseline.evidence_entry_ids==second.baseline.evidence_entry_ids
    assert first.amount_minor==80000-30


def test_reviewed_cost_bounds_have_distinct_protective_and_lower_scenarios():
    data = valid_inputs()
    data["costs"][0].update(amount_basis="reviewed_upper_bound",lower_amount_minor=30000)
    result = plan(data)
    assert result.amount_minor==20000 and result.lower_cost_scenario.amount_minor==25000
    assert result.cost_assumptions[0].interpretation=="deterministic_assumption_not_confidence_interval"


def test_lower_repair_cost_does_not_release_more_reserve_than_the_actual_outflow():
    data = without_protections(valid_inputs())
    data["protections"][1].update(amount_minor=30000,routes=[{"account_id":uid(1),"amount_minor":30000}])
    data["costs"][0].update(kind="irregular",amount_minor=50000,amount_basis="reviewed_upper_bound",lower_amount_minor=20000,
        consumes=[{"protection_id":uid(11),"amount_minor":30000}])
    result = plan(data)
    assert result.amount_minor==30000 and result.lower_cost_scenario.amount_minor==50000


def test_a_known_protective_upper_bound_does_not_invent_a_lower_bound():
    data = valid_inputs()
    data["costs"][0]["amount_basis"] = "reviewed_upper_bound"
    result = plan(data)
    assert result.amount_minor==20000 and result.lower_cost_scenario is None
    assert result.cost_assumptions[0].reviewed_lower_amount_minor is None


@pytest.mark.parametrize("changes,code", [({"amount_basis":"unreviewed"},"UNCERTAIN_COST_UNREVIEWED"),
    ({"lower_amount_minor":35001},"COST_RANGE_INVALID")])
def test_material_unreviewed_or_inverted_cost_range_blocks_guidance(changes,code):
    data = valid_inputs()
    data["costs"][0].update(changes)
    result = plan(data)
    assert result.status=="blocked" and result.amount_minor is None
    assert code in {item.code for item in result.blockers}
