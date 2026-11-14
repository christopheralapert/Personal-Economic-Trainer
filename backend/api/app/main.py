import asyncio
from datetime import date, datetime, timezone
import math
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Annotated
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import Field, StrictInt

from .contracts import Analysis, Blocker, Contract, Evidence, FinancialResult, NonnegativeMinor
from .demo import Profile, profile
from .demo_planning import demo_forecast
from .planning import reduction
from .settings import Settings, get_settings
from .auth_routes import router as auth_router, clear_cookie, document_security
from .identity import AuthError, Identity
from .oidc import OIDC
from .pools import Pools
from .public_routes import router as public_router
from .ledger_routes import router as ledger_router
from . import classification_review  # Registers owned corrections on the existing ledger router.
from .planning_routes import router as planning_router
from .bank_routes import router as bank_router
from .benchmark_routes import router as benchmark_router
from .analysis_tool_routes import router as analysis_tool_router
from .education_routes import router as education_router
from .habit_routes import router as habit_router
from .coach_routes import router as coach_query_router
from .scenario_routes import router as scenario_router
from .goal_routes import router as goal_router
from .insight_routes import router as insight_router
from .coaching_routes import router as coaching_router
from .statement_routes import router as statement_router, purge_expired_batch
from .import_routes import router as import_router
from .import_validation_routes import router as import_validation_router
from .import_publication_routes import router as import_publication_router
from .import_objects import ImportObjects
from .live_banking_provider import LiveProviderError
from .live_banking_routes import router as live_banking_router
from .dashboard_routes import router as dashboard_router
from .bank_adapter import BankError
from .demo_banks import router as demo_banks_router
from .model_adapter import build_model,ModelError
from .request_limits import PlanningBodyLimit


class Health(Contract):
    status: str
    mode: str
    database: str


class PlanRequest(Contract):
    savings_minor: NonnegativeMinor = 0


class PlanResponse(Contract):
    analysis: Analysis
    requested_from: date
    requested_to_exclusive: date
    protection_through: datetime
    bills_minor: int
    essentials_minor: int
    buffer_minor: int
    proposed_savings_minor: int
    remaining_spending_minor: int | None
    persisted: bool = False


class ScenarioRequest(Contract):
    percent: Annotated[Decimal, Field(ge=0, le=100, allow_inf_nan=False)] = Decimal(20)
    months: Annotated[StrictInt, Field(ge=1, le=120)] = 12


class ScenarioResponse(Contract):
    mode: str = "synthetic"
    baseline_minor: int
    monthly_reduction_minor: int
    total_reduction_minor: int
    months: int
    percent: str
    currency: str = "EUR"
    baseline_period: str = "2026-10"
    assumption: str = "The complete October baseline repeats unchanged; no interest or inflation is assumed."


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or get_settings()
    @asynccontextmanager
    async def lifespan(api):
        if config.auth_enabled:
            api.state.pools = Pools(config)
            api.state.identity = Identity(api.state.pools,config)
            api.state.oidc = OIDC(config)
            api.state.model = build_model(config)
        cleanup_task = None
        if config.auth_enabled and config.statement_imports_enabled:
            async def clean_statement_previews():
                cursor=None
                while True:
                    try:
                        cursor=await asyncio.to_thread(purge_expired_batch,api.state.pools,cursor)
                    except Exception:
                        cursor=None
                    await asyncio.sleep(1 if cursor else 60)
            cleanup_task=asyncio.create_task(clean_statement_previews())
        try:
            if config.imports_enabled:
                api.state.import_objects = ImportObjects(config)
            yield
        finally:
            if cleanup_task:
                cleanup_task.cancel()
                try: await cleanup_task
                except asyncio.CancelledError: pass
            if hasattr(api.state,"import_objects"):
                api.state.import_objects.close()
            if config.auth_enabled:
                await api.state.model.close()
                api.state.oidc.close()
                api.state.pools.close()

    api = FastAPI(title="MoneyLens API", version="0.2.0", lifespan=lifespan,
        description="Synthetic development and server-verified OIDC sessions. Customer banking workflows and live providers remain separate release gates.")
    api.state.settings = config
    api.add_middleware(PlanningBodyLimit)
    api.include_router(public_router)
    api.include_router(education_router)
    if config.auth_enabled:
        api.include_router(auth_router)
        api.include_router(ledger_router)
        api.include_router(habit_router)
        api.include_router(coach_query_router)
        api.include_router(planning_router)
        api.include_router(benchmark_router)
        api.include_router(analysis_tool_router)
        api.include_router(scenario_router)
        api.include_router(goal_router)
        api.include_router(insight_router)
        api.include_router(coaching_router)
        api.include_router(statement_router)
        api.include_router(import_router)
        api.include_router(import_validation_router)
        api.include_router(import_publication_router)
        if config.allow_demo:
            api.include_router(bank_router)
        api.include_router(live_banking_router)
        api.include_router(dashboard_router)

    @api.middleware("http")
    async def response_policy(request: Request, call_next):
        trace_id = str(uuid4())
        request.state.trace_id = trace_id
        try:
            response = await call_next(request)
        except Exception:
            response = JSONResponse(status_code=500, content={"error": {"code": "INTERNAL_ERROR", "message": "The request could not be completed.", "trace_id": trace_id}})
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Request-ID"] = trace_id
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Vary"] = "Cookie, Origin"
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
        return response

    @api.exception_handler(AuthError)
    async def authentication_error(request: Request, exc: AuthError):
        messages = {
            "EDUCATION_UNAVAILABLE":"Learning notes are unavailable. You can keep using the financial views and try the notes again later.",
            "SESSION_CHANGED":"The active profile changed. Reload the verified session before reading private data.",
            "IMPORT_UNAVAILABLE":"Private source intake is not configured on this deployment.",
            "STATEMENT_OVERLAP":"This statement overlaps records that cannot be safely matched. Nothing was imported.",
            "IMPORT_SYNTHETIC_REQUIRED":"Source intake currently supports verified synthetic profiles only.",
            "INVALID_IMPORT_COMMAND":"Review the source manifest and command fields.",
            "IMPORT_TOO_LARGE":"The declared source files exceed this deployment's intake limit.",
            "IMPORT_INTAKE_THROTTLED":"The source intake budget has been reached. Review retained imports or try later.",
            "IMPORT_COMMAND_THROTTLED":"Source intake commands are temporarily limited. Retry later.",
            "IMPORT_UPLOAD_CLOSED":"This upload window is closed. Review the current import status.",
            "IMPORT_ALREADY_VERIFIED":"Source integrity was already verified. Financial publication is a separate workflow.",
            "IMPORT_SOURCE_NOT_VERIFIED":"Finish source byte verification before validating CSV rows.",
            "IMPORT_VALIDATION_CLOSED":"This validation outcome is closed. Review its report or start a new source snapshot.",
            "INVALID_IMPORT_PAGE":"Choose a nonnegative rejection position and one to one hundred rows.",
            "IMPORT_VALIDATION_REQUIRED":"Complete native source validation before requesting publication.",
            "IMPORT_PUBLICATION_CLOSED":"This published snapshot is retained as history; it cannot be cancelled or reactivated by retrying a command.",
            "IMPORT_INTAKE_MOVED":"This source has a publication record. Read its /publication resource for current or historical dataset status.",
            "IMPORT_ACCOUNT_ACCESS_REQUIRED":"This retained import requires a currently eligible synthetic profile before its financial facts can be read.",
            "IMPORT_SOURCE_VERSION_CHANGED":"This source snapshot is no longer active. Reload your imports and choose the current snapshot before reading its records.",
            "INVALID_PERIOD":"Choose an ordered date window no longer than ten years.",
            "INVALID_COMPARISON_PERIOD":"Choose valid comparison windows; previous-month mode requires one complete calendar month, and custom mode requires both baseline dates.",
            "INVALID_BENCHMARK_PERIOD":"Choose one to twelve complete calendar months, starting and ending on the first day of a month.",
            "INVALID_BENCHMARK_CATEGORIES":"Choose supported statistical categories without duplicate or overlapping parent/child groups.",
            "INVALID_BENCHMARK_SCOPE":"Use the complete authorized account window without merchant or transaction-category filters.",
            "ANALYSIS_TOOL_UNAVAILABLE":"Choose an available read-only analysis tool.",
            "ANALYSIS_TOOL_ARGUMENTS_INVALID":"Review the analysis filters and interactive limits before retrying.",
            "INVALID_SCENARIO_SCOPE":"Use the complete authorized booked category window matching this scenario.",
            "GOAL_VERSION_CHANGED":"This goal changed. Reload it before saving another choice.",
            "GOAL_REMOVED":"This goal was removed. Its command receipts remain historical records.",
            "GOAL_VERSION_EXHAUSTED":"This goal needs a version migration before another change.",
            "GOAL_LIMIT_REACHED":"The retained goal limit has been reached. Review your goal history before creating more.",
            "GOAL_COMMAND_THROTTLED":"Goal changes are temporarily limited. Retry the same request later.",
            "GOAL_ALLOCATION_REVIEW_REQUIRED":"Review the goal's active reservations before removing it. No reservation was released.",
            "GOAL_CURRENCY_LINKED":"This goal has allocation history. Keep its currency to preserve those records.",
            "INVALID_GOAL_COMMAND":"Review the goal fields and expected version before saving.",
            "INVALID_GOAL_PAGE":"Choose a goal page size between one and one hundred.",
            "INVALID_CURSOR":"Restart this query with a fresh page cursor.",
            "CURSOR_EXPIRED":"This page cursor expired. Restart the query.",
            "CURSOR_SCOPE_CHANGED":"Your profile, filters or data changed. Restart the query.",
            "DATA_VERSION_CHANGED":"The records changed. Refresh the totals before opening their evidence.",
            "MIXED_CURRENCY_SCOPE":"Choose accounts in one currency. Exchange-rate conversion is not available.",
            "NARROW_ACCOUNT_SCOPE":"Choose a smaller set of accounts for this query.",
            "DATASET_STATE_UNAVAILABLE":"The dataset is not ready for versioned analysis.",
            "DATA_CHANGED_RETRY":"Access or data changed while the request was starting. Refresh your session and retry.",
            "HISTORICAL_SPENDING_REQUIRES_BOOKED":"Choose booked transactions for historical spending; pending items can be viewed separately.",
            "INVALID_HABIT_SCOPE":"Inspect the same account, date and filter scope before describing its spending patterns.",
            "HABIT_EVIDENCE_INVALID":"The spending breakdown could not be reconciled. Refresh the source evidence before using these patterns.",
            "GROUNDING_EVIDENCE_INVALID":"The financial evidence could not be verified. Refresh the original query before using this answer.",
            "AMOUNT_RANGE_EXCEEDED":"Narrow this query; its sum exceeds the supported monetary range.",
            "PLANNING_VERSION_CHANGED":"Your data or plan changed. Refresh the plan before making another choice.",
            "PLANNING_QUOTE_EXPIRED":"This plan expired. Refresh its source facts and review it again.",
            "SAVINGS_EXCEED_CAPACITY":"Choose savings within the protective surplus after your discretionary preference.",
            "ALLOCATION_ACCOUNT_CAPACITY":"The selected account cannot safely fund this savings reservation.",
            "IDEMPOTENCY_CONFLICT":"This request key already belongs to a different choice. Review the saved result.",
            "RESERVE_RECONCILIATION_REQUIRED":"Review the existing reservation and its consumption before changing it.",
            "PLANNING_SCOPE_CHANGED":"Review every currently included account and refresh the account list.",
            "PLANNING_BALANCE_CHANGED":"A source balance changed. Refresh and review the latest snapshot.",
            "EXISTING_RESERVATIONS_REQUIRE_REVIEW":"Existing unspent reservations require reconciliation before replacing this plan.",
            "PLANNING_BACKGROUND_REVIEW_REQUIRED":"This review exceeds the interactive source limit and requires a background workflow.",
            "INVALID_PLANNING_PERIOD":"Choose a future planning endpoint within the supported review bounds.",
            "PLANNING_SOURCE_NOT_READY":"This review workflow currently supports labeled synthetic profiles only.",
            "BANK_SOURCE_NOT_READY":"A previously granted bank is incomplete, stale or disconnected. Refresh and review the complete source scope before using spending guidance.",
            "BANK_ACCOUNT_ACCESS_REQUIRED":"This retained account needs a current bank consent before its source records can be read again.",
            "BANK_CONNECTION_EXISTS":"This simulated bank already has an open connection. Finish or disconnect it before starting another.",
            "BANK_AUTH_SESSION_CHANGED":"Restart this simulated bank authorization in your current signed-in session.",
            "BANK_CALLBACK_REJECTED":"The simulated authorization could not be matched to this session and connection.",
            "BANK_AUTH_EXPIRED":"The simulated authorization expired or was already closed. Start a new connection.",
            "BANK_REFRESH_THROTTLED":"An import was attempted recently. Wait at least 60 seconds before one manual retry. Do not reconnect your bank.",
            "BANK_REFRESH_IN_PROGRESS":"An import is already in progress. Wait for it to finish before checking again.",
            "BANK_PSU_CONTEXT_REQUIRED":"The active browser request could not be verified through the configured secure proxy. No bank request was started. Open the HTTPS app and try once from your signed-in session.",
        }
        response = JSONResponse(status_code=exc.status,content={"error":{"code":exc.code,"message":messages.get(exc.code,"The session or requested access could not be verified."),"trace_id":request.state.trace_id}})
        if exc.status == 401:
            clear_cookie(response,config)
        if exc.code == "BANK_REFRESH_THROTTLED":
            response.headers["Retry-After"] = "60"
        if exc.code in ("GOAL_COMMAND_THROTTLED","COACHING_COMMAND_THROTTLED","INSIGHT_COMMAND_THROTTLED","INSIGHT_REFRESH_THROTTLED","IMPORT_COMMAND_THROTTLED","IMPORT_INTAKE_THROTTLED"):
            response.headers["Retry-After"] = "3600"
        return response

    @api.exception_handler(ModelError)
    async def model_error(request:Request,exc:ModelError):
        message={"MODEL_FREE_ONLY_UNAVAILABLE":"Hosted interpretation is blocked by the configured free-only policy.",
            "MODEL_BUDGET_EXCEEDED":"A configured model cost or technical call limit stopped this question.",
            "MODEL_THROTTLED":"The model provider has limited requests. No automatic retry was made.",
            "MODEL_BUSY":"The configured concurrent model request limit is reached. Try manually later.",
            "MODEL_NOT_CONFIGURED":"Hosted model interpretation is not configured for this deployment."}.get(exc.code,
                "The model could not provide a validated interpretation. No financial answer was invented; try another explicit question.")
        return JSONResponse({"error":{"code":exc.code,"message":message}},status_code=429 if exc.code in ("MODEL_BUSY","MODEL_THROTTLED") else 503)

    @api.exception_handler(LiveProviderError)
    async def live_provider_error(request: Request, exc: LiveProviderError):
        message = {
            "BANK_PROVIDER_ACCESS_DENIED": "The banking provider did not allow access. Ask your inviter to check the application's account permissions, or connect a demo bank.",
            "BANK_IMPORT_WAIT": "This import is waiting. Review the saved next-attempt time; no new bank request was started.",
            "BANK_RETRY_REVIEW_REQUIRED": "The provider's limit end is unknown and three attempts were limited. Further imports are paused for operator review. Your consent remains active; do not reconnect.",
            "BANK_ASPSP_RATE_LIMIT_EXCEEDED": "The bank has limited data requests. No import was saved. Review the saved waiting status; your consent does not need reconnecting for this error.",
            "BANK_PSU_HEADERS_REQUIRED": "The bank requires browser information that this request could not verify. No financial import was started. Review the trusted proxy configuration.",
            "BANK_PROVIDER_INVALID_DATA": "Provider data failed validation. This import was not saved. Review the indicated stage and code before retrying; do not reconnect blindly.",
            "BANK_PROVIDER_THROTTLED": "The banking provider has temporarily limited requests. Pause import attempts and retry manually later. No import was saved; reconnecting is not required by this error.",
            "BANK_UNSUPPORTED_CURRENCY": "This pilot accepts only EUR accounts and supported EUR amount data. This import was not saved. Review the selected account currencies before retrying.",
            "BANK_TRANSACTION_ID_REQUIRED": "Booked transactions are missing a required immutable reference. This import was not saved. The provider data needs investigation; no replacement transaction IDs were guessed.",
            "BANK_DUPLICATE_SOURCE_ID": "The provider returned conflicting transactions with the same reference. This import was not saved. The source data needs investigation; reconnecting may not fix it.",
            "BANK_TRANSACTION_CONFLICT": "A source transaction conflicts with a previously imported record. This import was not saved and existing records were preserved. Review the source data before retrying.",
        }.get(exc.code, "Bank data could not be validated. Retry manually or reconnect your bank.")
        error={"code":exc.code,"message":message,"stage":exc.stage}
        if exc.wait: error.update(exc.wait)
        headers={}
        if exc.retry_at:
            headers["Retry-After"]=str(max(1,math.ceil((exc.retry_at-datetime.now(timezone.utc)).total_seconds())))
        return JSONResponse({"error":error},status_code=exc.status,headers=headers)

    @api.exception_handler(BankError)
    async def bank_error(request: Request, exc: BankError):
        status = 429 if exc.code in ("refresh_throttled","bank_throttled") else 503 if exc.retryable else 422 if exc.code=="invalid_account_selection" else 409
        headers = {"Retry-After":str(exc.retry_after_seconds)} if exc.retry_after_seconds else None
        return JSONResponse(status_code=status,headers=headers,content={"error":{"code":exc.code.upper(),
            "message":"Review the simulated bank connection and its current consent before retrying.",
            "retryable":exc.retryable,"trace_id":request.state.trace_id}})

    @api.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"error": {"code": "INVALID_REQUEST", "message": "Review the supplied fields and values.", "fields": [".".join(map(str, item["loc"])) for item in exc.errors()]}})

    @api.get("/health/live", response_model=Health)
    def live():
        return Health(status="ok", mode=config.data_mode, database="not_checked" if config.auth_enabled else "not_connected")

    @api.get("/health/ready", response_model=Health)
    def ready(request: Request):
        if config.auth_enabled:
            try:
                with request.app.state.pools.identity() as connection:
                    connection.execute("SELECT 1")
                with request.app.state.pools.finance.connection() as connection:
                    connection.execute("SELECT 1")
                return Health(status="ready",mode=config.data_mode,database="connected")
            except Exception:
                return JSONResponse(status_code=503,content=Health(status="not_ready",mode=config.data_mode,database="unavailable").model_dump())
        return Health(status="demo_ready" if config.allow_demo else "api_ready", mode=config.data_mode, database="not_connected")

    if config.allow_demo:
        api.include_router(demo_banks_router)
        @api.get("/v1/demo/profile", response_model=Profile)
        def read_profile():
            return profile()

        @api.post("/v1/demo/plan", response_model=PlanResponse)
        def demo_plan(body: PlanRequest):
            data = profile()
            now = data.as_of
            calculation = demo_forecast(data,config)
            period = calculation.prepared.period
            zone = ZoneInfo(period.timezone)
            horizon = period.protection_through.astimezone(zone)
            quote = calculation.baseline.consolidated if calculation.baseline else None
            available = calculation.amount_minor
            blocked = calculation.status=="blocked" or body.savings_minor > available
            result = FinancialResult(amount_minor=None if blocked else available,
                **(quote.model_dump() if quote else {}))
            blockers = [Blocker(code=item.code,message="Review the named planning input before using an amount.",action=item.action) for item in calculation.blockers]
            if not blockers and blocked:
                blockers = [Blocker(code="SAVINGS_EXCEED_SURPLUS", message="Choose savings within the available surplus.", action="reduce_savings")]
            analysis = Analysis(calculation_id=uuid4(), status="blocked" if blocked else "estimated", as_of=now,
                                result=result, evidence=Evidence(snapshot_id=data.fixture_version, data_version=1),
                                assumptions=["Synthetic balance snapshots; no real bank connection.", "Essentials and bills use the first account; the shared buffer is held only in the second account.", "Essentials and buffer cover the complete protection horizon.", "No future income is included.", "Savings are a proposal only and are not reserved or transferred."],
                                blockers=blockers)
            return PlanResponse(analysis=analysis, requested_from=period.requested_from.astimezone(zone).date(), requested_to_exclusive=period.requested_to_exclusive.astimezone(zone).date(),
                                protection_through=horizon, bills_minor=data.bills_minor, essentials_minor=data.essentials_minor,
                                buffer_minor=data.buffer_minor, proposed_savings_minor=body.savings_minor,
                                remaining_spending_minor=None if blocked else available - body.savings_minor)

        @api.post("/v1/demo/scenario", response_model=ScenarioResponse)
        def dining_scenario(body: ScenarioRequest):
            data = profile()
            baseline = -sum(tx.amount_minor for tx in data.transactions if tx.status == "booked" and tx.category == "dining" and date(2026, 10, 1) <= tx.booked_on < date(2026, 11, 1))
            monthly, total = reduction(baseline, body.percent, body.months)
            return ScenarioResponse(baseline_minor=baseline, monthly_reduction_minor=monthly, total_reduction_minor=total, months=body.months, percent=str(body.percent))

    if config.auth_enabled:
        document_security(api,config,extra_routers=(ledger_router,habit_router,coach_query_router,planning_router,bank_router,benchmark_router,analysis_tool_router,scenario_router,goal_router,insight_router,coaching_router,import_router,import_validation_router,import_publication_router,live_banking_router,dashboard_router))
    return api


app = create_app()
