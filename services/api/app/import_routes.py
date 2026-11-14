"""Session-owned manifest commands; bulk bytes never pass through this API."""
from uuid import UUID
from typing import Annotated

from fastapi import APIRouter,Depends,Query,Request

from .auth_routes import principal,write_principal
from .identity import AuthError
from .import_contracts import (ImportActionV1,ImportReceiptV1,ImportUploadLinksV1,
    ImportUploadRequestV1,ImportViewV1,StartImportV1)
from .import_store import ImportStore
from .import_catalog import ImportCapabilitiesV1,ImportCatalog,ImportListV1,NativeAccountListV1
from .ledger import LedgerPageV1
from .ledger_routes import ledger_filters

router=APIRouter()


def repository(request,connection,user):
    options={"clock":request.app.state.import_clock} if hasattr(request.app.state,"import_clock") else {}
    return ImportStore(connection,user,settings=request.app.state.settings,**options)


@router.get("/v1/imports/capabilities",response_model=ImportCapabilitiesV1)
def capabilities(request:Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return ImportCatalog(connection,user,settings=request.app.state.settings).capabilities()


@router.get("/v1/imports",response_model=ImportListV1)
def list_imports(request:Request,before_id:UUID | None=None,limit:Annotated[int,Query(ge=1,le=50)]=20,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return ImportCatalog(connection,user,settings=request.app.state.settings).list(before_id=before_id,limit=limit)


@router.get("/v1/imports/{import_id}/publication/accounts",response_model=NativeAccountListV1)
def accounts(import_id:UUID,request:Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return ImportCatalog(connection,user,settings=request.app.state.settings).accounts(import_id)


@router.get("/v1/imports/{import_id}/publication/transactions",response_model=LedgerPageV1)
def transactions(import_id:UUID,request:Request,filters=Depends(ledger_filters),user=Depends(principal),
        cursor:Annotated[str | None,Query(max_length=4096)]=None,limit:Annotated[int,Query(ge=1,le=200)]=50):
    with request.app.state.pools.finance.connection() as connection:
        return ImportCatalog(connection,user,settings=request.app.state.settings).transactions(import_id,filters,cursor=cursor,limit=limit)


@router.post("/v1/imports",response_model=ImportReceiptV1,status_code=202)
def start(body:StartImportV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).start(body)


@router.get("/v1/imports/{import_id}",response_model=ImportViewV1)
def read(import_id:UUID,request:Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).read(import_id)


@router.post("/v1/imports/{import_id}/upload-links",response_model=ImportUploadLinksV1)
def upload_links(import_id:UUID,body:ImportUploadRequestV1,request:Request,user=Depends(write_principal)):
    objects=getattr(request.app.state,"import_objects",None)
    if objects is None: raise AuthError("IMPORT_UNAVAILABLE",503)
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).upload_links(import_id,objects)


@router.post("/v1/imports/{import_id}/submit",response_model=ImportReceiptV1,status_code=202)
def submit(import_id:UUID,body:ImportActionV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).action(import_id,body,"submit")


@router.post("/v1/imports/{import_id}/cancel",response_model=ImportReceiptV1)
def cancel(import_id:UUID,body:ImportActionV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).action(import_id,body,"cancel")
