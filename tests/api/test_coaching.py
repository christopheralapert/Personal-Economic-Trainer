from datetime import datetime,timedelta,timezone
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.coaching import CoachingSnapshotV1,SetCoachingPreferencesV1,coaching_allows,coaching_state

NOW=datetime(2026,11,5,10,tzinfo=timezone.utc)
FIELDS=dict(coaching_enabled=True,bill_insights=True,headroom_insights=True,spending_insights=True)


def preferences(**changes):
    return CoachingSnapshotV1(**{**FIELDS,"id":UUID(int=1),"version":1,"created_at":None,"updated_at":None,**changes})


@pytest.mark.parametrize("change",[
    {"coaching_enabled":1},{"bill_insights":"true"},{"headroom_insights":0},{"spending_insights":None},
    {"expected_preferences_version":True},{"expected_preferences_version":"1"},{"expected_preferences_version":2**53},
    {"quiet_start":"24:00","quiet_end":"07:00"},{"quiet_start":"22:00"},{"quiet_end":"07:00"},
    {"quiet_start":"22:00","quiet_end":"22:00"},{"quiet_start":"2:00","quiet_end":"07:00"},
    {"timezone":"Unknown/Place"},{"paused_until":"2026-11-05T12:00:00"},{"delivery_mode":"push"},
    {"owner_user_id":str(UUID(int=2))},{"push_enabled":True},{"generation_active":True},
])
def test_preferences_are_closed_strict_and_require_unambiguous_local_hours(change):
    with pytest.raises(ValidationError):
        SetCoachingPreferencesV1(**{**FIELDS,"key":"preferences-1","expected_preferences_version":1,**change})


@pytest.mark.parametrize("instant,quiet",[("2026-11-05T20:59:59+00:00",False),("2026-11-05T21:00:00+00:00",True),
    ("2026-11-06T04:59:59+00:00",True),("2026-11-06T05:00:00+00:00",False)])
def test_overnight_quiet_hours_use_inclusive_start_exclusive_end_in_local_wall_time(instant,quiet):
    state=coaching_state(preferences(quiet_start="23:00",quiet_end="07:00"),datetime.fromisoformat(instant))
    assert state.quiet_now is quiet and state.generation_active is True
    assert state.in_app_available is True and state.external_delivery_available is False


def test_both_repeated_dst_hours_are_quiet_and_skipped_hours_are_not_invented():
    value=preferences(quiet_start="03:00",quiet_end="04:00")
    for instant in ("2026-10-25T00:30:00+00:00","2026-10-25T01:30:00+00:00"):
        assert coaching_state(value,datetime.fromisoformat(instant)).quiet_now is True
    for instant in ("2026-03-29T00:30:00+00:00","2026-03-29T01:30:00+00:00"):
        assert coaching_state(value,datetime.fromisoformat(instant)).quiet_now is False


def test_pause_and_opt_out_stop_generation_but_do_not_claim_history_erasure_or_delivery():
    value=preferences(paused_until=NOW+timedelta(hours=1))
    state=coaching_state(value,NOW);assert state.paused is True and state.generation_active is False
    assert state.in_app_available is True and state.external_delivery_available is False
    assert coaching_state(value,NOW+timedelta(hours=1)).generation_active is True
    assert coaching_state(preferences(coaching_enabled=False),NOW).generation_active is False
    with pytest.raises(ValueError): coaching_state(value,NOW.replace(tzinfo=None))


@pytest.mark.parametrize("kind,field",[("upcoming_bill","bill_insights"),("low_headroom","headroom_insights"),("higher_observed_spending","spending_insights")])
def test_per_kind_generation_requires_both_master_opt_in_and_that_kind(kind,field):
    assert coaching_allows(preferences(),kind,NOW) is True
    assert coaching_allows(preferences(**{field:False}),kind,NOW) is False
    assert coaching_allows(preferences(coaching_enabled=False),kind,NOW) is False
    assert coaching_allows(preferences(paused_until=NOW+timedelta(days=1)),kind,NOW) is False


def test_daytime_quiet_window_and_unknown_kind_are_explicit():
    state=coaching_state(preferences(quiet_start="11:00",quiet_end="13:00"),NOW)
    assert state.quiet_now is True
    with pytest.raises(ValueError): coaching_allows(preferences(),"send_payment",NOW)
