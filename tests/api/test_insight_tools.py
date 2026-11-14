"""Closed read-only coaching arguments cannot become command or source authority."""
from types import SimpleNamespace
from uuid import UUID

import pytest
from pydantic import TypeAdapter,ValidationError

from app.analysis_tools import (AnalysisToolRequestV1,AnalysisToolResultV1,CoachingPreferencesArgumentsV1,
    InsightDetailsArgumentsV1,InsightListArgumentsV1,execute_tool)
from app.identity import AuthError
from app.model_adapter import ToolCall


@pytest.mark.parametrize("extra",[
    {"key":"dismiss"},{"expected_insight_version":1},{"current":True},{"coaching_enabled":True},
    {"paused_until":"2026-12-01T00:00:00Z"},{"maximum_age_hours":168},{"collection_version":1},
    {"preferences_version":1},{"expected_data_version":1},{"account_ids":[str(UUID(int=1))]},
])
def test_coaching_reads_reject_commands_and_fabricated_source_or_current_context(extra):
    for schema,arguments in [
        (InsightListArgumentsV1,{}),(InsightDetailsArgumentsV1,{"insight_id":str(UUID(int=1))}),
        (CoachingPreferencesArgumentsV1,{}),
    ]:
        with pytest.raises(ValidationError): schema.model_validate({**arguments,**extra})


@pytest.mark.parametrize("changes",[
    {"status":"all"},{"status":True},{"limit":0},{"limit":101},{"limit":True},{"limit":"1"},
    {"cursor":"x"*4097},{"cursor":123},
])
def test_insight_page_requires_one_supported_status_and_a_bounded_strict_page(changes):
    with pytest.raises(ValidationError): InsightListArgumentsV1(**changes)


def test_insight_request_and_result_unions_advertise_only_typed_read_envelopes():
    request=TypeAdapter(AnalysisToolRequestV1)
    result=TypeAdapter(AnalysisToolResultV1)
    for name,arguments in [("insight_list",{}),("insight_details",{"insight_id":str(UUID(int=1))}),("coaching_preferences",{})]:
        parsed=request.validate_python({"name":name,"arguments":arguments})
        assert parsed.name==name
        assert name in request.json_schema()["discriminator"]["mapping"]
        assert name in result.json_schema()["discriminator"]["mapping"]
    for name in ("insight_refresh","insight_dismiss","coaching_enable","coaching_set_preferences"):
        with pytest.raises(ValidationError): request.validate_python({"name":name,"arguments":{}})
    for arguments in ({},{"insight_id":"Upcoming bill"},{"name":"Upcoming bill"}):
        with pytest.raises(ValidationError): InsightDetailsArgumentsV1.model_validate(arguments)


def test_forged_internal_coaching_arguments_are_rejected_before_identity_or_pool_access():
    class UnusedPool:
        def connection(self): raise AssertionError("Forged arguments cannot reach the database")
    calls=[
        ToolCall("insight_list",InsightListArgumentsV1.model_construct(limit=True)),
        ToolCall("insight_list",InsightListArgumentsV1.model_construct(status="all")),
        ToolCall("insight_details",InsightDetailsArgumentsV1.model_construct()),
        ToolCall("insight_details",InsightDetailsArgumentsV1.model_construct(insight_id="not-a-uuid")),
        ToolCall("coaching_preferences",InsightListArgumentsV1()),
    ]
    for call in calls:
        with pytest.raises(AuthError) as error:
            execute_tool(UnusedPool(),None,call,identity=None,cursor_secret="unused")
        assert error.value.code=="ANALYSIS_TOOL_ARGUMENTS_INVALID"


def test_changed_session_is_rejected_after_second_resolution_before_opening_finance_pool():
    class UnusedPool:
        def connection(self): raise AssertionError("Changed session cannot reach the finance pool")
    prior=SimpleNamespace(token="test-only",session_id=UUID(int=1),scope="owner",permission_version=1)
    current=SimpleNamespace(session_id=UUID(int=2),scope="owner",permission_version=1)
    calls=[ToolCall("insight_list",InsightListArgumentsV1()),
        ToolCall("insight_details",InsightDetailsArgumentsV1(insight_id=UUID(int=1))),
        ToolCall("coaching_preferences",CoachingPreferencesArgumentsV1())]
    seen=[]
    identity=SimpleNamespace(resolve=lambda token:seen.append(token) or current)
    for call in calls:
        with pytest.raises(AuthError) as error:
            execute_tool(UnusedPool(),prior,call,identity=identity,cursor_secret="unused")
        assert error.value.code=="SESSION_CHANGED"
    assert seen==["test-only"]*3
