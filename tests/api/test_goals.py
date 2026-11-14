from datetime import datetime,timezone
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.goals import CreateGoalV1,GoalSnapshotV1,GoalVersionedCommandV1,SetGoalStateV1,goal_progress

NOW=datetime(2026,11,5,10,tzinfo=timezone.utc)


def goal(**changes):
    return GoalSnapshotV1(**{**dict(id=UUID(int=1),name="Emergency fund",target_minor=10000,currency="EUR",deadline="2026-11-15",
        priority=2,state="active",version=1,created_at=NOW,updated_at=NOW),**changes})


@pytest.mark.parametrize("changes",[
    {"name":" "},{"name":"x\nname"},{"name":"x"*121},{"target_minor":0},{"target_minor":True},{"target_minor":2**53},
    {"priority":0},{"priority":6},{"priority":True},{"priority":"2"},{"currency":"eur"},
    {"deadline":"2026-11-05T00:00:00Z"},{"deadline":"2026-02-30"},{"deadline":"20261105"},
    {"owner_user_id":str(UUID(int=2))},{"confirmed_saved_minor":1000},{"state":"completed"},{"version":2},
])
def test_goal_commands_are_closed_strict_and_do_not_accept_progress_or_authority(changes):
    with pytest.raises(ValidationError):
        CreateGoalV1(**{**dict(key="create-1",name="Emergency fund",target_minor=10000,currency="EUR",deadline="2026-11-15"),**changes})


def test_explicit_default_priority_trimmed_name_and_past_deadline_are_not_a_feasibility_promise():
    body=CreateGoalV1(key="goal-1",name="  Travel fund  ",target_minor=10000,currency="USD",deadline="2026-01-01")
    assert body.priority==3 and body.name=="Travel fund" and body.currency=="USD"
    progress=goal_progress(goal(deadline=body.deadline,currency=body.currency),reserved=0,consistent=True,now=NOW)
    assert progress.deadline_state=="past" and progress.required_daily_reservation_minor is None
    assert progress.reservation_gap_minor==10000 and progress.confirmed_savings_gap_minor is None
    assert progress.feasibility=="not_assessed"


def test_reservation_gap_and_daily_ceiling_do_not_claim_confirmed_saved_money():
    progress=goal_progress(goal(target_minor=10001),reserved=5000,consistent=True,now=NOW)
    assert progress.days_to_deadline==10 and progress.recorded_reserved_minor==5000
    assert progress.reservation_gap_minor==5001 and progress.required_daily_reservation_minor==501
    assert progress.confirmed_saved_minor is None and progress.confirmed_savings_gap_minor is None
    assert progress.feasibility=="not_assessed"


@pytest.mark.parametrize("delta,deadline_state,days",[("2026-11-05","today",0),("2026-11-04","past",-1),("2026-11-06","upcoming",1)])
def test_deadline_states_never_divide_by_zero_or_past_days(delta,deadline_state,days):
    progress=goal_progress(goal(deadline=delta),reserved=0,consistent=True,now=NOW)
    assert progress.deadline_state==deadline_state and progress.days_to_deadline==days
    assert progress.required_daily_reservation_minor==(10000 if days==1 else None)


def test_deadline_uses_helsinki_calendar_day_across_midnight_and_dst():
    for instant in (datetime(2026,10,24,22,tzinfo=timezone.utc),datetime(2026,10,25,22,tzinfo=timezone.utc)):
        day="2026-10-25" if instant.day==24 else "2026-10-26"
        assert goal_progress(goal(deadline=day),reserved=0,consistent=True,now=instant).days_to_deadline==0


@pytest.mark.parametrize("reserved,consistent",[(2**53,True),(-1,True),(True,True),(100,False)])
def test_inconsistent_or_overflowed_reservation_progress_is_unavailable_not_zero(reserved,consistent):
    progress=goal_progress(goal(),reserved=reserved,consistent=consistent,now=NOW)
    assert progress.status=="unavailable" and progress.recorded_reserved_minor is None and progress.reservation_gap_minor is None
    assert progress.required_daily_reservation_minor is None and progress.reason=="GOAL_RESERVATION_RECONCILIATION_REQUIRED"


def test_over_reserved_target_is_explicit_and_does_not_release_money_or_mark_saved():
    progress=goal_progress(goal(),reserved=15000,consistent=True,now=NOW)
    assert progress.reservation_gap_minor==0 and progress.excess_reservation_minor==5000
    assert progress.required_daily_reservation_minor==0 and progress.confirmed_saved_minor is None


@pytest.mark.parametrize("version",[0,True,"1",2**53])
def test_mutations_require_a_strict_bounded_expected_goal_version(version):
    with pytest.raises(ValidationError): GoalVersionedCommandV1(key="edit-1",expected_goal_version=version)


def test_completed_and_removed_states_cannot_be_fabricated_via_state_command():
    for state in ("removed","completed"):
        with pytest.raises(ValidationError): SetGoalStateV1(key="state-1",expected_goal_version=1,state=state)


@pytest.mark.parametrize("choice",[None,"release","keep","",True])
def test_unlink_requires_explicit_keep_reserved_choice(choice):
    from app.goals import UnlinkGoalAllocationV1
    body=dict(key="unlink-1",expected_goal_version=1)
    if choice is not None: body["reservation_choice"]=choice
    with pytest.raises(ValidationError): UnlinkGoalAllocationV1(**body)


def test_goal_link_receipt_is_separate_from_original_metadata_receipts():
    from app.goals import GoalAllocationCommandReceiptV1,GoalCommandReceiptV1,UnlinkGoalAllocationV1
    body=UnlinkGoalAllocationV1(key="unlink-1",expected_goal_version=2,reservation_choice="keep_reserved")
    assert body.reservation_choice=="keep_reserved"
    receipt=GoalAllocationCommandReceiptV1(id=UUID(int=2),action="link_allocation",goal=goal(),collection_version=2,applied_at=NOW,allocation_id=UUID(int=3))
    assert receipt.reservation_mutated is False and receipt.bank_transfer_executed is False
    with pytest.raises(ValidationError): GoalCommandReceiptV1.model_validate(receipt.model_dump())
