from typing import Annotated
from uuid import UUID

from fastapi import APIRouter,Depends,Query,Request

from .auth_routes import principal,write_principal
from .goal_store import GoalStore
from .goals import (CreateGoalV1,GoalAllocationCommandReceiptV1,GoalAllocationPageV1,GoalCommandReceiptV1,
    GoalPageV1,GoalState,GoalVersionedCommandV1,GoalViewV1,ReviseGoalV1,SetGoalStateV1,UnlinkGoalAllocationV1)
from .scoped_keys import CursorCodec

router=APIRouter()


def repository(request,connection,user):
    options={"clock":request.app.state.goal_clock} if hasattr(request.app.state,"goal_clock") else {}
    return GoalStore(connection,user,**options)


@router.get("/v1/goals",response_model=GoalPageV1)
def goals(request:Request,user=Depends(principal),state:GoalState|None=None,
    currency:Annotated[str|None,Query(pattern="^[A-Z]{3}$")]=None,
    cursor:Annotated[str|None,Query(max_length=4096)]=None,limit:Annotated[int,Query(ge=1,le=100)]=50):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).page(CursorCodec(request.app.state.settings.session_secret.get_secret_value()),
            state=state,currency=currency,cursor=cursor,limit=limit)


@router.get("/v1/goals/{goal_id}",response_model=GoalViewV1)
def read(goal_id:UUID,request:Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).read(goal_id)


@router.post("/v1/goals",response_model=GoalCommandReceiptV1)
def create(body:CreateGoalV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).create(body)


@router.post("/v1/goals/{goal_id}/revise",response_model=GoalCommandReceiptV1)
def revise(goal_id:UUID,body:ReviseGoalV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).mutate(goal_id,body,action="revise")


@router.post("/v1/goals/{goal_id}/state",response_model=GoalCommandReceiptV1)
def set_state(goal_id:UUID,body:SetGoalStateV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).mutate(goal_id,body,action="set_state")


@router.post("/v1/goals/{goal_id}/remove",response_model=GoalCommandReceiptV1)
def remove(goal_id:UUID,body:GoalVersionedCommandV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).mutate(goal_id,body,action="remove")


@router.get("/v1/goals/{goal_id}/allocations",response_model=GoalAllocationPageV1)
def allocations(goal_id:UUID,request:Request,user=Depends(principal),
    cursor:Annotated[str|None,Query(max_length=4096)]=None,limit:Annotated[int,Query(ge=1,le=100)]=50):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).allocations(goal_id,CursorCodec(request.app.state.settings.session_secret.get_secret_value()),
            cursor=cursor,limit=limit)


@router.post("/v1/goals/{goal_id}/allocations/{allocation_id}/link",response_model=GoalAllocationCommandReceiptV1)
def link(goal_id:UUID,allocation_id:UUID,body:GoalVersionedCommandV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).assign(goal_id,allocation_id,body)


@router.post("/v1/goals/{goal_id}/allocations/{allocation_id}/unlink",response_model=GoalAllocationCommandReceiptV1)
def unlink(goal_id:UUID,allocation_id:UUID,body:UnlinkGoalAllocationV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).assign(goal_id,allocation_id,body,unlink=True)
