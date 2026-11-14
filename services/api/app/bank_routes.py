"""Private, session-bound synthetic consent commands; no external bank calls."""
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import AwareDatetime, Field, StrictBool, StrictInt

from .auth_routes import JobStatusView, principal, write_principal
from .bank_adapter import BankAuthorizationV1, BankCapabilitiesV1, BankId, SourceReference
from .bank_store import BankStore
from .contracts import Contract
from .identity import authorized_transaction
from .planning_routes import CommandKey
from .synthetic_banks import Fault, SyntheticBank

router = APIRouter()


class BankConnectionV1(Contract):
    id: UUID
    institution_id: BankId
    mode: Literal["synthetic"]
    name: str
    consent_state: Literal["requested","authorizing","active","expired","revoked","denied"]
    generation: Annotated[StrictInt, Field(ge=1)]
    account_references: list[SourceReference] = Field(max_length=50)
    expires_at: AwareDatetime | None
    sync_health: Literal["never_synced","syncing","staged","fresh","stale","partial","error"]
    last_success_at: AwareDatetime | None
    last_error_code: str | None
    synthetic_fault: Fault
    refresh_job_id: UUID | None
    last_attempt_at: AwareDatetime | None
    source_observed_at: AwareDatetime | None
    staged_at: AwareDatetime | None


class StartBankConsentV1(Contract):
    key: CommandKey
    institution_id: BankId


class BankAuthorizationResultV1(Contract):
    connection: BankConnectionV1
    authorization: BankAuthorizationV1 | None
    state_token: str | None


class CompleteBankConsentV1(Contract):
    key: CommandKey
    state_token: str = Field(min_length=43,max_length=43,pattern=r"^[A-Za-z0-9_-]+$")
    approved: StrictBool
    account_references: list[SourceReference] = Field(max_length=50)


class SyntheticBankScenarioV1(Contract):
    fault: Fault


class RefreshBankV1(Contract):
    key: CommandKey


class BankRefreshResultV1(Contract):
    connection: BankConnectionV1
    job: JobStatusView
    coalesced: StrictBool
    financial_publication_complete: StrictBool


def repository(request,connection,user):
    options = {}
    if hasattr(request.app.state,"bank_clock"):
        options["clock"] = request.app.state.bank_clock
    return BankStore(connection,user,request.app.state.settings.session_secret.get_secret_value(),**options)


@router.get("/v1/banks",response_model=list[BankCapabilitiesV1])
def institutions(request: Request,user=Depends(principal)):
    # Discovery contains public simulator metadata, but still requires a current
    # synthetic principal. A guard that always rejects cannot grant data access.
    def no_access(*args):
        raise RuntimeError("Capability discovery cannot access bank data")
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user):
            repository(request,connection,user).current_synthetic()
    return [SyntheticBank(bank,no_access,"capability-metadata-only").capabilities() for bank in ("s-bank-demo","north-demo")]


@router.get("/v1/bank-connections",response_model=list[BankConnectionV1])
def connections(request: Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).list()


@router.post("/v1/bank-connections",response_model=BankAuthorizationResultV1)
def start(body: StartBankConsentV1,request: Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).start(body.institution_id,key=body.key)


@router.get("/v1/bank-connections/{connection_id}",response_model=BankConnectionV1)
def read(connection_id: UUID,request: Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).read(connection_id)


@router.post("/v1/bank-connections/{connection_id}/complete",response_model=BankConnectionV1)
def complete(connection_id: UUID,body: CompleteBankConsentV1,request: Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).complete(connection_id,**body.model_dump())


@router.post("/v1/bank-connections/{connection_id}/disconnect",response_model=BankConnectionV1)
def disconnect(connection_id: UUID,request: Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).disconnect(connection_id)


@router.post("/v1/bank-connections/{connection_id}/scenario",response_model=BankConnectionV1)
def scenario(connection_id: UUID,body: SyntheticBankScenarioV1,request: Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).control(connection_id,**body.model_dump())


@router.post("/v1/bank-connections/{connection_id}/refresh",response_model=BankRefreshResultV1)
def refresh(connection_id: UUID,body: RefreshBankV1,request: Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request,connection,user).refresh(connection_id,**body.model_dump())
