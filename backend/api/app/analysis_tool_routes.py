"""Private deterministic tool queries; this route does not invoke a model."""
from fastapi import APIRouter,Depends,Request

from .analysis_tools import (AnalysisToolCatalogV1,AnalysisToolRequestV1,AnalysisToolResultV1,
    AnalysisToolCatalogV2,AnalysisToolRequestV2,AnalysisToolResultV2,execute_tool,tool_catalog,tool_catalog_v2)
from .auth_routes import principal,write_principal
from .model_adapter import ToolCall
from .answer_grounding import GroundedAnswerV1,ground_answer
from .answer_cards import AnswerCardV1,AnswerLocale,render_answer

router=APIRouter()


@router.get("/v1/analysis/tools",response_model=AnalysisToolCatalogV1)
def catalog(user=Depends(principal)):
    return tool_catalog()


@router.post("/v1/analysis/tools/execute",response_model=AnalysisToolResultV1)
def execute(body:AnalysisToolRequestV1,request:Request,user=Depends(write_principal)):
    return dispatch(body,request,user)


@router.get("/v2/analysis/tools",response_model=AnalysisToolCatalogV2)
def catalog_v2(user=Depends(principal)):
    return tool_catalog_v2()


@router.post("/v2/analysis/tools/execute",response_model=AnalysisToolResultV2)
def execute_v2(body:AnalysisToolRequestV2,request:Request,user=Depends(write_principal)):
    return dispatch(body,request,user)


@router.post("/v2/analysis/tools/answer",response_model=GroundedAnswerV1)
def answer_v2(body:AnalysisToolRequestV2,request:Request,user=Depends(write_principal)):
    return ground_answer(dispatch(body,request,user))


@router.post("/v2/analysis/tools/answer/card",response_model=AnswerCardV1)
def answer_card_v2(body:AnalysisToolRequestV2,request:Request,locale:AnswerLocale="en",user=Depends(write_principal)):
    return render_answer(dispatch(body,request,user),locale)


def dispatch(body,request,user):
    config=request.app.state.settings
    clock_name={"insight_list":"insight_clock","insight_details":"insight_clock",
        "coaching_preferences":"coaching_clock","planning_read":"planning_clock"}.get(body.name,"bank_clock")
    clock=getattr(request.app.state,clock_name,None)
    now=clock() if clock else None
    return execute_tool(request.app.state.pools.finance,user,ToolCall(body.name,body.arguments),
        identity=request.app.state.identity,cursor_secret=config.session_secret.get_secret_value(),
        bank_secret=config.session_secret.get_secret_value(),maximum_age_hours=config.balance_maximum_age_hours,now=now)
