from fastapi import APIRouter,Depends,Request

from .auth_routes import principal,write_principal
from .coaching import CoachingCommandReceiptV1,CoachingPreferencesViewV1,SetCoachingPreferencesV1
from .coaching_store import CoachingStore

router=APIRouter()


def repository(request,connection,user):
    options={"clock":request.app.state.coaching_clock} if hasattr(request.app.state,"coaching_clock") else {}
    return CoachingStore(connection,user,**options)


@router.get("/v1/coaching/preferences",response_model=CoachingPreferencesViewV1)
def read(request:Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).read()


@router.post("/v1/coaching/preferences",response_model=CoachingCommandReceiptV1)
def update(body:SetCoachingPreferencesV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).set(body)
