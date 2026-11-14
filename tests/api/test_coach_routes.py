"""In-process route boundaries with synthetic artifacts; no database or network."""
from contextlib import nullcontext
from datetime import datetime,timezone
from types import SimpleNamespace
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app import coach_model,coach_routes
from app.analysis_tools import SpendingToolResultV1
from app.auth_routes import write_principal
from app.model_adapter import ModelDecision,ModelError,ToolCall
from app.coach_model import QuestionIntent
from test_model_adapter import config
from test_spending_scenario import baseline

NOW=datetime(2026,11,6,10,tzinfo=timezone.utc)


@pytest.fixture
def route(monkeypatch):
    app=FastAPI();app.include_router(coach_routes.router)
    settings=SimpleNamespace(**{**config(model_cost_limit_enabled=False,session_secret="synthetic-test-session-secret-at-least-32-characters").model_dump(),"model_provider":"gemini"})
    user=SimpleNamespace(synthetic=False,scope=SimpleNamespace(user_id=UUID(int=11),tenant_id=UUID(int=12)))
    app.dependency_overrides[write_principal]=lambda:user
    captured=[];executed=[];audited=[]
    class Connection:
        def execute(self,*args): return self
        def fetchone(self): return (True,)
    app.state.pools=SimpleNamespace(finance=SimpleNamespace(connection=lambda:nullcontext(Connection())))
    app.state.settings=settings;app.state.coach_clock=lambda:NOW;app.state.identity=object()
    class Model:
        async def decide(self,request,tools,budget):
            captured.append(request)
            if getattr(self,"fail",False): raise ModelError(self.fail)
            return ModelDecision((ToolCall("interpret_money_question",QuestionIntent(intent="spending",start="2026-10-01",end_exclusive="2026-11-01",category="taxi",merchant=None,reduction_basis_points=None,comparison_mode=None)),),10,10,10)
    app.state.model=Model()
    monkeypatch.setattr(coach_routes,"authorized_transaction",lambda *a,**kw:nullcontext())
    monkeypatch.setattr(coach_routes,"record_usage",lambda request,user,usage:audited.append(usage.copy()))
    def execute(pools,principal,call,**options):
        executed.append((principal,call,options));value=baseline();value.evidence_filters.category="taxi"
        return SpendingToolResultV1(result=value)
    monkeypatch.setattr(coach_routes,"execute_tool",execute)
    monkeypatch.setattr(coach_routes,"_model_usage_window",{})
    settings.model_user_rate_seconds=0
    with TestClient(app) as client: yield client,app,user,captured,executed,audited


@pytest.mark.parametrize("fields,synthetic",[({},False),({"privacy":True},False),({"privacy":False},True)])
def test_privacy_default_and_synthetic_users_never_call_models_or_claim_a_provider(route,fields,synthetic):
    client,app,user,captured,executed,audited=route;user.synthetic=synthetic
    response=client.post("/v1/coach/query",json={"question":"How much did I spend on taxis last month?",**fields})
    assert response.status_code==200,response.text
    body=response.json()
    assert captured==audited==[] and len(executed)==1
    assert body["source"]=="rule" and body["provider"] is None and body["model_usage"] is None
    assert response.headers["X-Money-Coach-Source"]=="rule" and "X-Money-Coach-Provider" not in response.headers
    assert response.headers["Server-Timing"].startswith("model;dur=0.0, app;dur=")


def test_successful_decision_reports_gemini_and_exact_timing_with_owned_selectors_only(route,monkeypatch):
    client,app,user,captured,executed,audited=route
    clock=iter((100.0,100.1));model_clock=iter((40.0,40.03))
    monkeypatch.setattr(coach_routes,"perf_counter",lambda:next(clock))
    monkeypatch.setattr(coach_model,"perf_counter",lambda:next(model_clock))
    response=client.post("/v1/coach/query",json={"question":"Kui palju kulutasin taksodele oktoobris?","privacy":False,"card_locale":"et","account_ids":[str(UUID(int=1))],"expected_data_version":7})
    assert response.status_code==200,response.text
    body=response.json()
    assert body["source"]=="model" and body["provider"]==response.headers["X-Money-Coach-Provider"]=="gemini-direct"
    assert response.headers["Server-Timing"]=="model;dur=30.0, app;dur=70.0, total;dur=100.0"
    assert len(captured)==len(executed)==len(audited)==1 and audited[0]["usage_complete"] is True
    assert str(UUID(int=1)) not in captured[0].question
    principal,call,_=executed[0]
    assert principal is user and call.arguments.account_ids==[UUID(int=1)] and call.arguments.expected_data_version==7
    assert "250,00 EUR" in body["answer_text"] and "2026-10-01" in body["answer_text"]


@pytest.mark.parametrize("failure",["MODEL_THROTTLED","MODEL_NETWORK_ACCESS_DENIED","MODEL_TIMEOUT"])
def test_failed_model_falls_back_once_without_gemini_provider_claim(route,failure):
    client,app,_,captured,executed,audited=route;app.state.model.fail=failure
    response=client.post("/v1/coach/query",json={"question":"How much did I spend on taxis last month?","privacy":False})
    assert response.status_code==200,response.text
    assert response.json()["source"]=="rule" and response.json()["provider"] is None
    assert "X-Money-Coach-Provider" not in response.headers
    assert response.json()["model_diagnostic"]==response.headers["X-Money-Coach-Evaluation"]==failure
    assert len(captured)==len(executed)==len(audited)==1 and audited[0]["usage_complete"] is False


@pytest.mark.parametrize("question",["Show transactions for EE381010220269348017 last month",f"Show transactions for {UUID(int=1)} last month"])
def test_account_identifiers_are_clarified_before_model_or_financial_tools(route,question):
    client,_,_,captured,executed,audited=route
    response=client.post("/v1/coach/query",json={"question":question,"privacy":False,"card_locale":"fi"})
    assert response.status_code==200,response.text
    assert response.json()["interpretation"]["reason"]=="IDENTIFIER_NOT_ALLOWED"
    assert response.json()["answer_text"].count("?")==1 and captured==executed==audited==[]
    assert response.headers["Server-Timing"].startswith("model;dur=0.0")
