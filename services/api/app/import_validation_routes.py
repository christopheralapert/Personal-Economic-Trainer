"""Owned native validation commands and bounded progress/rejection reads."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter,Depends,Query,Request

from .auth_routes import principal,write_principal
from .import_contracts import ImportActionV1
from .import_validation_contracts import ImportRejectionsV1,ImportValidationReceiptV1,ImportValidationViewV1
from .import_validation_store import ImportValidationStore

router=APIRouter()


def repository(request,connection,user):
    options={"clock":request.app.state.import_clock} if hasattr(request.app.state,"import_clock") else {}
    return ImportValidationStore(connection,user,settings=request.app.state.settings,**options)


@router.post("/v1/imports/{import_id}/validation",response_model=ImportValidationReceiptV1,status_code=202)
def start(import_id:UUID,body:ImportActionV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).command(import_id,body,"start")


@router.get("/v1/imports/{import_id}/validation",response_model=ImportValidationViewV1)
def read(import_id:UUID,request:Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).read(import_id)


@router.post("/v1/imports/{import_id}/validation/cancel",response_model=ImportValidationReceiptV1)
def cancel(import_id:UUID,body:ImportActionV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).command(import_id,body,"cancel")


@router.get("/v1/imports/{import_id}/validation/rejections",response_model=ImportRejectionsV1)
def rejections(import_id:UUID,request:Request,after:Annotated[int,Query(ge=0,le=30000000)]=0,
        limit:Annotated[int,Query(ge=1,le=100)]=50,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).rejections(import_id,after=after,limit=limit)
