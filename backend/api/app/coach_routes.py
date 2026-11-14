"""Owned question-to-service bridge: server tools compute and ground model conversation."""
from datetime import datetime,timezone
import time
import re
from time import perf_counter
from typing import Literal

from fastapi import APIRouter,Depends,Request,Response
from pydantic import model_validator
from starlette.concurrency import run_in_threadpool
from psycopg.types.json import Jsonb
from uuid import uuid4

from .analysis_tools import execute_tool
from .answer_cards import AnswerCardV1,render_answer,transaction_sentence
from .auth_routes import write_principal
from .coach_intent import CoachInterpretationV1,CoachQuestionV1,interpret_question,interpretation_message,question_has_identifiers,unsupported_amount_filter,unsupported_amount_message
from .contracts import Contract
from .model_adapter import ModelError,ToolCall,TurnBudget
from .analysis_tools import SpendingToolResultV1
from .coach_model import interpret_with_model,compose_with_model
from .coach_latest_bank import requested_bank,interpret_latest_bank
from .identity import authorized_transaction,AuthError
from .ledger import LedgerPageV1
from .spending_habits import SpendingHabitsV1,spending_habits

router=APIRouter()
_model_usage_window={}


class CoachAnswerV1(Contract):
    response_version: Literal["coach-answer.v1"] = "coach-answer.v1"
    read_only: Literal[True] = True
    persisted: Literal[False] = False
    interpretation: CoachInterpretationV1
    card: AnswerCardV1 | None = None
    habits: SpendingHabitsV1 | None = None
    transactions: LedgerPageV1 | None = None
    model_usage: dict[str,int|bool] | None = None
    allow_ai_payment_descriptions: bool = False
    source: Literal["rule","model"] = "rule"
    provider: Literal["gemini-direct","openai-responses"] | None = None
    model_diagnostic: str | None = None
    answer_text: str = ""

    @model_validator(mode="after")
    def coherent_result(self):
        if (self.source=="model")!=(self.provider is not None): raise ValueError("Only successful model responses name a provider")
        intent=self.interpretation.intent
        if intent is None:
            if self.card is not None or self.habits is not None or self.transactions is not None: raise ValueError("Unresolved questions cannot have financial results")
        elif intent.kind=="analysis":
            if self.habits is not None: raise ValueError("An analysis cannot include habits")
            if intent.tool.name=="ledger_transactions":
                if self.transactions is None or self.card is not None:raise ValueError("Search requires server ledger rows")
            elif self.card is None or self.transactions is not None: raise ValueError("An analysis requires its grounded card")
        elif self.habits is None or self.card is not None or self.transactions is not None: raise ValueError("A habits query requires observed evidence")
        return self


@router.post("/v1/coach/query",response_model=CoachAnswerV1)
async def query(body:CoachQuestionV1,request:Request,response:Response,user=Depends(write_principal)):
    started=perf_counter();timings={"model_ms":0.0};source="rule";provider=None;diagnostic=None
    def finish(**values):
        answer=CoachAnswerV1(**values,source=source,provider=provider,model_diagnostic=diagnostic,model_usage=usage,allow_ai_payment_descriptions=allow_descriptions)
        if not answer.answer_text: answer.answer_text=answer.card.summary if answer.card else answer.interpretation.message
        total=(perf_counter()-started)*1000;model=timings["model_ms"]
        response.headers["X-Money-Coach-Source"]=source
        response.headers["X-Money-Coach-Evaluation"]=diagnostic or ("model_tool" if source=="model" else "privacy_rule" if body.privacy else "local_rule")
        if provider is not None: response.headers["X-Money-Coach-Provider"]=provider
        response.headers["Server-Timing"]=f"model;dur={model:.1f}, app;dur={max(0,total-model):.1f}, total;dur={total:.1f}"
        return answer
    config=request.app.state.settings
    now=request.app.state.coach_clock() if hasattr(request.app.state,"coach_clock") else datetime.now(timezone.utc)
    usage=None
    bank=requested_bank(body.question)
    use_model=not body.privacy and config.model_enabled and config.model_billing_policy=="paid_allowed" and not user.synthetic and not question_has_identifiers(body.question) and not unsupported_amount_filter(body.question)
    if use_model and bank is None:
        key=str(user.scope.user_id);now_seconds=time.monotonic();today=datetime.now(timezone.utc).date().isoformat()
        last,day,total=_model_usage_window.get(key,(0.0,today,0))
        if day!=today: total=0;day=today
        if now_seconds-last<config.model_user_rate_seconds: raise AuthError("MODEL_RATE_LIMITED",429)
        if total>=config.model_daily_token_cap: raise AuthError("MODEL_DAILY_TOKEN_CAP",429)
        _model_usage_window[key]=(now_seconds,day,total)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            preference=connection.execute("SELECT allow_ai_payment_descriptions FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",
                (user.scope.tenant_id,user.scope.user_id)).fetchone()
    allow_descriptions=bool(preference and preference[0])
    budget=TurnBudget(config) if use_model and bank is None else None
    complete=False
    try:
        if bank is not None:
            with request.app.state.pools.finance.connection() as connection:
                with authorized_transaction(connection,user,repeatable_read=True):
                    interpretation=interpret_latest_bank(connection,user,body,bank,now)
        elif budget is not None:
            try:
                interpretation=await interpret_with_model(request.app.state.model,body,now,budget,timings=timings)
                complete=True
                if interpretation.method=="structured_model":
                    source="model"
                    provider="gemini-direct" if getattr(config,"model_provider","openai")=="gemini" else "openai-responses"
            except ModelError as error:
                diagnostic=safe_diagnostic(error)
                interpretation=interpret_question(body,now=now)
        else:interpretation=interpret_question(body,now=now)
        if interpretation.reason!="GENERAL_CONVERSATION":
            interpretation.message=unsupported_amount_message(body.card_locale) if interpretation.reason=="FILTER_REQUIRED" and unsupported_amount_filter(body.question) else interpretation_message(interpretation.reason,body.card_locale)
        values={"interpretation":interpretation}
        intent=interpretation.intent
        if intent is not None:
            call=ToolCall(intent.tool.name,intent.tool.arguments) if intent.kind=="analysis" else ToolCall("spending_totals",intent.arguments)
            secret=config.session_secret.get_secret_value()
            artifact=await run_in_threadpool(execute_tool,request.app.state.pools.finance,user,call,identity=request.app.state.identity,cursor_secret=secret,
                bank_secret=secret,maximum_age_hours=config.balance_maximum_age_hours,now=interpretation.resolved_at)
            card=None;transactions=None
            if intent.kind=="habits":
                card=render_answer(SpendingToolResultV1(result=artifact.result),body.card_locale)
                values.update(habits=spending_habits(intent.arguments,artifact.result,now=interpretation.resolved_at),answer_text=card.summary)
            elif call.name=="ledger_transactions":
                transactions=artifact.result
                values.update(transactions=transactions,answer_text=transaction_sentence(transactions,body.card_locale))
            else:
                card=render_answer(artifact,body.card_locale)
                values.update(card=card,answer_text=card.summary)
            if source=="model":
                try:
                    if total+budget.input_tokens+budget.output_tokens>=config.model_daily_token_cap:
                        raise ModelError("MODEL_DAILY_TOKEN_CAP")
                    prose=await compose_with_model(request.app.state.model,body,budget,card=card,
                        transactions=transactions,habits=intent.kind=="habits",timings=timings)
                    values["answer_text"]=prose+"\n\n"+values["answer_text"]
                except ModelError as error:
                    # The returned text is now wholly server-authored, even though selection used a model.
                    diagnostic=safe_diagnostic(error);source="rule";provider=None;complete=False
    finally:
        if budget is not None:
            usage={"calls":budget.calls,"tool_calls":budget.tools,"estimated_cost_microusd":budget.cost,
                "input_tokens":budget.input_tokens,"output_tokens":budget.output_tokens,
                "usage_complete":complete,"cost_limit_enabled":config.model_cost_limit_enabled}
            _model_usage_window[key]=(now_seconds,day,total+budget.input_tokens+budget.output_tokens)
            await run_in_threadpool(record_usage,request,user,usage)
    return finish(**values)


def safe_diagnostic(error):
    return error.code if isinstance(error.code,str) and re.fullmatch(r"MODEL_[A-Z0-9_]{1,80}",error.code) else "MODEL_UNAVAILABLE"


def record_usage(request,user,usage):
    current=request.app.state.identity.resolve(user.token)
    if (current.session_id,current.scope,current.permission_version)!=(user.session_id,user.scope,user.permission_version):
        raise AuthError("SESSION_CHANGED",409)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            connection.execute("""INSERT INTO moneylens.audit_events (tenant_id,owner_user_id,id,action,trace_id,metadata)
                VALUES (%s,%s,%s,'coach.model_usage',%s,%s)""",
                (user.scope.tenant_id,user.scope.user_id,uuid4(),uuid4(),Jsonb(usage)))
