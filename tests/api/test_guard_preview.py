"""Isolated preview mock compatibility; no server, database, keys or live calls."""
import asyncio
import importlib.util
from pathlib import Path

import httpx
import pytest

from app.analysis_tools import SpendingToolResultV1
from app.answer_cards import render_answer
from app.coach_intent import CoachQuestionV1
from app.coach_model import compose_with_model,interpret_with_model
from app.gemini_adapter import GeminiFunctions,GEMINI_MODEL
from app.model_adapter import TurnBudget
from test_coach_conversation import NOW
from test_model_adapter import config
from test_spending_scenario import baseline

spec=importlib.util.spec_from_file_location("guard_preview_tests",Path(__file__).resolve().parents[2]/"scripts/run_guard_preview.py")
preview=importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


@pytest.mark.parametrize("question,history,expected",[
    ("How much did I spend on taxis last month?",[],"Review the evidence"),
    ("What is an impulse purchase?",[],"24-hour pause"),
    ("Could you explain that more?",[{"role":"user","text":"I want help with meal planning and grocery costs."}],"meals that share ingredients"),
])
def test_preview_mock_supports_native_interpretation_composition_and_conversation(question,history,expected):
    async def run():
        counts=dict(gemini=0,classification_mock=0)
        settings=config(model_provider="gemini",model_name=GEMINI_MODEL,gemini_api_key="offline-only",
            model_input_microusd_per_token=1,model_output_microusd_per_token=5)
        model=GeminiFunctions(settings,transport=httpx.MockTransport(lambda request:preview.mock_gemini(request,counts)))
        body=CoachQuestionV1(question=question,privacy=False,conversation_history=history)
        budget=TurnBudget(settings)
        try:
            answer=await interpret_with_model(model,body,NOW,budget)
            if answer.intent is not None:
                card=render_answer(SpendingToolResultV1(result=baseline()),"en")
                text=await compose_with_model(model,body,budget,card=card)
                assert counts["gemini"]==2
            else:
                assert answer.status=="answered";text=answer.message
                assert counts["gemini"]==1
            assert expected in text and counts["classification_mock"]==0
        finally:await model.close()
    asyncio.run(run())


def test_preview_mock_still_classifies_only_the_supplied_public_brand_refs():
    counts=dict(gemini=0,classification_mock=0)
    import json
    request=httpx.Request("POST",preview.GEMINI_ENDPOINT,json={
        "tools":[{"functionDeclarations":[{"name":"classify_merchants"}]}],
        "contents":[{"parts":[{"text":json.dumps({"batch_ref":"batch","merchants":[{"ref":"m1","merchant":"LIDL"}]})}]}]})
    result=preview.mock_gemini(request,counts).json()
    call=result["candidates"][0]["content"]["parts"][0]["functionCall"]
    assert call=={"name":"classify_merchants","args":{"batch_ref":"batch","items":[{"ref":"m1","category":"groceries"}]}}
    assert counts==dict(gemini=0,classification_mock=1)


def test_live_key_reads_only_explicit_server_key_without_importing_private_flags(monkeypatch,tmp_path):
    monkeypatch.delenv("GEMINI_API_KEY",raising=False)
    monkeypatch.setattr(preview,"ROOT",tmp_path)
    monkeypatch.delenv("MONEYLENS_MODEL_ENABLED",raising=False)
    (tmp_path/".env").write_text("GEMINI_API_KEY='offline-test-key'\nMONEYLENS_MODEL_ENABLED=true\n",encoding="utf-8")
    assert preview.live_gemini_key().get_secret_value()=="offline-test-key"
    import os
    assert "MONEYLENS_MODEL_ENABLED" not in os.environ
    monkeypatch.setenv("GEMINI_API_KEY","explicit-server-key")
    assert preview.live_gemini_key().get_secret_value()=="explicit-server-key"
