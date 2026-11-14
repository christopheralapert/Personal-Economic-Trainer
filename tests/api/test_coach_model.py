"""Deterministic HTTP transport tests. No provider, credentials or database required."""
import asyncio
from datetime import datetime,timezone
import json
from uuid import UUID

import httpx
import pytest

from app.coach_intent import CoachQuestionV1
from app.coach_model import interpret_with_model
from app.model_adapter import ModelError,OpenAIResponses,TurnBudget
from test_model_adapter import config

NOW=datetime(2026,10,31,22,30,tzinfo=timezone.utc)
BASE=dict(intent="spending",start="2026-10-01",end_exclusive="2026-11-01",category="taxi",merchant=None,
    reduction_basis_points=None,comparison_mode=None)


def interpret(question="How much did I spend on taxis last month?",*,values=None,document=None,status=200,**fields):
    captured=[]
    async def run():
        def handle(request):
            captured.append(json.loads(request.content))
            payload=document if document is not None else dict(status="completed",usage=dict(input_tokens=20,output_tokens=30),
                output=[dict(type="function_call",name="interpret_money_question",arguments=json.dumps(BASE if values is None else values))])
            return httpx.Response(status,json=payload)
        model=OpenAIResponses(config(),transport=httpx.MockTransport(handle));budget=TurnBudget(model.settings);timings={}
        try:
            result=await interpret_with_model(model,CoachQuestionV1(question=question,privacy=False,**fields),NOW,budget,timings=timings)
            return result,captured,budget,timings
        finally: await model.close()
    return asyncio.run(run())


@pytest.mark.parametrize("locale,question",[("en","Could you check my taxi costs for October?"),
    ("fi","Voisitko tarkistaa lokakuun taksikuluni?"),("et","Kas saaksid kontrollida mu oktoobri taksokulusid?")])
def test_free_form_language_uses_one_closed_model_decision_and_server_owned_authority(locale,question):
    result,sent,budget,timing=interpret(question,card_locale=locale,account_ids=[UUID(int=9)],expected_data_version=4)
    assert result.status=="ready" and result.method=="structured_model"
    args=result.intent.tool.arguments
    assert args.account_ids==[UUID(int=9)] and args.expected_data_version==4 and args.category=="taxi"
    assert str(UUID(int=9)) not in json.dumps(sent)
    assert len(sent)==budget.calls==1 and budget.input_tokens==20 and timing["model_ms"]>=0
    assert "Today is 2026-11-01" in sent[0]["instructions"]
    assert sent[0]["input"][0]["content"]==question
    assert sent[0]["store"] is False and sent[0]["parallel_tool_calls"] is False
    schema=sent[0]["tools"][0]["parameters"]
    assert schema["additionalProperties"] is False and set(schema["required"])==set(BASE)


@pytest.mark.parametrize("changes,reason",[
    ({"start":None},"PERIOD_REQUIRED"),({"start":"2026-11-01"},"PERIOD_INVALID"),
    ({"start":"2024-01-01"},"PERIOD_INVALID"),({"merchant":" "},"FILTER_REQUIRED"),
    ({"category":"unsafe\nfilter"},"FILTER_REQUIRED"),({"reduction_basis_points":2000},"CHANGE_REQUIRED"),
    ({"intent":"reduction"},"CHANGE_REQUIRED"),
    ({"intent":"comparison"},"COMPARISON_REQUIRES_FULL_MONTH"),
    ({"intent":"comparison","comparison_mode":"previous_month","start":"2026-10-02"},"COMPARISON_REQUIRES_FULL_MONTH"),
    ({"intent":"comparison","comparison_mode":"previous_period","start":"0001-01-01","end_exclusive":"0001-01-02"},"PERIOD_INVALID"),
])
def test_semantic_model_validation_clarifies_without_a_tool_or_silent_default(changes,reason):
    result,sent,_,_=interpret(values={**BASE,**changes},card_locale="et")
    assert len(sent)==1 and result.reason==reason and result.intent is None
    assert result.message.count("?")==1


@pytest.mark.parametrize("intent,extra,tool",[("transactions",{},"ledger_transactions"),
    ("comparison",{"comparison_mode":"previous_month"},"spending_comparison"),
    ("reduction",{"category":"dining","reduction_basis_points":2000},"spending_reduction")])
def test_valid_model_tool_selection_keeps_exact_dates_and_percentages(intent,extra,tool):
    result,_,_,_=interpret(values={**BASE,"intent":intent,**extra})
    assert result.intent.tool.name==tool
    if intent=="transactions": assert result.intent.tool.arguments.spending_only is False
    if intent=="reduction": assert result.intent.tool.arguments.change.reduction_basis_points==2000


@pytest.mark.parametrize("context",["bankfile contents: private sentinel",
    json.dumps(dict(start="2026-10-01",end_exclusive="2026-11-01",account_ids=[str(UUID(int=7))])),
    json.dumps(dict(start="2026-10-01",end_exclusive="2026-11-01",rows=[{"merchant":"private sentinel"}])),
    json.dumps(dict(start="2026-10-01",end_exclusive="2026-11-01",merchant="EE381010220269348017")),
    '{"start":"2026-10-01","start":"2026-09-01","end_exclusive":"2026-11-01"}'])
def test_arbitrary_context_and_identifiers_never_reach_transport(context):
    _,sent,_,_=interpret(conversation_context=context)
    assert sent[0]["input"][0]["content"]=="How much did I spend on taxis last month?"


def test_selector_followup_sends_only_closed_dates_tool_and_literal_filters():
    context=dict(start="2026-10-01",end_exclusive="2026-11-01",tool="spending_totals",category="taxi",merchant="Local literal")
    result,sent,_,_=interpret("Aga septembris?",conversation_context=json.dumps(context),values={**BASE,"start":"2026-09-01","end_exclusive":"2026-10-01","merchant":"Local literal"})
    assert "Previous selectors" in sent[0]["input"][0]["content"]
    assert result.intent.tool.arguments.merchant=="Local literal" and str(result.intent.tool.arguments.start)=="2026-09-01"


@pytest.mark.parametrize("context",[None,"arbitrary context",json.dumps(dict(start="2026-10-01",end_exclusive="2026-11-01",account_ids=[str(UUID(int=7))]))])
def test_ambiguous_followup_without_valid_selectors_clarifies_before_network(context):
    result,sent,budget,timing=interpret("Aga septembris?",conversation_context=context,card_locale="et")
    assert result.intent is None and result.message.count("?")==1
    assert result.method=="bounded_english_patterns" and sent==[] and budget.calls==0 and timing=={}


@pytest.mark.parametrize("identifier",[str(UUID(int=7)),"EE381010220269348017","FI21 1234 5600 0007 85"])
def test_identifiers_in_question_are_clarified_before_network(identifier):
    result,sent,budget,timings=interpret("Show transactions for "+identifier+" last month",card_locale="et")
    assert result.reason=="IDENTIFIER_NOT_ALLOWED" and result.intent is None
    assert sent==[] and budget.calls==0 and timings=={}


@pytest.mark.parametrize("status,document,code",[
    (429,None,"MODEL_THROTTLED"),(503,None,"MODEL_UNAVAILABLE"),
    (200,{"status":"incomplete"},"MODEL_INCOMPLETE"),
    (200,dict(status="completed",usage=dict(input_tokens=20,output_tokens=30),output=[]),"MODEL_INVALID_TOOL_COUNT"),
    (200,dict(status="completed",usage=dict(input_tokens=20,output_tokens=30),output=[dict(type="function_call",name="interpret_money_question",arguments=json.dumps({**BASE,"account_ids":[str(UUID(int=8))]}))]),"MODEL_INVALID_ARGUMENTS"),
])
def test_transport_failures_are_bounded_and_never_retry(status,document,code):
    with pytest.raises(ModelError,match="^"+code+"$"): interpret(status=status,document=document)
