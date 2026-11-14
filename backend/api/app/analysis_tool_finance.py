"""Minimal read-only planning/bank results; review and consent stay outside arguments."""
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime,Field,StrictBool,StrictInt

from psycopg.rows import dict_row
from .identity import authorized_transaction,AuthError
from .bank_store import BankStore
from .contracts import Contract
from .planning_policy import ProtectionPeriodV1
from .planning_routes import PlanViewV1,PlanningAnalysisV1,plan_view
from .planning_store import PlanningStore


class PlanningReadArgumentsV1(Contract):
    plan_id: UUID | None = None


class BankConnectionsArgumentsV1(Contract):
    connection_id: UUID | None = None


class PlanningToolSnapshotV1(Contract):
    id: UUID
    state: Literal["draft","active","superseded"]
    current: StrictBool
    data_version: StrictInt
    plan_version: StrictInt
    as_of: AwareDatetime
    expires_at: AwareDatetime
    period: ProtectionPeriodV1 | None
    analysis: PlanningAnalysisV1


class PlanningReadV1(Contract):
    evaluated_at: AwareDatetime
    plan: PlanningToolSnapshotV1 | None
    limitations: list[str]


class BankToolConnectionV1(Contract):
    id: UUID
    institution_id: str = Field(max_length=200)
    mode: Literal["synthetic","sandbox","live"]
    name: str
    consent_state: Literal["requested","authorizing","active","expired","revoked","denied"]
    sync_health: Literal["never_synced","syncing","staged","fresh","stale","partial","error"]
    account_count: StrictInt = Field(ge=0,le=50)
    expires_at: AwareDatetime | None
    source_observed_at: AwareDatetime | None
    last_success_at: AwareDatetime | None
    last_error_code: str | None


class BankConnectionsReadV1(Contract):
    evaluated_at: AwareDatetime
    rows: list[BankToolConnectionV1] = Field(max_length=50)
    limitations: list[str]


def planning_read(connection,user,args,instant):
    store=PlanningStore(connection,user,clock=lambda:instant)
    view=store.read(args.plan_id) if args.plan_id is not None else store.current()
    snapshot=None
    if view is not None:
        presented:PlanViewV1=plan_view(view)
        fields=("id","state","current","data_version","plan_version","as_of","expires_at","analysis")
        snapshot=PlanningToolSnapshotV1(**{name:getattr(presented,name) for name in fields},
            period=presented.calculation.prepared.period if presented.calculation is not None else None)
    return PlanningReadV1(evaluated_at=instant,plan=snapshot,limitations=[
        "This reads an already reviewed owned plan; it does not create assumptions or confirm source coverage.",
        "A missing plan is unknown, not zero. A historical, expired or inaccessible-source quote has no current actionable amount.",
        "The amount is one shared spending/saving surplus under the plan's dated assumptions, not two independent allowances.",
        "No saving is reserved, bank transfer executed, financial record changed or future income inferred."])


def bank_connections_read(connection,user,args,instant,secret):
    if not user.synthetic:
        with authorized_transaction(connection,user):
            with connection.cursor(row_factory=dict_row) as cursor:
                rows=cursor.execute("""SELECT id,provider,provider_mode,consent_state,sync_health,expires_at,
                    source_observed_at,last_success_at,last_error_code,jsonb_array_length(scopes) AS account_count
                    FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s AND provider LIKE 'enable:%%'
                    AND (%s::uuid IS NULL OR id=%s) ORDER BY created_at DESC LIMIT 50""",
                    (user.scope.tenant_id,user.scope.user_id,args.connection_id,args.connection_id)).fetchall()
        if args.connection_id is not None and not rows:raise AuthError("NOT_FOUND",404)
        return BankConnectionsReadV1(evaluated_at=instant,rows=[BankToolConnectionV1(
            id=row["id"],institution_id=row["provider"],mode=row["provider_mode"],name=row["provider"].split(":",2)[-1],
            consent_state="expired" if row["consent_state"]=="active" and row["expires_at"]<=instant else row["consent_state"],
            sync_health=row["sync_health"],expires_at=row["expires_at"],source_observed_at=row["source_observed_at"],
            last_success_at=row["last_success_at"],last_error_code=row["last_error_code"],account_count=row["account_count"]) for row in rows],
            limitations=["Provider sandbox and live sources are explicitly distinguished. Imported history remains partial.",
                "This is metadata only, without provider session credentials, consent state tokens or account references.",
                "No external provider request or financial command is executed. A consent does not establish spending capacity."])
    store=BankStore(connection,user,secret,clock=lambda:instant)
    rows=[store.read(args.connection_id)] if args.connection_id is not None else store.list()
    fields=("id","institution_id","mode","name","consent_state","sync_health","expires_at",
        "source_observed_at","last_success_at","last_error_code")
    return BankConnectionsReadV1(evaluated_at=instant,rows=[BankToolConnectionV1(
        **{name:row[name] for name in fields},account_count=len(row["account_references"])) for row in rows],limitations=[
            "These are synthetic bank connections, not live banks or PSD2 account access.",
            "Consent state, background sync health and source observation are separate. A fresh label does not prove complete finances or spending capacity.",
            "Only connection summaries are returned; account references, callback state, grants and source checkpoints are excluded.",
            "This query cannot start consent, refresh, reconnect or disconnect a bank; explicit user commands remain separate."])
