"""Owned dashboard observations, not a household balance or spending allowance."""
from datetime import datetime,timezone
from uuid import UUID,uuid4
from fastapi import APIRouter,Depends,Request
from pydantic import AwareDatetime,StrictBool,StrictInt,Field
from .auth_routes import principal,write_principal,AccountView
from .contracts import Contract,Minor
from .bank_sources import AccountSourceV1,source_evidence
from .bank_access import bank_account_access
from .identity import authorized_transaction,AuthError

router=APIRouter()

class DashboardBalance(Contract):
    amount_minor:Minor
    kind:str
    observed_at:AwareDatetime
    pending_reflection:str

class DashboardAccount(AccountView):
    source:AccountSourceV1|None=None
    balance:DashboardBalance|None=None
    access_status:str

class DashboardView(Contract):
    data_version:int
    synthetic:bool
    accounts:list[DashboardAccount]
    connected_bank_count:int=0
    live_banking_enabled:bool
    model_policy:str
    allow_ai_payment_descriptions:bool=False
    coverage:str="partial_or_unverified"

class InclusionChange(Contract):
    included:StrictBool
    expected_data_version:StrictInt=Field(ge=1,le=2**53-1)

@router.get("/v1/dashboard",response_model=DashboardView)
def dashboard(request:Request,user=Depends(principal)):
    owner=(user.scope.tenant_id,user.scope.user_id)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            rows=connection.execute("SELECT id,name,currency,account_type,included FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s ORDER BY id LIMIT 101",owner).fetchall()
            if len(rows)>100:raise AuthError("ACCOUNT_PAGINATION_REQUIRED",409)
            now=request.app.state.bank_clock() if hasattr(request.app.state,"bank_clock") else datetime.now(timezone.utc)
            sources=source_evidence(connection,user,[r[0] for r in rows],now=now)
            result=[]
            for identifier,name,currency,kind,included in rows:
                source=sources.get(identifier);balance=None;status="excluded" if not included else "no_observation"
                if included:
                    try:
                        bank_account_access(connection,user,[identifier],now=now)
                        # Never expose synthetic source money under a real identity.
                        permitted=(user.synthetic and source is None) or (source is not None and source.granted and (user.synthetic or source.mode!="synthetic"))
                        if permitted:
                            observation=connection.execute("""SELECT amount_minor,balance_kind,observed_at,pending_reflection FROM moneylens.balance_snapshots
                                WHERE tenant_id=%s AND owner_user_id=%s AND account_id=%s
                                AND (%s::uuid IS NULL OR connection_id=%s) AND observed_at<=%s ORDER BY observed_at DESC,id DESC LIMIT 1""",
                                (*owner,identifier,source.connection_id if source else None,source.connection_id if source else None,now)).fetchone()
                            if observation:balance=DashboardBalance(amount_minor=observation[0],kind=observation[1],observed_at=observation[2],pending_reflection=observation[3]);status="observed"
                        else:status="consent_required"
                    except AuthError as exc:
                        if exc.code not in ("BANK_ACCOUNT_ACCESS_REQUIRED","IMPORT_ACCOUNT_ACCESS_REQUIRED"):raise
                        status="consent_required"
                result.append(DashboardAccount(id=identifier,name=name,currency=currency,account_type=kind,included=included,source=source,balance=balance,access_status=status))
            state=connection.execute("SELECT data_version,allow_ai_payment_descriptions FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",owner).fetchone()
            connected=connection.execute("SELECT count(*) FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s AND consent_state='active'",owner).fetchone()[0]
    return DashboardView(data_version=state[0],synthetic=user.synthetic,accounts=result,connected_bank_count=connected,live_banking_enabled=request.app.state.settings.live_banking_enabled and not user.synthetic,model_policy=request.app.state.settings.model_billing_policy,allow_ai_payment_descriptions=state[1])


class AIPaymentDescriptionsChange(Contract):
    enabled:StrictBool


@router.post("/v1/settings/ai-payment-descriptions",response_model=DashboardView)
def ai_payment_descriptions(body:AIPaymentDescriptionsChange,request:Request,user=Depends(write_principal)):
    owner=(user.scope.tenant_id,user.scope.user_id)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            connection.execute("UPDATE moneylens.user_state SET allow_ai_payment_descriptions=%s WHERE tenant_id=%s AND owner_user_id=%s",
                (body.enabled,*owner))
    return dashboard(request,user)

@router.post("/v1/accounts/{identifier}/inclusion",response_model=DashboardView)
def inclusion(identifier:UUID,body:InclusionChange,request:Request,user=Depends(write_principal)):
    owner=(user.scope.tenant_id,user.scope.user_id)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            row=connection.execute("SELECT included FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*owner,identifier)).fetchone()
            if row is None:raise AuthError("NOT_FOUND",404)
            version=connection.execute("SELECT data_version FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",owner).fetchone()[0]
            if version!=body.expected_data_version:raise AuthError("DATA_VERSION_CHANGED",409)
            if row[0]!=body.included:
                connection.execute("UPDATE moneylens.accounts SET included=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(body.included,*owner,identifier))
                connection.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owner)
                connection.execute("INSERT INTO moneylens.audit_events (tenant_id,owner_user_id,id,action,resource_id,trace_id,metadata) VALUES (%s,%s,%s,'account.inclusion_changed',%s,%s,'{}')",(*owner,uuid4(),identifier,uuid4()))
    return dashboard(request,user)
