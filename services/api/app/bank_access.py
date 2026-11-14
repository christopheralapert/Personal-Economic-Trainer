"""Conservative material-source gate, called inside membership-fenced transactions."""
from datetime import datetime, timedelta, timezone

from .identity import AuthError


def planning_sources_ready(connection,user,now):
    # Previously granted money cannot silently vanish from a whole-finance plan.
    row = connection.execute("""SELECT previous.id FROM moneylens.connections previous
        WHERE previous.tenant_id=%s AND previous.owner_user_id=%s AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(previous.scopes) AS grant_ref(reference)
            WHERE NOT EXISTS (SELECT 1 FROM moneylens.account_source_aliases alias JOIN moneylens.connections current
                ON (current.tenant_id,current.owner_user_id,current.id)=(alias.tenant_id,alias.owner_user_id,alias.connection_id)
                WHERE alias.tenant_id=previous.tenant_id AND alias.owner_user_id=previous.owner_user_id
                    AND current.provider=previous.provider AND alias.provider_account_id=grant_ref.reference
                    AND current.scopes ? alias.provider_account_id AND current.consent_state='active' AND current.expires_at>%s
                    AND current.last_success_at IS NOT NULL AND current.sync_health='fresh' AND alias.observed_at>=%s)) LIMIT 1""",
        (user.scope.tenant_id,user.scope.user_id,now,now-timedelta(hours=24))).fetchone()
    if row:
        raise AuthError("BANK_SOURCE_NOT_READY",409)


def bank_account_access(connection,user,account_ids,*,now=None):
    """Retained source rows require a currently granted alias to that account."""
    if not account_ids:
        return
    now=now or datetime.now(timezone.utc)
    native=connection.execute("""SELECT 1 FROM moneylens.accounts a WHERE a.tenant_id=%s AND a.owner_user_id=%s
        AND a.id=ANY(%s) AND a.native_feed_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM moneylens.users member
            WHERE member.tenant_id=a.tenant_id AND member.id=a.owner_user_id AND member.active AND member.is_synthetic) LIMIT 1""",
        (user.scope.tenant_id,user.scope.user_id,list(account_ids))).fetchone()
    if native: raise AuthError("IMPORT_ACCOUNT_ACCESS_REQUIRED",409)
    row=connection.execute("""SELECT old.account_id FROM moneylens.account_source_aliases old
        WHERE old.tenant_id=%s AND old.owner_user_id=%s AND old.account_id=ANY(%s)
            AND NOT EXISTS (SELECT 1 FROM moneylens.account_source_aliases alias JOIN moneylens.connections consent
                ON (consent.tenant_id,consent.owner_user_id,consent.id)=(alias.tenant_id,alias.owner_user_id,alias.connection_id)
                WHERE alias.tenant_id=old.tenant_id AND alias.owner_user_id=old.owner_user_id AND alias.account_id=old.account_id
                    AND consent.consent_state='active' AND consent.expires_at>%s AND consent.scopes ? alias.provider_account_id
                    AND (consent.provider_mode<>'synthetic' OR EXISTS (SELECT 1 FROM moneylens.users member
                        WHERE member.tenant_id=consent.tenant_id AND member.id=consent.owner_user_id AND member.is_synthetic)))
        LIMIT 1""",(user.scope.tenant_id,user.scope.user_id,list(account_ids),now)).fetchone()
    if row:
        raise AuthError("BANK_ACCOUNT_ACCESS_REQUIRED",409)
