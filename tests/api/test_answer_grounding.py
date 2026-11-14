from copy import deepcopy
from datetime import datetime,timedelta,timezone
import json
from pathlib import Path

import pytest

from app.analysis_tool_finance import PlanningReadV1,PlanningToolSnapshotV1,BankConnectionsReadV1
from app.analysis_tools import (SpendingToolResultV1,SpendingReductionToolResultV1,SpendingComparisonToolResultV1,
    PlanningReadToolResultV1,BankConnectionsToolResultV1)
from app.answer_grounding import AnswerClaimV1,ground_answer
from app.identity import AuthError
from app.spending_comparison import compare_spending
from app.spending_scenario import spending_reduction
from test_spending_scenario import baseline,request
from test_spending_comparison import totals

NOW=datetime(2026,11,5,10,tzinfo=timezone.utc)


def observed(): return SpendingToolResultV1(result=baseline())


def saved_plan():
    fixture=json.loads((Path(__file__).resolve().parents[2]/"fixtures/synthetic/planning-ui.v1.json").read_bytes())
    source=fixture["states"]["saved"]["plan"]
    fields=("id","state","current","data_version","plan_version","as_of","expires_at","analysis")
    plan=PlanningToolSnapshotV1(**{key:source[key] for key in fields},period=source["calculation"]["prepared"]["period"])
    return PlanningReadToolResultV1(result=PlanningReadV1(evaluated_at=fixture["clock"],plan=plan,limitations=[]))


def test_exact_fact_values_dates_meanings_and_evidence_digest_are_reproducible_and_independent():
    result=observed();before=result.model_dump(mode="json")
    answer=ground_answer(result)
    assert answer.status=="ready" and answer.presentation=="observed_spending"
    assert answer.claims_status=="not_requested" and not answer.accepted_fact_ids
    assert {fact.fact_id:fact.value for fact in answer.facts}["net_minor"]==25000
    assert ground_answer(result).evidence_sha256==answer.evidence_sha256
    for fact in answer.facts:
        node=answer.artifact.model_dump(mode="json")
        for key in fact.source_pointer.split("/")[1:]: node=node[key]
        assert node==fact.value
    answer.artifact.result.scope.account_ids.clear()
    assert result.model_dump(mode="json")==before


@pytest.mark.parametrize("change",[{"value":99999},{"value":0},{"currency":"USD"},{"meaning":"reviewed_shared_surplus"},
    {"fact_id":"missing"},{"value":True},{"kind":"count","currency":None}])
def test_hallucinated_amount_currency_meaning_and_unit_claims_are_replaced(change):
    result=observed();fact=ground_answer(result).facts[2]
    claim={**fact.model_dump(include=set(AnswerClaimV1.model_fields)),**change}
    answer=ground_answer(result,[claim])
    assert answer.claims_status=="replaced" and not answer.accepted_fact_ids
    assert answer.facts[2].value==25000 and answer.artifact==result


def test_matching_claims_are_accepted_but_dates_duplicates_empty_and_oversized_batches_are_replaced():
    result=observed();facts=ground_answer(result).facts
    claims=[fact.model_dump(include=set(AnswerClaimV1.model_fields)) for fact in (facts[2],facts[-1])]
    accepted=ground_answer(result,claims)
    assert accepted.claims_status=="accepted" and accepted.accepted_fact_ids==["net_minor","window.end"]
    wrong_date=deepcopy(claims);wrong_date[1]["value"]="2026-12-01"
    for invalid in (wrong_date,[claims[0],claims[0]],[],claims*11,"untrusted sentence",[{**claims[0],"sql":"select secret"}]):
        assert ground_answer(result,invalid).claims_status=="replaced"


def test_incomplete_history_zero_and_refunds_retain_their_original_observation_scope():
    source=baseline(0,100);source.scope.dataset_coverage="unverified";source.unresolved_flow_count=1
    answer=ground_answer(SpendingToolResultV1(result=source))
    assert answer.status=="limited" and set(answer.reasons)=={"INCOMPLETE_HISTORY","UNRESOLVED_FLOWS"}
    assert answer.facts[2].value==-100 and answer.facts[2].meaning=="net_observed_spending"
    assert ground_answer(SpendingToolResultV1(result=baseline(0,0))).facts[2].value==0


def test_historical_counterfactual_never_becomes_saving_capacity_and_blocked_amounts_stay_null():
    result=SpendingReductionToolResultV1(result=spending_reduction(request(),baseline(),now=NOW))
    answer=ground_answer(result)
    assert answer.facts[1].value==5000 and answer.facts[1].interpretation=="hypothetical"
    assert answer.facts[1].meaning=="hypothetical_cost_reduction"
    limited=baseline();limited.scope.dataset_coverage="unverified"
    blocked=ground_answer(SpendingReductionToolResultV1(result=spending_reduction(request(),limited,now=NOW)))
    assert blocked.status=="blocked" and blocked.facts[1].value is None and blocked.facts[2].value is None


def test_comparison_dates_changes_and_unavailable_percentage_remain_exact():
    result=SpendingComparisonToolResultV1(result=compare_spending(totals(net=100),totals(start="2026-09-01",end="2026-10-01",net=0),"previous_month"))
    answer=ground_answer(result)
    assert answer.facts[2].value==100 and answer.facts[3].value is None
    assert answer.facts[-2].value=="2026-09-01" and answer.facts[-1].value=="2026-10-01"
    result.result.baseline.scope.data_version+=1
    with pytest.raises(AuthError,match="GROUNDING_EVIDENCE_INVALID"): ground_answer(result)


def test_current_plan_preserves_shared_surplus_and_separate_protection_dates_but_missing_plan_is_unknown():
    result=saved_plan();answer=ground_answer(result)
    assert answer.presentation=="reviewed_plan" and answer.status=="ready"
    assert answer.facts[0].value==20000 and answer.facts[0].meaning=="reviewed_shared_surplus"
    assert answer.facts[-2].meaning=="requested_until_exclusive" and answer.facts[-1].meaning=="protected_through"
    assert answer.facts[-2].value!=answer.facts[-1].value
    result.result.plan=None
    missing=ground_answer(result)
    assert missing.status=="blocked" and missing.reasons==["PLAN_MISSING"] and not missing.facts


def test_forged_stale_plan_or_inconsistent_spending_cannot_become_a_grounded_answer():
    plan=saved_plan();plan.result.plan.current=False
    with pytest.raises(AuthError,match="GROUNDING_EVIDENCE_INVALID"): ground_answer(plan)
    result=observed();result.result.net_minor+=1
    with pytest.raises(AuthError,match="GROUNDING_EVIDENCE_INVALID"): ground_answer(result)


def test_other_registered_tools_keep_the_typed_artifact_without_invented_financial_facts():
    result=BankConnectionsToolResultV1(result=BankConnectionsReadV1(evaluated_at=NOW,rows=[],limitations=[]))
    answer=ground_answer(result)
    assert answer.status=="limited" and answer.reasons==["FACT_PROJECTION_NOT_IMPLEMENTED"]
    assert answer.artifact==result and not answer.facts


@pytest.mark.parametrize("field,value",[("net_change_basis_points",10000),("percentage_unavailable_reason","baseline_not_positive"),("gross_minor",9999)])
def test_comparison_cannot_relabel_a_derived_percentage_or_delta(field,value):
    result=SpendingComparisonToolResultV1(result=compare_spending(totals(net=150),totals(start="2026-09-01",end="2026-10-01",net=100),"previous_month"))
    setattr(result.result.change,field,value)
    with pytest.raises(AuthError,match="GROUNDING_EVIDENCE_INVALID"): ground_answer(result)


@pytest.mark.parametrize("change",["scope","coverage","duration"])
def test_comparison_scope_coverage_and_period_labels_are_rebuilt(change):
    result=SpendingComparisonToolResultV1(result=compare_spending(totals(net=150),totals(start="2026-09-01",end="2026-10-01",net=100),"previous_month"))
    if change=="scope": result.result.baseline.evidence_filters.merchant="Other merchant"
    elif change=="coverage": result.result.baseline.scope.dataset_coverage="unverified"
    else: result.result.current_calendar_days=30
    with pytest.raises(AuthError,match="GROUNDING_EVIDENCE_INVALID"): ground_answer(result)


@pytest.mark.parametrize("change",["formula","currency","history"])
def test_counterfactual_rejects_arithmetically_reconciled_but_unsupported_reductions(change):
    result=SpendingReductionToolResultV1(result=spending_reduction(request(),baseline(),now=NOW))
    if change=="formula":
        result.result.result.amount_minor=10000;result.result.counterfactual_net_minor=15000
    elif change=="currency": result.result.result.currency="USD"
    else: result.result.baseline.scope.dataset_coverage="unverified"
    with pytest.raises(AuthError,match="GROUNDING_EVIDENCE_INVALID"): ground_answer(result)


@pytest.mark.parametrize("change",["clock","expiry","state","evidence","period"])
def test_current_plan_requires_consistent_server_clock_state_and_evidence(change):
    result=saved_plan();plan=result.result.plan
    if change=="clock": result.result.evaluated_at=plan.as_of-timedelta(seconds=1)
    elif change=="expiry": result.result.evaluated_at=plan.expires_at
    elif change=="state": plan.state="superseded"
    elif change=="evidence": plan.analysis.evidence.plan_version+=1
    else: plan.period.protection_through=plan.period.requested_from
    with pytest.raises(AuthError,match="GROUNDING_EVIDENCE_INVALID"): ground_answer(result)


def test_observed_dates_and_nonnegative_counts_must_match_the_attached_scope():
    result=observed();result.result.evidence_filters.end_exclusive+=timedelta(days=1)
    with pytest.raises(AuthError,match="GROUNDING_EVIDENCE_INVALID"): ground_answer(result)
    result=observed();result.result.expense_count=-1
    with pytest.raises(AuthError,match="GROUNDING_EVIDENCE_INVALID"): ground_answer(result)
