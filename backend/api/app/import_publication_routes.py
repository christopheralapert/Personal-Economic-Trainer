from uuid import UUID

from fastapi import APIRouter,Depends,Request

from .auth_routes import principal,write_principal
from .import_contracts import ImportActionV1
from .import_publication_contracts import ImportPublicationReceiptV1,ImportPublicationViewV1
from .import_publication_store import ImportPublicationStore

router=APIRouter()


def repository(request,connection,user):
    options={"clock":request.app.state.import_clock} if hasattr(request.app.state,"import_clock") else {}
    return ImportPublicationStore(connection,user,settings=request.app.state.settings,**options)


@router.post("/v1/imports/{import_id}/publication",response_model=ImportPublicationReceiptV1,status_code=202)
def start(import_id:UUID,body:ImportActionV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).command(import_id,body,"start")


@router.get("/v1/imports/{import_id}/publication",response_model=ImportPublicationViewV1)
def read(import_id:UUID,request:Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).read(import_id)


@router.post("/v1/imports/{import_id}/publication/cancel",response_model=ImportPublicationReceiptV1)
def cancel(import_id:UUID,body:ImportActionV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).command(import_id,body,"cancel")
