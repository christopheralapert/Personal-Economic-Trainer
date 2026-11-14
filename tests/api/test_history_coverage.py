"""Calendar boundaries for finite synthetic source coverage."""
from datetime import date, datetime, timezone
from uuid import uuid4

import pytest

from app.bank_sources import AccountSourceV1, history_coverage


@pytest.mark.parametrize("end,instant",[
    (date(2026,3,30),datetime(2026,3,29,21,tzinfo=timezone.utc)),
    (date(2026,10,26),datetime(2026,10,25,22,tzinfo=timezone.utc)),
])
def test_history_completion_uses_helsinki_midnight_across_dst(end,instant):
    from datetime import timedelta
    identifier=uuid4()
    source=AccountSourceV1(account_id=identifier,connection_id=uuid4(),institution_id="s-bank-demo",mode="synthetic",
        consent_state="active",granted=True,sync_health="fresh",observed_at=instant,history_from=date(2026,1,1),
        history_to_exclusive=date(2027,1,1),last_success_at=instant,last_error_code=None,source_version="synthetic-test")
    assert history_coverage([identifier],{identifier:source},start=date(2026,1,1),end_exclusive=end)=="covered_synthetic_snapshot"
    source.observed_at-=timedelta(microseconds=1)
    assert history_coverage([identifier],{identifier:source},start=date(2026,1,1),end_exclusive=end)=="partial"


def test_empty_and_unknown_account_scope_never_becomes_verified_zero_history():
    assert history_coverage([],{},start=date(2026,1,1),end_exclusive=date(2026,2,1))=="unverified"
    assert history_coverage([uuid4()],{},start=date(2026,1,1),end_exclusive=date(2026,2,1))=="unverified"
