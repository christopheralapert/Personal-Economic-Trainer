"""Conversation tool round trips through existing adapters using offline transports."""
import asyncio
from datetime import datetime,timezone
import json
from uuid import UUID

import httpx
import pytest

from app.analysis_tools import SpendingToolResultV1
from app.answer_cards import render_answer
from app.coach_intent import CoachQuestionV1
from app.coach_model import compose_with_model,dialogue_input,interpret_with_model
from app.gemini_adapter import GeminiFunctions,GEMINI_MODEL
from app.ledger import LedgerPageV1,LedgerRowV1
from app.model_adapter import ModelError,OpenAIResponses,TurnBudget
from test_model_adapter import config
from test_spending_scenario import baseline

NOW=datetime(2026,11,6,tzinfo=timezone.utc)
PROSE="Consider your essential costs first, then choose a manageable budgeting habit."


@pytest.mark.parametrize("provider",["gemini","openai"])
def test_general_conversation_and_composition_use_existing_structured_adapters(provider):
    captured=[]
    async def run():
        def handle(request):
            captured.append(json.loads(request.content))
            call=dict(name="respond_to_money_message",args=dict(text=PROSE))
            if provider=="gemini":
                return httpx.Response(200,json=dict(candidates=[dict(finishReason="STOP",content=dict(parts=[dict(functionCall=call)]))],
                    usageMetadata=dict(promptTokenCount=30,totalTokenCount=50)))
            return httpx.Response(200,json=dict(status="completed",usage=dict(input_tokens=30,output_tokens=20),
                output=[dict(type="function_call",name=call["name"],arguments=json.dumps(call["args"]))]))
        settings=config(model_provider=provider,model_name=GEMINI_MODEL if provider=="gemini" else "test-model",gemini_api_key="offline-only",
            model_input_microusd_per_token=1,model_output_microusd_per_token=5)
        model=(GeminiFunctions if provider=="gemini" else OpenAIResponses)(settings,transport=httpx.MockTransport(handle))
        budget=TurnBudget(settings);timings={}
        try:
            result=await interpret_with_model(model,CoachQuestionV1(question="How can I build better budgeting habits?",privacy=False),NOW,budget,timings=timings)
            assert result.status=="answered" and result.message==PROSE and result.intent is None
            card=render_answer(SpendingToolResultV1(result=baseline()),"en")
            text=await compose_with_model(model,CoachQuestionV1(question="Please explain the result",privacy=False),budget,card=card,timings=timings)
            assert text==PROSE and budget.calls==2 and budget.input_tokens==60 and budget.output_tokens==40
            assert timings["model_ms"]>=0
        finally: await model.close()
    asyncio.run(run())
    assert len(captured)==2
    wire=json.dumps(captured)
    assert str(UUID(int=1)) not in wire and '"account_ids"' not in wire and '"rows"' not in wire
    payload=captured[1]
    definitions=payload["tools"][0]["functionDeclarations"] if provider=="gemini" else payload["tools"]
    assert len(definitions)==1 and definitions[0]["name"]=="respond_to_money_message"


def test_transaction_composer_projects_only_bounded_page_aggregates():
    class Model:
        async def decide(self,request,tools,budget):
            facts=json.loads(request.question)["server_facts"]
            assert facts==dict(presentation="transaction_page",returned_count=1,has_more=True)
            assert "not spending" in request.instructions
            # Fail after inspecting the payload so no generated text is required.
            raise ModelError("MODEL_TIMEOUT")
    totals=baseline()
    page=LedgerPageV1(scope=totals.scope,rows=[LedgerRowV1(id=UUID(int=91),account_id=UUID(int=92),amount_minor=-555,
        currency="EUR",booked_on="2026-10-03",status="booked",merchant="Private description sentinel",
        category="Private category sentinel",basket="unresolved",economic_flow="unknown")],next_cursor="private cursor sentinel")
    with pytest.raises(ModelError,match="MODEL_TIMEOUT"):
        asyncio.run(compose_with_model(Model(),CoachQuestionV1(question="Explain the matches",privacy=False),TurnBudget(config()),transactions=page))


def test_privacy_guard_is_zero_call_even_when_interpreter_is_called_directly():
    class Model:
        async def decide(self,*args): raise AssertionError("No calls in privacy mode")
    result=asyncio.run(interpret_with_model(Model(),CoachQuestionV1(question="Help me start budgeting",privacy=True),NOW,TurnBudget(config())))
    assert result.method=="bounded_english_patterns" and result.intent is None


def test_history_keeps_newest_whole_messages_within_utf8_adapter_byte_limit():
    body=CoachQuestionV1(question="Could you explain?",privacy=False,conversation_history=[
        dict(role="user",text=f"{index}: "+"õ"*1990) for index in range(8)])
    text=dialogue_input(body,body.question)
    payload=json.loads(text)
    assert len(text.encode("utf-8"))<=8192
    assert len(payload["untrusted_dialogue"])<8 and payload["untrusted_dialogue"][-1]["text"].startswith("7:")
    assert all(len(message["text"])==1993 for message in payload["untrusted_dialogue"])
    assert len(body.conversation_history)==8  # Trimming only affects the provider envelope.
