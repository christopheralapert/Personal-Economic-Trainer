"""Bounded, owner-scoped recent-bank lookup. No financial data goes to a model."""
from datetime import timedelta
import re
from zoneinfo import ZoneInfo

from .analysis_tools import LedgerSearchToolV1
from .coach_intent import CoachAnalysisIntentV1, CoachInterpretationV1, MESSAGES

_PATTERNS=(
    re.compile(r"näita\s+(?:mulle\s+)?(?:mu\s+)?viit\s+viimast\s+(.+?)\s+tehingut",re.I),
    re.compile(r"show\s+(?:me\s+)?(?:my\s+)?(?:last|latest)\s+(?:five|5)\s+(.+?)\s+transactions",re.I),
    re.compile(r"show\s+(?:me\s+)?(?:my\s+)?(?:five|5)\s+(?:last|latest)\s+(.+?)\s+transactions",re.I),
)

def requested_bank(question):
    text=question.strip().rstrip("?.!").strip()
    for pattern in _PATTERNS:
        match=pattern.fullmatch(text)
        if match:return match.group(1).strip()
    return None

def normalized(value):
    return re.sub(r"[\W_]+","",value.casefold())

def interpret_latest_bank(connection,user,body,bank,now):
    owner=(user.scope.tenant_id,user.scope.user_id)
    # All account/consent predicates are owner-scoped; Ledger independently
    # verifies current consent and inclusion again before returning any rows.
    rows=connection.execute("""SELECT DISTINCT c.provider,a.id FROM moneylens.connections c
        JOIN moneylens.account_source_aliases alias ON (alias.tenant_id,alias.owner_user_id,alias.connection_id)=(c.tenant_id,c.owner_user_id,c.id)
        JOIN moneylens.accounts a ON (a.tenant_id,a.owner_user_id,a.id)=(alias.tenant_id,alias.owner_user_id,alias.account_id)
        WHERE c.tenant_id=%s AND c.owner_user_id=%s AND c.provider_mode IN ('live','sandbox')
          AND c.provider LIKE 'enable:%%' AND c.consent_state='active' AND c.expires_at>%s
          AND c.scopes ? alias.provider_account_id AND a.included AND a.currency=%s""",(*owner,now,body.currency)).fetchall()
    matches={}
    requested=normalized(bank)
    for provider,account in rows:
        parts=provider.split(':',2)
        if len(parts)!=3:continue
        key=normalized(parts[2])
        if requested in (key,key+'i'):
            matches.setdefault((parts[1],key),set()).add(account)
    if len(matches)!=1:
        return CoachInterpretationV1(method="bounded_english_patterns",resolved_at=now,status="clarification_required",reason="FILTER_REQUIRED",
            message="Choose an included account with active consent for that bank, or use the bank's exact name.",intent=None)
    accounts=next(iter(matches.values()))
    if body.account_ids is not None:accounts=accounts.intersection(body.account_ids)
    if not accounts or len(accounts)>50:
        return CoachInterpretationV1(method="bounded_english_patterns",resolved_at=now,status="clarification_required",reason="FILTER_REQUIRED",
            message="Choose an included account with active consent for that bank.",intent=None)
    today=now.astimezone(ZoneInfo("Europe/Helsinki")).date()
    tool=LedgerSearchToolV1(name="ledger_transactions",arguments={"start":today-timedelta(days=365),"end_exclusive":today+timedelta(days=1),
        "currency":body.currency,"account_ids":sorted(accounts),"expected_data_version":body.expected_data_version,
        "category":None,"merchant":None,"status":"booked","spending_only":False,"limit":5})
    return CoachInterpretationV1(method="bounded_english_patterns",resolved_at=now,status="ready",reason="SUPPORTED_QUERY",
        message=MESSAGES["SUPPORTED_QUERY"],intent=CoachAnalysisIntentV1(tool=tool))
