"""Explicit private rule previews; no scheduled delivery or model traffic."""
from datetime import datetime,timezone

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter,Depends,Query,Request

from .analysis_inputs import AnalysisWindowV1
from .auth_routes import JobStatusView,principal,write_principal
from .identity import authorized_transaction
from .insights import PlanningInsightPreviewV1,SpendingInsightPreviewV1
from .insight_queries import planning_preview as load_planning_preview,spending_preview as load_spending_preview
from .insight_records import DismissInsightV1,InsightCommandReceiptV1,InsightPageV1,InsightStatus,InsightViewV1,RefreshInsightsV1
from .insight_store import InsightStore
from .scoped_keys import CursorCodec

router=APIRouter()


@router.get("/v1/insights/planning-preview",response_model=PlanningInsightPreviewV1)
def planning_preview(request:Request,user=Depends(principal)):
    now=request.app.state.planning_clock() if hasattr(request.app.state,"planning_clock") else datetime.now(timezone.utc)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            return load_planning_preview(connection,user,now)


@router.post("/v1/insights/spending-preview",response_model=SpendingInsightPreviewV1)
def spending_preview(body:AnalysisWindowV1,request:Request,user=Depends(write_principal)):
    now=request.app.state.bank_clock() if hasattr(request.app.state,"bank_clock") else datetime.now(timezone.utc)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            return load_spending_preview(connection,user,body,now,request.app.state.settings.balance_maximum_age_hours)


def repository(request,connection,user):
    options={"clock":request.app.state.insight_clock} if hasattr(request.app.state,"insight_clock") else {}
    return InsightStore(connection,user,maximum_age_hours=request.app.state.settings.balance_maximum_age_hours,**options)


@router.get("/v1/insights",response_model=InsightPageV1)
def list_insights(request:Request,user=Depends(principal),status:InsightStatus="active",
    cursor:Annotated[str|None,Query(max_length=4096)]=None,limit:Annotated[int,Query(ge=1,le=100)]=50):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).page(CursorCodec(request.app.state.settings.session_secret.get_secret_value()),status=status,cursor=cursor,limit=limit)


@router.post("/v1/insights/refresh",response_model=JobStatusView)
def refresh(body:RefreshInsightsV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).request_refresh(body)


@router.get("/v1/insights/{insight_id}",response_model=InsightViewV1)
def read_insight(insight_id:UUID,request:Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).read(insight_id)


@router.post("/v1/insights/{insight_id}/dismiss",response_model=InsightCommandReceiptV1)
def dismiss(insight_id:UUID,body:DismissInsightV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).dismiss(insight_id,body)
