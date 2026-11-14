from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.bank_adapter import BankError,BankSession
from app.database import TrustedScope
from app.synthetic_banks import SyntheticBank,provider_reference

NOW = datetime(2026,11,4,10,tzinfo=timezone.utc)
SECRET = "test-only-bank-cursor-secret-not-a-provider-key"


class Authority:
    def __init__(self,session):
        self.session,self.state = session,"active"
        self.calls = []

    def __call__(self,session,purpose):
        self.calls.append(purpose)
        if session!=self.session or (self.state!="active" and purpose!="revoke"):
            raise BankError("consent_not_active")


def setup(institution="s-bank-demo",*,fault="healthy",now=NOW):
    scope = TrustedScope(uuid4(),uuid4())
    session = BankSession(scope,uuid4(),1,(provider_reference(scope,institution),),now+timedelta(hours=1))
    authority = Authority(session)
    return SyntheticBank(institution,authority,SECRET,clock=lambda:now,fault=fault),session,authority


@pytest.mark.parametrize("institution",["s-bank-demo","north-demo"])
def test_both_banks_implement_authorization_scope_typed_balances_pages_and_revocation(institution):
    bank,session,authority = setup(institution)
    caps = bank.capabilities()
    assert caps.mode=="synthetic" and caps.payments_supported is False
    assert "synthetic" in caps.notice and caps.consent_seconds in (1800,3600)
    begin = bank.begin_consent(session)
    assert begin.available_accounts[0].reference==session.account_references[0]
    grant = bank.complete_consent(session,session.account_references)
    assert grant.expires_at==NOW+timedelta(seconds=caps.consent_seconds)
    assert bank.list_accounts(session)==begin.available_accounts
    balances = bank.fetch_balances(session,session.account_references[0],as_of=NOW)
    assert balances[0].amount_minor==(50000 if institution=="s-bank-demo" else 30000)
    assert balances[0].kind==caps.balance_kind and balances[0].pending_reflection==caps.pending_reflection
    seen,cursor = [],None
    while True:
        page = bank.fetch_transactions(session,session.account_references[0],as_of=NOW,start=date(2026,10,1),end_exclusive=date(2026,11,1),limit=2,cursor=cursor)
        assert page.complete is True and page.observed_at==balances[0].observed_at
        assert page.source_version==balances[0].source_version
        seen.extend(row.reference for row in page.rows)
        cursor = page.next_cursor
        if cursor is None:
            break
    assert len(seen)==len(set(seen)) and len(seen)>2
    assert bank.revoke_consent(session).acknowledged is True
    authority.state = "revoked"  # Production authority persists this in PostgreSQL.
    assert bank.revoke_consent(session).acknowledged is True
    with pytest.raises(BankError,match="consent_not_active"):
        bank.fetch_balances(session,session.account_references[0],as_of=NOW)
    assert {"authorize","discover","read","revoke"}<=set(authority.calls)


def test_combined_synthetic_october_consumption_matches_original_fixture_without_transfers():
    spending = 0
    rows = []
    for institution in ("s-bank-demo","north-demo"):
        bank,session,_ = setup(institution)
        page = bank.fetch_transactions(session,session.account_references[0],as_of=NOW,start=date(2026,10,1),end_exclusive=date(2026,11,1))
        rows.extend(page.rows)
        spending -= sum(row.amount_minor for row in page.rows if row.economic_flow in ("expense","refund"))
    assert spending==86450
    transfers = [row for row in rows if row.economic_flow=="internal_transfer"]
    assert len(transfers)==2 and sum(row.amount_minor for row in transfers)==0
    assert all(row.related_reference and row.related_institution for row in transfers)


@pytest.mark.parametrize("change",["owner","connection","generation","accounts","window","size","snapshot","tamper"])
def test_source_cursors_cannot_cross_authorized_scope_or_source_parameters(change):
    bank,session,authority = setup()
    args = dict(as_of=NOW,start=date(2026,10,1),end_exclusive=date(2026,11,1),limit=1)
    first = bank.fetch_transactions(session,session.account_references[0],**args)
    cursor = first.next_cursor
    if change=="owner":
        session = replace(session,scope=TrustedScope(session.scope.tenant_id,uuid4()))
    elif change=="connection":
        session = replace(session,connection_id=uuid4())
    elif change=="generation":
        session = replace(session,generation=2)
    elif change=="accounts":
        session = replace(session,account_references=())
    elif change=="window":
        args["start"] = date(2026,10,2)
    elif change=="size":
        args["limit"] = 2
    elif change=="snapshot":
        args["as_of"] = NOW-timedelta(seconds=1)
    else:
        cursor = cursor[:-8]+"bad-token"
    authority.session = session
    with pytest.raises(BankError):
        bank.fetch_transactions(session,session.account_references[0] if session.account_references else "not-granted",cursor=cursor,**args)


@pytest.mark.parametrize("fault,code,retry",[("unavailable","bank_unavailable",True),("throttled","bank_throttled",True),("expired","consent_expired",False)])
def test_controlled_faults_are_safe_and_isolated(fault,code,retry):
    bank,session,_ = setup(fault=fault)
    with pytest.raises(BankError) as failure:
        bank.fetch_balances(session,session.account_references[0],as_of=NOW)
    assert failure.value.code==code and failure.value.retryable is retry
    healthy,other,_ = setup("north-demo")
    assert healthy.fetch_balances(other,other.account_references[0],as_of=NOW)[0].amount_minor==30000


@pytest.mark.parametrize("fault",["stale","partial"])
def test_incomplete_or_old_sources_are_not_reported_as_complete_current_data(fault):
    bank,session,_ = setup(fault=fault)
    page = bank.fetch_transactions(session,session.account_references[0],as_of=NOW,start=date(2026,8,1),end_exclusive=date(2026,11,5))
    if fault=="stale":
        assert page.observed_at==NOW-timedelta(days=2) and page.coverage_to_exclusive==date(2026,11,3)
    assert page.complete is False


@pytest.mark.parametrize("institution",["s-bank-demo","north-demo"])
def test_pending_to_changed_booked_amount_keeps_one_source_identity_and_typed_balance(institution):
    pending,session,authority = setup(institution,fault="pending")
    booked = SyntheticBank(institution,authority,SECRET,clock=lambda:NOW,fault="booked")
    args = dict(as_of=NOW,start=date(2026,11,4),end_exclusive=date(2026,11,5))
    old = pending.fetch_transactions(session,session.account_references[0],**args).rows[0]
    new = booked.fetch_transactions(session,session.account_references[0],**args).rows[0]
    assert old.reference==new.reference and (old.amount_minor,new.amount_minor)==(-4200,-4600)
    assert (old.revision,new.revision)==(1,2) and (old.status,new.status)==("pending","booked")
    old_balance = pending.fetch_balances(session,session.account_references[0],as_of=NOW)[0]
    new_balance = booked.fetch_balances(session,session.account_references[0],as_of=NOW)[0]
    assert old_balance.amount_minor-new_balance.amount_minor==(400 if institution=="s-bank-demo" else 4600)


def test_local_midnight_coverage_and_missing_history_are_explicit():
    clock = datetime(2026,11,3,22,30,tzinfo=timezone.utc) # Helsinki 4 November.
    bank,session,_ = setup(now=clock,fault="pending")
    page = bank.fetch_transactions(session,session.account_references[0],as_of=clock,start=date(2026,11,4),end_exclusive=date(2026,11,5))
    assert page.complete is True and page.rows[0].booked_on==date(2026,11,4)
    old = bank.fetch_transactions(session,session.account_references[0],as_of=clock,start=date(2026,7,1),end_exclusive=date(2026,8,1))
    assert old.complete is False and old.rows==[]


@pytest.mark.parametrize("limit",[True,0,101])
def test_limits_and_ungranted_accounts_fail_before_fetch(limit):
    bank,session,_ = setup()
    with pytest.raises(BankError):
        bank.fetch_transactions(session,session.account_references[0],as_of=NOW,start=date(2026,10,1),end_exclusive=date(2026,11,1),limit=limit)
    with pytest.raises(BankError,match="account_not_granted"):
        bank.fetch_balances(session,str(uuid4()),as_of=NOW)
    with pytest.raises(BankError,match="invalid_account_selection"):
        bank.complete_consent(session,(str(uuid4()),))
