"""Explicitly gated live AIS banking; synthetic identities cannot access it."""
from datetime import date, datetime, timedelta, timezone
import hashlib
import logging
import secrets
from typing import Annotated, Literal
from collections import OrderedDict
from threading import Lock
import time
from uuid import UUID,uuid4

from cryptography.fernet import Fernet,InvalidToken
from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import RedirectResponse
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import Field

from .auth_routes import principal, write_principal
from .contracts import Contract
from .identity import AuthError, authorized_transaction
from .live_banking_provider import EnableBankingClient, LiveProviderError
from .live_banking_publication import publish
from .live_banking_psu import manual_psu

router=APIRouter()
logger=logging.getLogger(__name__)


class ConnectLiveBank(Contract):
    country: Literal["EE","FI","LV","LT","SE"]
    name: str = Field(min_length=1,max_length=100)


class LiveBankLink(Contract):
    redirect_url: str
    notice: str = "Read-only bank data; continue at the bank and confirm account access there."


class LiveBankView(Contract):
    id: UUID
    name: str
    country: str
    consent_state: str
    account_count: int
    expires_at: datetime | None
    last_success_at: datetime | None
    sync_health: str
    last_error_code: str | None
    revocation_confirmed: bool | None = None
    mode: Literal["sandbox","live"]
    retry_not_before: datetime | None = None
    retry_after_known: bool = False
    retry_exhausted: bool = False
    import_in_progress: bool = False
    last_error_stage: str | None = None
    provider_error_code: str | None = None
    error_observed_at: datetime | None = None


class LiveRefresh(Contract):
    account_count: int
    booked_transactions: int
    observed_at: datetime
    coverage: Literal["partial"] = "partial"
    notice: str = "Imported bank observations are not proof of whole-finance coverage or a safe-to-spend amount."


class LiveImportPending(Contract):
    state: Literal["in_progress"] = "in_progress"
    notice: str = "This connection already has an import in progress. No second bank request was started. Check its status after it finishes."


def eligible(user):
    if user.synthetic:
        raise AuthError("LIVE_BANKS_VERIFIED_USERS_ONLY",403)


def client(request):
    s=request.app.state.settings
    if not s.live_banking_enabled:
        raise AuthError("LIVE_BANKS_DISABLED",503)
    factory=getattr(request.app.state,"live_bank_client",None)
    return factory() if factory else EnableBankingClient(s.enable_banking_app_id,s.enable_banking_private_key_pem.get_secret_value(),expected_environment=s.enable_banking_environment)


def revalidate(request,user):
    current=principal(request)
    if current.session_id!=user.session_id or current.scope!=user.scope or current.permission_version!=user.permission_version:
        raise AuthError("SESSION_CHANGED",409)


def vault(request):
    return Fernet(request.app.state.settings.live_banking_cipher_key.get_secret_value().encode())


def one(connection,owner,identifier,*,lock=False):
    with connection.cursor(row_factory=dict_row) as cursor:
        row=cursor.execute("""SELECT c.*, l.encrypted_session_id, l.refresh_until, l.retry_not_before,
            l.retry_after_known, l.limit_attempts, l.last_error_stage, l.provider_error_code, l.error_observed_at FROM moneylens.connections c
            LEFT JOIN moneylens.live_bank_sessions l ON (l.tenant_id,l.owner_user_id,l.connection_id)=(c.tenant_id,c.owner_user_id,c.id)
            WHERE c.tenant_id=%s AND c.owner_user_id=%s AND c.id=%s AND c.provider_mode IN ('sandbox','live') AND c.provider LIKE 'enable:%%'""" + (" FOR UPDATE OF c" if lock else ""),
            (*owner,identifier)).fetchone()
    if not row:
        raise AuthError("NOT_FOUND",404)
    return row


def owned(user):
    return (user.scope.tenant_id,user.scope.user_id)


def active(row):
    if row["consent_state"]!="active" or row["expires_at"] is None or row["expires_at"]<=datetime.now(timezone.utc) or not row["encrypted_session_id"]:
        raise AuthError("LIVE_CONSENT_NOT_ACTIVE",409)


def bank_name(row):
    _,country,name=row["provider"].split(":",2)
    return country,name


def view(row):
    country,name=bank_name(row)
    expired = row["consent_state"]=="active" and row["expires_at"] and row["expires_at"]<=datetime.now(timezone.utc)
    return LiveBankView(id=row["id"],mode=row["provider_mode"],country=country,name=name,consent_state="expired" if expired else row["consent_state"],
        account_count=len(row["scopes"]),expires_at=row["expires_at"],last_success_at=row["last_success_at"],
        sync_health=row["sync_health"],last_error_code=row["last_error_code"],
        retry_not_before=row.get("retry_not_before"),retry_after_known=bool(row.get("retry_after_known")),
        retry_exhausted=(row.get("limit_attempts") or 0)>=3 and not row.get("retry_after_known"),
        import_in_progress=bool(row.get("refresh_until") and row["refresh_until"]>datetime.now(timezone.utc)),
        last_error_stage=row.get("last_error_stage"),provider_error_code=row.get("provider_error_code"),error_observed_at=row.get("error_observed_at"),
        revocation_confirmed=None if row["consent_state"]!="revoked" else row["last_error_code"]!="bank_revocation_unconfirmed")


_rates=OrderedDict()
_rate_lock=Lock()
def rate(user,action,seconds):
    key=(str(user.scope.tenant_id),str(user.scope.user_id),action)
    now=time.monotonic()
    with _rate_lock:
        if now-_rates.get(key,-1e9)<seconds:raise AuthError("BANK_RATE_LIMITED",429)
        _rates[key]=now;_rates.move_to_end(key)
        while len(_rates)>2048:_rates.popitem(last=False)

@router.get("/v1/live-banking/capabilities")
def capabilities(request:Request,user=Depends(principal)):
    return {"enabled":request.app.state.settings.live_banking_enabled and not user.synthetic,
        "verified_identity_required":True,"read_only":True,"countries":["EE","FI","LV","LT","SE"],"currency":"EUR","environment":request.app.state.settings.enable_banking_environment}

@router.get("/v1/live-banking/institutions")
def institutions(request:Request,country:Literal["EE","FI","LV","LT","SE"]="EE",user=Depends(principal)):
    eligible(user)
    provider=client(request)
    rate(user,"directory",2)
    return provider.institutions(country)


@router.get("/v1/live-banking/connections",response_model=list[LiveBankView])
def connections(request:Request,user=Depends(principal)):
    eligible(user)
    client(request)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user):
            with connection.cursor(row_factory=dict_row) as cursor:
                rows=cursor.execute("""SELECT c.*, l.refresh_until, l.retry_not_before, l.retry_after_known, l.limit_attempts,
                    l.last_error_stage, l.provider_error_code, l.error_observed_at FROM moneylens.connections c
                    LEFT JOIN moneylens.live_bank_sessions l ON (l.tenant_id,l.owner_user_id,l.connection_id)=(c.tenant_id,c.owner_user_id,c.id)
                    WHERE c.tenant_id=%s AND c.owner_user_id=%s AND c.provider_mode IN ('sandbox','live') AND c.provider LIKE 'enable:%%' ORDER BY c.created_at DESC LIMIT 50""",owned(user)).fetchall()
    return [view(r) for r in rows]


@router.post("/v1/live-banking/connect",response_model=LiveBankLink)
def connect(body:ConnectLiveBank,request:Request,user=Depends(write_principal)):
    eligible(user)
    provider=client(request)
    rate(user,"connect",5)
    callback=request.app.state.settings.app_origin+"/api/v1/live-banking/callback"
    environment=provider.application(callback)
    mode="live" if environment=="production" else "sandbox"
    institution=next((item for item in provider.institutions(body.country) if item["name"]==body.name),None)
    if institution is None:raise AuthError("BANK_NOT_AVAILABLE_IN_COUNTRY",422)
    raw_state=secrets.token_urlsafe(32)
    identifier=uuid4()
    owner=owned(user)
    now=datetime.now(timezone.utc)
    name="enable:"+body.country+":"+body.name
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            mismatch=connection.execute("""SELECT 1 FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s
                AND provider LIKE 'enable:%%' AND provider_mode<>%s LIMIT 1""",(*owner,mode)).fetchone()
            if mismatch:raise AuthError("BANK_ENVIRONMENT_CONFLICT",409)
            rows=connection.execute("""SELECT id FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s LIMIT 50""",owner).fetchall()
            if len(rows)>=50:
                raise AuthError("BANK_CONNECTION_LIMIT",409)
            connection.execute("""UPDATE moneylens.connections SET consent_state='expired',consent_generation=consent_generation+1
                WHERE tenant_id=%s AND owner_user_id=%s AND provider=%s AND provider_mode IN ('sandbox','live')
                AND ((consent_state='active' AND expires_at<=clock_timestamp()) OR (consent_state='authorizing' AND authorization_expires_at<=clock_timestamp()))""",(*owner,name))
            open_bank=connection.execute("""SELECT id FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s
                AND provider=%s AND provider_mode IN ('sandbox','live') AND consent_state IN ('requested','authorizing','active')""",(*owner,name)).fetchone()
            if open_bank:
                raise AuthError("BANK_CONNECTION_EXISTS",409)
            connection.execute("""INSERT INTO moneylens.connections
                (tenant_id,owner_user_id,id,provider,provider_mode,consent_state,authorization_session_id,
                 authorization_expires_at,callback_hash,sync_health)
                VALUES (%s,%s,%s,%s,%s,'authorizing',%s,%s,%s,'never_synced')""",
                (*owner,identifier,name,mode,user.session_id,now+timedelta(minutes=10),hashlib.sha256(raw_state.encode()).hexdigest()))
    callback=request.app.state.settings.app_origin+"/api/v1/live-banking/callback"
    try:
        link=provider.start(name=body.name,country=body.country,state=raw_state,callback=callback,maximum_consent_validity=institution["maximum_consent_validity"])
    except LiveProviderError:
        with request.app.state.pools.finance.connection() as connection:
            with authorized_transaction(connection,user,write=True):
                connection.execute("""UPDATE moneylens.connections SET consent_state='denied',callback_hash=NULL
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND consent_state='authorizing'""",(*owner,identifier))
        raise
    return LiveBankLink(redirect_url=link)


@router.get("/v1/live-banking/callback")
def callback(request:Request,state:Annotated[str | None,Query(max_length=200)]=None,
             code:Annotated[str | None,Query(max_length=1024)]=None,
             error:Annotated[str | None,Query(max_length=100)]=None,user=Depends(principal)):
    eligible(user)
    provider=client(request)
    if state is None or len(state)<30 or any(len(request.query_params.getlist(key))>1 for key in ("state","code","error")):
        raise AuthError("BANK_CALLBACK_REJECTED",403)
    digest=hashlib.sha256(state.encode()).hexdigest()
    owner=owned(user)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            with connection.cursor(row_factory=dict_row) as cursor:
                bank=cursor.execute("""SELECT * FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s
                    AND provider_mode IN ('sandbox','live') AND provider LIKE 'enable:%%' AND consent_state='authorizing' AND callback_hash=%s
                    AND callback_consumed_at IS NULL AND authorization_expires_at>clock_timestamp()
                    AND authorization_session_id=%s FOR UPDATE""",(*owner,digest,user.session_id)).fetchone()
            if not bank:
                raise AuthError("BANK_CALLBACK_REJECTED",403)
            connection.execute("""UPDATE moneylens.connections SET callback_consumed_at=clock_timestamp(),callback_hash=NULL
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(*owner,bank["id"]))
    if error is not None or code is None:
        with request.app.state.pools.finance.connection() as connection:
            with authorized_transaction(connection,user,write=True):
                connection.execute("""UPDATE moneylens.connections SET consent_state='denied'
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND consent_state='authorizing'""",(*owner,bank["id"]))
        return RedirectResponse(request.app.state.settings.app_origin+"/banks?live_status=denied",status_code=303)
    expected_country,expected_name=bank_name(bank)
    try:
        session_id,account_ids,expires_at=provider.authorize(code,expected_name=expected_name,expected_country=expected_country)
    except LiveProviderError:
        with request.app.state.pools.finance.connection() as connection:
            with authorized_transaction(connection,user,write=True):
                connection.execute("""UPDATE moneylens.connections SET consent_state='denied',last_error_code='bank_authorization_failed'
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND consent_state='authorizing'""",(*owner,bank["id"]))
        return RedirectResponse(request.app.state.settings.app_origin+"/banks?live_status=failed",status_code=303)
    try:
        revalidate(request,user)
        with request.app.state.pools.finance.connection() as connection:
            with authorized_transaction(connection,user,write=True):
                current=one(connection,owner,bank["id"])
                if current["consent_state"]!="authorizing" or current["authorization_session_id"]!=user.session_id or not current["callback_consumed_at"]:
                    raise AuthError("BANK_CALLBACK_REJECTED",403)
                connection.execute("""INSERT INTO moneylens.live_bank_sessions
                    (tenant_id,owner_user_id,connection_id,encrypted_session_id) VALUES (%s,%s,%s,%s)""",
                    (*owner,bank["id"],vault(request).encrypt(session_id.encode()).decode()))
                connection.execute("""UPDATE moneylens.connections SET consent_state='active',scopes=%s,expires_at=%s,
                    authorization_session_id=NULL,authorization_expires_at=NULL,consent_generation=consent_generation+1
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                    (Jsonb(account_ids),expires_at,*owner,bank["id"]))
    except Exception:
        # Never activate a local grant after logout/revocation while the provider
        # was answering. Best-effort remote cleanup; the original error wins.
        try:provider.revoke(session_id)
        except LiveProviderError:pass
        raise
    # UI hint only. The next request still resolves this connection under the
    # verified session's owner; this identifier confers no access.
    return RedirectResponse(request.app.state.settings.app_origin+f"/banks?live_status=connected&connection={bank['id']}",status_code=303)


@router.post("/v1/live-banking/connections/{identifier}/refresh",response_model=LiveRefresh|LiveImportPending)
def refresh(identifier:UUID,request:Request,response:Response,user=Depends(write_principal)):
    eligible(user);provider=client(request);owner=owned(user);lease=uuid4()
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            bank=one(connection,owner,identifier,lock=True);active(bank);generation=bank["consent_generation"]
            now=datetime.now(timezone.utc)
            if bank["refresh_until"] and bank["refresh_until"]>now:
                response.status_code=202
                return LiveImportPending()
            if (bank["limit_attempts"] or 0)>=3 and not bank["retry_after_known"]:
                error=LiveProviderError("BANK_RETRY_REVIEW_REQUIRED",429,stage="local_cooldown")
                error.wait={"retry_not_before":None,"retry_after_known":False,"retry_exhausted":True}
                raise error
            if bank["retry_not_before"] and bank["retry_not_before"]>now:
                error=LiveProviderError("BANK_IMPORT_WAIT",429,stage="local_cooldown",retry_at=bank["retry_not_before"])
                error.wait={"retry_not_before":bank["retry_not_before"].isoformat(),"retry_after_known":bank["retry_after_known"],"retry_exhausted":False}
                raise error
            if bank["last_attempt_at"] and datetime.now(timezone.utc)-bank["last_attempt_at"]<timedelta(seconds=60):
                raise AuthError("BANK_REFRESH_THROTTLED",429)
            try:remote_id=vault(request).decrypt(bank["encrypted_session_id"].encode()).decode()
            except (InvalidToken,ValueError,UnicodeDecodeError):raise AuthError("BANK_SESSION_UNAVAILABLE",409) from None
            claim=connection.execute("""UPDATE moneylens.live_bank_sessions SET refresh_token=%s,refresh_until=clock_timestamp()+interval '2 minutes'
                WHERE tenant_id=%s AND owner_user_id=%s AND connection_id=%s
                AND (refresh_until IS NULL OR refresh_until<clock_timestamp()) RETURNING connection_id""",(lease,*owner,identifier)).fetchone()
            if not claim:raise AuthError("BANK_REFRESH_IN_PROGRESS",409)
            connection.execute("""UPDATE moneylens.connections SET last_attempt_at=clock_timestamp(),sync_health='syncing'
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(*owner,identifier))
    try:
        country,name=bank_name(bank)
        provider.configure_psu(manual_psu(request),country,name)
        accounts,expiry,identities=provider.verify_session(remote_id,expected_name=name,expected_country=country)
        if set(accounts)!=set(bank["scopes"]):raise LiveProviderError("BANK_SESSION_MISMATCH",409)
        today=datetime.now(timezone.utc).date()
        observations=[provider.fetch_account(account,from_date=today-timedelta(days=89),to_date=today,identity_ref=identities[account]) for account in accounts]
        revalidate(request,user)
        with request.app.state.pools.finance.connection() as connection:
            with authorized_transaction(connection,user,write=True):
                latest=one(connection,owner,identifier);active(latest)
                held=connection.execute("""SELECT 1 FROM moneylens.live_bank_sessions WHERE tenant_id=%s AND owner_user_id=%s
                    AND connection_id=%s AND refresh_token=%s AND refresh_until>clock_timestamp()""",(*owner,identifier,lease)).fetchone()
                if not held or latest["consent_generation"]!=generation or latest["scopes"]!=bank["scopes"]:raise AuthError("BANK_CONSENT_CHANGED",409)
                count=publish(connection,user,latest,observations)
                connection.execute("""UPDATE moneylens.live_bank_sessions SET retry_not_before=NULL,retry_after_known=false,
                    limit_attempts=0,last_error_stage=NULL,provider_error_code=NULL,provider_request_id=NULL,error_observed_at=NULL
                    WHERE tenant_id=%s AND owner_user_id=%s AND connection_id=%s""",(*owner,identifier))
                connection.execute("""UPDATE moneylens.connections SET expires_at=least(expires_at,%s)
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(expiry,*owner,identifier))
        notice = {}
        if any(item.get("source_account_currency")=="XXX" for item in observations):
            notice["notice"] = "All returned balances and imported booked entries were verified as EUR. The bank leaves the account's general currency unspecified. History remains partial."
        return LiveRefresh(account_count=len(observations),booked_transactions=count,observed_at=max(o["observed_at"] for o in observations),**notice)
    except (LiveProviderError,AuthError) as exc:
        with request.app.state.pools.finance.connection() as connection:
            with authorized_transaction(connection,user,write=True):
                expired=exc.code=="BANK_CONSENT_EXPIRED"
                updated=connection.execute("""UPDATE moneylens.connections SET sync_health='error',last_error_code=%s,
                    consent_state=CASE WHEN %s THEN 'expired' ELSE consent_state END,
                    consent_generation=consent_generation+%s
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND consent_generation=%s AND consent_state='active'""",
                    (exc.code.lower()[:64],expired,int(expired),*owner,identifier,generation))
                if expired and updated.rowcount:
                    connection.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owner)
                if updated.rowcount:
                    limited=exc.code in ("BANK_PROVIDER_THROTTLED","BANK_ASPSP_RATE_LIMIT_EXCEEDED")
                    attempts=min(3,(bank["limit_attempts"] or 0)+1) if limited else 0
                    retry_at=exc.retry_at if limited and exc.retry_at else datetime.now(timezone.utc)+timedelta(minutes=15*2**(attempts-1)) if limited else None
                    known=bool(limited and exc.retry_at)
                    connection.execute("""UPDATE moneylens.live_bank_sessions SET retry_not_before=%s,retry_after_known=%s,
                        limit_attempts=%s,last_error_stage=%s,provider_error_code=%s,provider_request_id=%s,error_observed_at=clock_timestamp()
                        WHERE tenant_id=%s AND owner_user_id=%s AND connection_id=%s""",
                        (retry_at,known,attempts,getattr(exc,"stage",None) or "session_verification",getattr(exc,"provider_code",None),getattr(exc,"request_id",None),*owner,identifier))
                    if limited:
                        exc.wait={"retry_not_before":retry_at.isoformat(),"retry_after_known":known,"retry_exhausted":attempts>=3 and not known}
                    logger.warning("BANK_IMPORT_FAILURE %s", {"code":exc.code,"stage":getattr(exc,"stage",None) or "session_verification",
                        "at_utc":datetime.now(timezone.utc).isoformat(),"provider_request_id":getattr(exc,"request_id",None)})
        raise
    finally:
        try:
            with request.app.state.pools.finance.connection() as connection:
                with authorized_transaction(connection,user,write=True):
                    connection.execute("""UPDATE moneylens.live_bank_sessions SET refresh_token=NULL,refresh_until=NULL
                        WHERE tenant_id=%s AND owner_user_id=%s AND connection_id=%s AND refresh_token=%s""",(*owner,identifier,lease))
        except AuthError:
            # A removed membership must not be bypassed just to clear a lease.
            # The bounded lease expires without publishing any financial data.
            pass

@router.post("/v1/live-banking/connections/{identifier}/disconnect",response_model=LiveBankView)
def disconnect(identifier:UUID,request:Request,user=Depends(write_principal)):
    eligible(user);provider=client(request);owner=owned(user)
    # Revoke local access first. A remote failure must never keep local reads enabled.
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            bank=one(connection,owner,identifier)
            connection.execute("""UPDATE moneylens.connections SET consent_state='revoked',consent_generation=consent_generation+1,
                callback_hash=NULL,expires_at=NULL,revoked_at=clock_timestamp(),authorization_session_id=NULL,
                authorization_expires_at=NULL,sync_health='stale',last_error_code='bank_revocation_unconfirmed'
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(*owner,identifier))
            connection.execute("""UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s""",owner)
    confirmed=not bank["encrypted_session_id"]
    if not confirmed:
        try:
            provider.revoke(vault(request).decrypt(bank["encrypted_session_id"].encode()).decode());confirmed=True
        except (LiveProviderError,InvalidToken,UnicodeDecodeError):pass
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            if confirmed:
                connection.execute("""DELETE FROM moneylens.live_bank_sessions WHERE tenant_id=%s AND owner_user_id=%s AND connection_id=%s""",(*owner,identifier))
                connection.execute("""UPDATE moneylens.connections SET last_error_code=NULL WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(*owner,identifier))
            return view(one(connection,owner,identifier))

@router.get("/v1/live-banking/connections/{identifier}/data")
def connection_data(identifier:UUID,request:Request,user=Depends(principal)):
    eligible(user);client(request);owner=owned(user)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            bank=one(connection,owner,identifier);active(bank)
            with connection.cursor(row_factory=dict_row) as cursor:
                accounts=cursor.execute("""SELECT a.id,a.name,a.currency,a.included,b.amount_minor,b.balance_kind,b.observed_at
                    FROM moneylens.accounts a JOIN moneylens.account_source_aliases alias
                      ON (alias.tenant_id,alias.owner_user_id,alias.account_id)=(a.tenant_id,a.owner_user_id,a.id)
                    LEFT JOIN LATERAL (SELECT amount_minor,balance_kind,observed_at FROM moneylens.balance_snapshots
                      WHERE tenant_id=a.tenant_id AND owner_user_id=a.owner_user_id AND account_id=a.id AND connection_id=%s
                      AND a.included ORDER BY observed_at DESC,id DESC LIMIT 1) b ON true
                    WHERE a.tenant_id=%s AND a.owner_user_id=%s AND alias.connection_id=%s
                    AND alias.provider_account_id=ANY(%s) ORDER BY a.id LIMIT 10""",
                    (identifier,*owner,identifier,bank["scopes"])).fetchall()
                rows=cursor.execute("""SELECT t.id,t.account_id,t.amount_minor,t.currency,t.booked_on,t.merchant,t.category,t.basket,t.economic_flow
                    FROM moneylens.transactions t JOIN moneylens.accounts a
                      ON (a.tenant_id,a.owner_user_id,a.id)=(t.tenant_id,t.owner_user_id,t.account_id)
                    WHERE t.tenant_id=%s AND t.owner_user_id=%s AND t.connection_id=%s AND a.included AND t.account_id=ANY(%s)
                    ORDER BY t.booked_on DESC,t.id DESC LIMIT 50""",(*owner,identifier,[account["id"] for account in accounts])).fetchall()
            return {"accounts":accounts,"transactions":rows,"coverage":"partial","transaction_limit":50}
