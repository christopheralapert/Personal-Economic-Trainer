import hmac
import secrets
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import AwareDatetime

from .contracts import Contract, Owner
from .identity import AuthError, DEMO_ISSUER, DEMO_SUBJECTS, authorized_transaction
from .jobs import JobStore
from .bank_sources import AccountSourceV1, source_evidence

router = APIRouter()


class DemoLogin(Contract):
    profile: Literal["aino","mika"]


class SessionView(Contract):
    session_id: UUID
    owner: Owner
    display_name: str
    synthetic: bool
    permission_version: int
    expires_at: AwareDatetime
    csrf_token: str


class AccountView(Contract):
    id: UUID
    name: str
    currency: str
    account_type: str
    included: bool


class AccountWithSourceV1(AccountView):
    source: AccountSourceV1 | None = None


class JobStatusView(Contract):
    id: UUID
    type: str
    state: Literal["queued","running","completed","failed","cancelled","dead_letter"]
    attempts: int
    max_attempts: int
    available_at: AwareDatetime
    lease_until: AwareDatetime | None
    finished_at: AwareDatetime | None
    last_error_code: str | None


class CancellationResult(Contract):
    cancelled: bool


def cookie_name(settings, binding=False):
    prefix = "__Host-" if settings.app_origin.startswith("https://") else ""
    return prefix + ("moneylens_login" if binding else "moneylens_session")


def set_cookie(response, settings, value, binding=False):
    response.set_cookie(cookie_name(settings,binding),value,max_age=600 if binding else settings.session_seconds,
        secure=settings.app_origin.startswith("https://"),httponly=True,samesite="lax",path="/")


def clear_cookie(response, settings, binding=False):
    response.delete_cookie(cookie_name(settings,binding),path="/",secure=settings.app_origin.startswith("https://"),httponly=True,samesite="lax")


def check_origin(request):
    origin = request.headers.get("origin")
    expected = request.app.state.settings.app_origin
    if origin != expected or request.headers.get("sec-fetch-site") == "cross-site":
        raise AuthError("ORIGIN_REJECTED",403)


def principal(request: Request):
    config = request.app.state.settings
    origin = request.headers.get("origin")
    if origin is not None and origin != config.app_origin:
        raise AuthError("ORIGIN_REJECTED",403)
    user = request.app.state.identity.resolve(request.cookies.get(cookie_name(config)))
    expected = request.headers.get("x-moneylens-session-id")
    if expected is not None and (len(expected)!=36 or not expected.isascii() or not hmac.compare_digest(expected,str(user.session_id))):
        raise AuthError("SESSION_CHANGED",409)
    return user


def write_principal(request: Request, user=Depends(principal)):
    check_origin(request)
    token = request.headers.get("x-csrf-token","")
    if len(token)>128 or not token.isascii() or not hmac.compare_digest(token,request.app.state.identity.csrf(user.token)):
        raise AuthError("CSRF_REJECTED",403)
    return user


@router.get("/v1/auth/session",response_model=SessionView)
def read_session(request: Request, user=Depends(principal)):
    return SessionView(session_id=user.session_id,owner=Owner(tenant_id=user.scope.tenant_id,user_id=user.scope.user_id),
        display_name=user.display_name,synthetic=user.synthetic,permission_version=user.permission_version,
        expires_at=user.expires_at,csrf_token=request.app.state.identity.csrf(user.token))


@router.post("/v1/auth/demo",response_model=SessionView)
def demo_login(body: DemoLogin, request: Request):
    config = request.app.state.settings
    if not config.allow_demo:
        raise AuthError("NOT_FOUND",404)
    check_origin(request)
    token = request.app.state.identity.login(DEMO_ISSUER,DEMO_SUBJECTS[body.profile],synthetic=True,
        previous=request.cookies.get(cookie_name(config)))
    user = request.app.state.identity.resolve(token)
    response = JSONResponse(SessionView(session_id=user.session_id,owner=Owner(tenant_id=user.scope.tenant_id,user_id=user.scope.user_id),
        display_name=user.display_name,synthetic=True,permission_version=user.permission_version,
        expires_at=user.expires_at,csrf_token=request.app.state.identity.csrf(token)).model_dump(mode="json"))
    set_cookie(response,config,token)
    return response


@router.post("/v1/auth/logout",status_code=204)
def logout(request: Request, user=Depends(write_principal)):
    request.app.state.identity.revoke(user.token)
    response = Response(status_code=204)
    clear_cookie(response,request.app.state.settings)
    return response


@router.get("/v1/auth/login")
def login(request: Request, prompt: Literal["login"] | None = None):
    config = request.app.state.settings
    if not config.oidc_issuer:
        raise AuthError("IDENTITY_PROVIDER_UNAVAILABLE",503)
    binding = secrets.token_urlsafe(32)
    state = request.app.state.identity.begin_login(binding)
    target = request.app.state.oidc.authorization_url(state,reauthenticate=True) if prompt else request.app.state.oidc.authorization_url(state)
    response = RedirectResponse(target,status_code=303)
    set_cookie(response,config,binding,binding=True)
    return response


@router.get("/v1/auth/callback")
def callback(request: Request):
    config = request.app.state.settings
    if not config.oidc_issuer:
        raise AuthError("NOT_FOUND",404)
    query = request.query_params
    if any(len(query.getlist(name)) != 1 for name in ("code","state")) or "error" in query:
        raise AuthError("INVALID_LOGIN_RESPONSE",400)
    if "iss" in query and (len(query.getlist("iss")) != 1 or query["iss"] != config.oidc_issuer):
        raise AuthError("INVALID_LOGIN_RESPONSE",400)
    request.app.state.identity.consume_login(query["state"],request.cookies.get(cookie_name(config,True)))
    subject = request.app.state.oidc.exchange(query["code"],query["state"])
    previous = request.cookies.get(cookie_name(config))
    try:
        token = request.app.state.identity.login_oidc(subject,previous=previous)
    except AuthError as exc:
        if exc.code != "MEMBERSHIP_UNAVAILABLE":
            raise
        # Verification cannot override an unavailable or blocked membership.
        # Do not leave another account's previous browser session active.
        if previous:
            request.app.state.identity.revoke(previous)
        response = RedirectResponse(config.app_origin+"/access",status_code=303)
        clear_cookie(response,config)
        clear_cookie(response,config,binding=True)
        return response
    response = RedirectResponse(config.app_origin+"/",status_code=303)
    set_cookie(response,config,token)
    clear_cookie(response,config,binding=True)
    return response


@router.get("/v1/accounts",response_model=list[AccountView])
def accounts(request: Request, user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user):
            rows = connection.execute("""SELECT id,name,currency,account_type,included FROM moneylens.accounts
                WHERE tenant_id=%s AND owner_user_id=%s ORDER BY id LIMIT 101""",(user.scope.tenant_id,user.scope.user_id)).fetchall()
            if len(rows)>100:
                raise AuthError("ACCOUNT_PAGINATION_REQUIRED",409)
            return [AccountView(id=row[0],name=row[1],currency=row[2],account_type=row[3],included=row[4]) for row in rows]


@router.get("/v1/accounts/sources",response_model=list[AccountWithSourceV1])
def accounts_with_sources(request: Request,user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user):
            rows=connection.execute("""SELECT id,name,currency,account_type,included FROM moneylens.accounts
                WHERE tenant_id=%s AND owner_user_id=%s ORDER BY id LIMIT 101""",(user.scope.tenant_id,user.scope.user_id)).fetchall()
            if len(rows)>100:
                raise AuthError("ACCOUNT_PAGINATION_REQUIRED",409)
            now=request.app.state.bank_clock() if hasattr(request.app.state,"bank_clock") else None
            sources=source_evidence(connection,user,[row[0] for row in rows],now=now,
                maximum_age_hours=request.app.state.settings.balance_maximum_age_hours)
            return [AccountWithSourceV1(id=row[0],name=row[1],currency=row[2],account_type=row[3],included=row[4],source=sources.get(row[0])) for row in rows]


@router.get("/v1/jobs/{job_id}",response_model=JobStatusView)
def job_status(job_id: UUID, request: Request, user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user):
            result = JobStore(connection,user.scope).status(job_id)
            if not result:
                raise AuthError("NOT_FOUND",404)
            return result


@router.post("/v1/jobs/{job_id}/cancel",response_model=CancellationResult)
def cancel_job(job_id: UUID, request: Request, user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user):
            store = JobStore(connection,user.scope)
            if not store.status(job_id):
                raise AuthError("NOT_FOUND",404)
            return {"cancelled":store.cancel(job_id)}


def document_security(api,settings,*,extra_routers=()):
    """Keep generated clients aware of cookie/CSRF requirements enforced at runtime."""
    original = api.openapi
    def depends_on(dependency, target):
        return dependency.call is target or any(depends_on(child,target) for child in dependency.dependencies)
    def schema():
        document = original()
        document.setdefault("components",{}).setdefault("securitySchemes",{})["SessionCookie"] = {
            "type":"apiKey","in":"cookie","name":cookie_name(settings),
            "description":"Opaque HttpOnly session; browser storage never holds a provider token.",
        }
        # Inspect our public APIRouter directly; FastAPI can include routers lazily.
        for route in [*api.routes,*router.routes,*(route for included in extra_routers for route in included.routes)]:
            dependency = getattr(route,"dependant",None)
            if dependency is None or route.path not in document["paths"]:
                continue
            authenticated = depends_on(dependency,principal)
            csrf = depends_on(dependency,write_principal)
            for method in route.methods:
                operation = document["paths"][route.path].get(method.lower())
                if operation is None:
                    continue
                if authenticated:
                    operation["security"] = [{"SessionCookie":[]}]
                names = {item.get("name") for item in operation.get("parameters",[])}
                if authenticated and "X-MoneyLens-Session-ID" not in names:
                    operation.setdefault("parameters",[]).append({"name":"X-MoneyLens-Session-ID","in":"header","required":False,
                        "description":"Optional expected session ID; a cookie/profile switch rejects the request instead of returning another session's data.","schema":{"type":"string","maxLength":36}})
                for name,required in (("Origin",csrf or route.path == "/v1/auth/demo"),("X-CSRF-Token",csrf)):
                    if required and name not in names:
                        operation.setdefault("parameters",[]).append({"name":name,"in":"header","required":True,"schema":{"type":"string"}})
        return document
    api.openapi = schema
