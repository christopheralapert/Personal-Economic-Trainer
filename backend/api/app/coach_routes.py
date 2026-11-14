"""Owned question-to-service bridge: models interpret; server tools compute."""
from datetime import datetime,timezone
import time
from typing import Literal

from fastapi import APIRouter,Depends,Request
from pydantic import model_validator
from starlette.concurrency import run_in_threadpool
from psycopg.types.json import Jsonb
from uuid import uuid4

from .analysis_tools import execute_tool
from .answer_cards import AnswerCardV1,render_answer
from .auth_routes import write_principal
from .coach_intent import CoachInterpretationV1,CoachQuestionV1,interpret_question
from .contracts import Contract
from .model_adapter import ToolCall,TurnBudget
from .coach_model import interpret_with_model
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

    @model_validator(mode="after")
    def coherent_result(self):
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
async def query(body:CoachQuestionV1,request:Request,user=Depends(write_principal)):
    config=request.app.state.settings
    now=request.app.state.coach_clock() if hasattr(request.app.state,"coach_clock") else datetime.now(timezone.utc)
    usage=None
    bank=requested_bank(body.question)
    use_model=config.model_enabled and config.model_billing_policy=="paid_allowed" and not user.synthetic
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
    if bank is not None:
        with request.app.state.pools.finance.connection() as connection:
            with authorized_transaction(connection,user,repeatable_read=True):
                interpretation=interpret_latest_bank(connection,user,body,bank,now)
    elif use_model:
        budget=TurnBudget(config)
        complete=False
        try:
            interpretation=await interpret_with_model(request.app.state.model,body,now,budget)
            complete=True
        finally:
            usage={"calls":budget.calls,"tool_calls":budget.tools,"estimated_cost_microusd":budget.cost,
                "input_tokens":budget.input_tokens,"output_tokens":budget.output_tokens,
                "usage_complete":complete,"cost_limit_enabled":config.model_cost_limit_enabled}
            await run_in_threadpool(record_usage,request,user,usage)
            _model_usage_window[key]=(now_seconds,day,total+budget.input_tokens+budget.output_tokens)
    else:interpretation=interpret_question(body,now=now)
    intent=interpretation.intent
    if intent is None: return CoachAnswerV1(interpretation=interpretation,model_usage=usage,allow_ai_payment_descriptions=allow_descriptions)
    call=ToolCall(intent.tool.name,intent.tool.arguments) if intent.kind=="analysis" else ToolCall("spending_totals",intent.arguments)
    secret=config.session_secret.get_secret_value()
    artifact=await run_in_threadpool(execute_tool,request.app.state.pools.finance,user,call,identity=request.app.state.identity,cursor_secret=secret,
        bank_secret=secret,maximum_age_hours=config.balance_maximum_age_hours,now=interpretation.resolved_at)
    if intent.kind=="habits":
        return CoachAnswerV1(interpretation=interpretation,habits=spending_habits(intent.arguments,artifact.result,now=interpretation.resolved_at),model_usage=usage,allow_ai_payment_descriptions=allow_descriptions)
    if call.name=="ledger_transactions":return CoachAnswerV1(interpretation=interpretation,transactions=artifact.result,model_usage=usage,allow_ai_payment_descriptions=allow_descriptions)
    return CoachAnswerV1(interpretation=interpretation,card=render_answer(artifact,body.card_locale),model_usage=usage,allow_ai_payment_descriptions=allow_descriptions)


def record_usage(request,user,usage):
    current=request.app.state.identity.resolve(user.token)
    if (current.session_id,current.scope,current.permission_version)!=(user.session_id,user.scope,user.permission_version):
        raise AuthError("SESSION_CHANGED",409)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            connection.execute("""INSERT INTO moneylens.audit_events (tenant_id,owner_user_id,id,action,trace_id,metadata)
                VALUES (%s,%s,%s,'coach.model_usage',%s,%s)""",
                (user.scope.tenant_id,user.scope.user_id,uuid4(),uuid4(),Jsonb(usage)))
