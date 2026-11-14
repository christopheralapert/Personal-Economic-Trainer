import asyncio
from datetime import date
import json
from uuid import UUID

import pytest
import httpx
from pydantic import ValidationError

from app.analysis_tools import (DEFINITIONS,LedgerSearchArgumentsV1,SpendingArgumentsV1,
    SpendingComparisonArgumentsV1,GoalListArgumentsV1,GoalDetailsArgumentsV1,GoalAllocationsArgumentsV1,execute_tool,tool_catalog,tool_catalog_v2,select_tool_definitions)
from app.identity import AuthError
from app.analysis_tool_finance import PlanningReadArgumentsV1,BankConnectionsArgumentsV1
from app.model_adapter import OpenAIResponses,ToolCall
from app.settings import Settings

WINDOW=dict(start="2026-10-01",end_exclusive="2026-11-01")


def supplied_arguments(definition):
    if definition.name in ("goal_list","insight_list","coaching_preferences","planning_read","bank_connections","population_reference"): return {}
    if definition.name in ("goal_details","goal_allocations"): return {"goal_id":str(UUID(int=1))}
    if definition.name=="insight_details": return {"insight_id":str(UUID(int=1))}
    return {**WINDOW,**({"category":"dining","change":{"kind":"percentage","reduction_basis_points":2000}} if definition.name=="spending_reduction" else {})}


def test_catalog_is_closed_model_compatible_read_only_and_has_no_authority_inputs():
    catalog=tool_catalog()
    assert catalog.registry_version=="analysis-tools.v1"
    assert {item.name for item in catalog.tools}=={"ledger_transactions","spending_totals","spending_comparison","spending_reduction","goal_list","goal_details","goal_allocations","insight_list","insight_details","coaching_preferences"}
    expanded=tool_catalog_v2()
    assert expanded.registry_version=="analysis-tools.v2"
    assert {item.name for item in expanded.tools}=={item.name for item in catalog.tools}|{"planning_read","bank_connections","population_reference"}
    forbidden={"tenant_id","owner_user_id","user_id","session_id","permission_version","sql","url","household_coverage_confirmed","as_of"}
    for item in expanded.tools:
        schema=item.arguments_schema
        assert item.read_only is True and schema["additionalProperties"] is False
        assert set(schema["required"])==set(schema["properties"])
        assert not forbidden & schema["properties"].keys()
        assert all("default" not in field for field in schema["properties"].values())
    assert next(item for item in catalog.tools if item.name=="ledger_transactions").arguments_schema["properties"]["limit"]["maximum"]==100
    assert all(item.schema()["strict"] for item in DEFINITIONS)


def test_catalog_mutation_cannot_modify_shared_definitions():
    catalog=tool_catalog()
    catalog.tools[0].arguments_schema["properties"].clear()
    catalog.tools.clear()
    assert tool_catalog().tools[0].arguments_schema["properties"]["start"]["format"]=="date"


def test_per_turn_capabilities_are_explicit_bounded_and_never_silently_truncated():
    names=["planning_read","bank_connections","population_reference"]
    assert [definition.name for definition in select_tool_definitions(names)]==names
    for invalid in ([],["planning_read"]*2,["not_registered"],[item.name for item in DEFINITIONS],[True],"planning_read"):
        with pytest.raises(ValueError): select_tool_definitions(invalid)


def test_registered_definitions_round_trip_through_the_existing_model_parser_without_a_provider_request():
    sent=[]
    model=OpenAIResponses(Settings(environment="test",model_enabled=False,model_billing_policy="free_only"),
        transport=httpx.MockTransport(lambda request:sent.append(request)))
    try:
        for definition in DEFINITIONS:
            supplied=supplied_arguments(definition)
            arguments=definition.arguments.model_validate(supplied)
            response={"status":"completed","usage":{"input_tokens":0,"output_tokens":0},"output":[
                {"type":"function_call","name":definition.name,"arguments":arguments.model_dump_json(),"status":"completed"}]}
            decision=model.parse(json.dumps(response).encode(),select_tool_definitions([definition.name]),100)
            assert len(decision.calls)==1 and decision.calls[0].name==definition.name
            assert decision.calls[0].arguments==arguments
        assert sent==[]
    finally: asyncio.run(model.close())


@pytest.mark.parametrize("field",["tenant_id","owner_user_id","user_id","permission_version","session_id","sql","url","as_of","household_coverage_confirmed"])
def test_tool_arguments_cannot_claim_authority_or_invoke_arbitrary_work(field):
    for definition in DEFINITIONS:
        with pytest.raises(ValidationError):
            definition.arguments.model_validate({**supplied_arguments(definition),field:"forged"})


@pytest.mark.parametrize("changes",[
    {"limit":101},{"limit":0},{"limit":True},{"limit":"10"},{"spending_only":"true"},
    {"expected_data_version":True},{"expected_data_version":"1"},{"expected_data_version":2**53},
    {"account_ids":[]},{"account_ids":[str(UUID(int=1))]*2},
    {"end_exclusive":"2026-10-01"},{"end_exclusive":"2027-10-03"},{"merchant":"x"*201},
])
def test_search_refuses_coercion_overflow_unbounded_or_ambiguous_scope(changes):
    with pytest.raises(ValidationError):
        LedgerSearchArgumentsV1.model_validate({**WINDOW,**changes})


def test_historical_consumption_has_no_pending_or_write_parameter_and_no_silent_shortening():
    for extra in ({"status":"pending"},{"amount_minor":123},{"spending_only":False}):
        with pytest.raises(ValidationError): SpendingArgumentsV1.model_validate({**WINDOW,**extra})
    args=SpendingArgumentsV1(start="2024-01-01",end_exclusive="2025-01-01")
    assert (args.end_exclusive-args.start).days==366
    assert args.filters().status=="booked" and args.filters().end_exclusive==date(2025,1,1)
    with pytest.raises(ValidationError):
        SpendingComparisonArgumentsV1(**WINDOW,mode="custom",baseline_start="2020-01-01",baseline_end_exclusive="2022-01-01")


def test_internal_forged_calls_fail_before_acquiring_a_database_connection():
    class UnusedPool:
        def connection(self): raise AssertionError("Invalid arguments must not reach a database")
    for call,code in [
        (ToolCall("reserve_money",SpendingArgumentsV1(**WINDOW)),"ANALYSIS_TOOL_UNAVAILABLE"),
        (ToolCall("goal_list",GoalListArgumentsV1.model_construct(limit=True)),"ANALYSIS_TOOL_ARGUMENTS_INVALID"),
        (ToolCall("goal_allocations",GoalAllocationsArgumentsV1.model_construct(goal_id=UUID(int=1),limit=True)),"ANALYSIS_TOOL_ARGUMENTS_INVALID"),
        (ToolCall("goal_details",GoalDetailsArgumentsV1.model_construct()),"ANALYSIS_TOOL_ARGUMENTS_INVALID"),
        (ToolCall("planning_read",PlanningReadArgumentsV1.model_construct(plan_id=True)),"ANALYSIS_TOOL_ARGUMENTS_INVALID"),
        (ToolCall("bank_connections",BankConnectionsArgumentsV1.model_construct(connection_id=True)),"ANALYSIS_TOOL_ARGUMENTS_INVALID"),
        (ToolCall("ledger_transactions",LedgerSearchArgumentsV1.model_construct(start=date(2026,10,1),end_exclusive=date(2026,11,1),limit=True)),"ANALYSIS_TOOL_ARGUMENTS_INVALID"),
        (ToolCall("spending_totals",LedgerSearchArgumentsV1(**WINDOW)),"ANALYSIS_TOOL_ARGUMENTS_INVALID"),
    ]:
        with pytest.raises(AuthError) as error: execute_tool(UnusedPool(),None,call,identity=None,cursor_secret="unused")
        assert error.value.code==code


@pytest.mark.parametrize("changes",[{"limit":True},{"limit":"1"},{"limit":0},{"limit":101},{"cursor":"x"*4097},{"currency":"eur"},{"state":"any"},{"confirmed_saved_minor":5000},{"key":"create"},{"expected_goal_version":1}])
def test_goal_read_arguments_do_not_accept_writes_unsafe_limits_or_fabricated_progress(changes):
    with pytest.raises(ValidationError): GoalListArgumentsV1(**changes)
    with pytest.raises(ValidationError): GoalAllocationsArgumentsV1(goal_id=UUID(int=1),**changes)


def test_goal_ids_are_required_and_not_derived_from_a_goal_name():
    for values in ({},{"goal_id":"Emergency fund"},{"name":"Emergency fund"},{"goal_id":str(UUID(int=1)),"owner_user_id":str(UUID(int=2))}):
        with pytest.raises(ValidationError): GoalDetailsArgumentsV1(**values)
