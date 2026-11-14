"""Bounded owned source evidence, distinct from money and household completeness."""
from datetime import date, datetime, timedelta, timezone
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime, StrictBool
from psycopg.rows import dict_row

from .contracts import Contract


class AccountSourceV1(Contract):
    account_id: UUID
    connection_id: UUID
    institution_id: str
    mode: Literal["synthetic","sandbox","live"]
    consent_state: Literal["requested","authorizing","active","expired","revoked","denied"]
    granted: StrictBool
    sync_health: Literal["never_synced","syncing","staged","fresh","stale","partial","error"]
    observed_at: AwareDatetime | None
    history_from: date | None
    history_to_exclusive: date | None
    last_success_at: AwareDatetime | None
    last_error_code: str | None
    source_version: str | None
    timezone: Literal["Europe/Helsinki"] = "Europe/Helsinki"


def source_evidence(connection,user,account_ids,*,now=None,maximum_age_hours=24):
    """One indexed set query for up to the calling service's bounded account scope.

    An active granted alias takes precedence over retained historical aliases.
    Evidence uses the published alias observation/coverage, never a newer staged
    observation. This helper exposes metadata only and does not authorize money.
    """
    if not account_ids:
        return {}
    now=now or datetime.now(timezone.utc)
    with connection.cursor(row_factory=dict_row) as query:
        rows=query.execute("""SELECT DISTINCT ON (alias.account_id) alias.account_id,consent.id AS connection_id,
            consent.provider AS institution_id,consent.provider_mode AS mode,
            CASE WHEN consent.consent_state='active' AND (consent.expires_at IS NULL OR consent.expires_at<=%(now)s)
                THEN 'expired' ELSE consent.consent_state END AS consent_state,
            coalesce(consent.consent_state='active' AND consent.expires_at>%(now)s AND consent.scopes ? alias.provider_account_id
                AND (consent.provider_mode<>'synthetic' OR member.is_synthetic),false) AS granted,
            CASE WHEN consent.sync_health='fresh' AND (alias.observed_at IS NULL OR alias.observed_at<%(oldest)s)
                THEN 'stale' ELSE consent.sync_health END AS sync_health,
            alias.observed_at,alias.coverage_from AS history_from,alias.coverage_to_exclusive AS history_to_exclusive,
            consent.last_success_at,consent.last_error_code,alias.source_version
            FROM moneylens.account_source_aliases alias JOIN moneylens.connections consent
                ON (consent.tenant_id,consent.owner_user_id,consent.id)=(alias.tenant_id,alias.owner_user_id,alias.connection_id)
            JOIN moneylens.users member ON (member.tenant_id,member.id)=(alias.tenant_id,alias.owner_user_id)
            WHERE alias.tenant_id=%(tenant)s AND alias.owner_user_id=%(owner)s AND alias.account_id=ANY(%(accounts)s)
            ORDER BY alias.account_id,granted DESC,alias.observed_at DESC NULLS LAST,consent.id DESC""",
            {"now":now,"oldest":now-timedelta(hours=maximum_age_hours),"tenant":user.scope.tenant_id,
                "owner":user.scope.user_id,"accounts":list(account_ids)}).fetchall()
    return {row["account_id"]:AccountSourceV1.model_validate(row) for row in rows}


def history_coverage(account_ids,sources,*,start,end_exclusive):
    if not account_ids or not sources:
        return "unverified"
    def covered(identifier):
        source=sources.get(identifier)
        if source is None or not source.granted or source.sync_health!="fresh" or source.mode!="synthetic" or (
            source.history_from is None or source.history_to_exclusive is None or source.observed_at is None):
            return False
        # A date watermark does not establish the still-unobserved remainder of
        # today's civil day. Coverage ends at the named actual observation.
        end=datetime.combine(end_exclusive,datetime.min.time(),tzinfo=ZoneInfo(source.timezone))
        return source.history_from<=start and end_exclusive<=source.history_to_exclusive and source.observed_at>=end
    return "covered_synthetic_snapshot" if all(covered(identifier) for identifier in account_ids) else "partial"
