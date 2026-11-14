"""Goal metadata and recorded reservation gaps, not inferred actual savings."""
from datetime import date,datetime
import re
from typing import Annotated,Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime,Field,StrictInt,field_validator

from .contracts import Contract,Currency,NonnegativeMinor
from .allocation_contracts import AllocationReceiptV1

GoalVersion=Annotated[StrictInt,Field(ge=1,le=2**53-1)]
GoalPriority=Annotated[StrictInt,Field(ge=1,le=5)]
GoalState=Literal["active","paused","completed","removed"]
GoalKey=Annotated[str,Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")]


class GoalFieldsV1(Contract):
    name: str = Field(min_length=1,max_length=120)
    target_minor: Annotated[NonnegativeMinor,Field(gt=0)]
    currency: Currency
    deadline: date
    priority: GoalPriority = 3

    @field_validator("name")
    @classmethod
    def readable_name(cls,value):
        value=value.strip()
        if not value or any(ord(char)<32 or ord(char)==127 for char in value):
            raise ValueError("Choose a nonblank single-line goal name")
        return value

    @field_validator("deadline",mode="before")
    @classmethod
    def calendar_deadline(cls,value):
        if isinstance(value,datetime) or isinstance(value,str) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}",value):
            raise ValueError("Choose an explicit calendar date")
        return value


class CreateGoalV1(GoalFieldsV1):
    key: GoalKey


class ReviseGoalV1(GoalFieldsV1):
    key: GoalKey
    expected_goal_version: GoalVersion


class GoalVersionedCommandV1(Contract):
    key: GoalKey
    expected_goal_version: GoalVersion


class SetGoalStateV1(GoalVersionedCommandV1):
    state: Literal["active","paused"]


class UnlinkGoalAllocationV1(GoalVersionedCommandV1):
    reservation_choice: Literal["keep_reserved"]


class GoalSnapshotV1(GoalFieldsV1):
    id: UUID
    state: GoalState
    version: GoalVersion
    created_at: AwareDatetime | None
    updated_at: AwareDatetime | None


class GoalProgressV1(Contract):
    status: Literal["available","unavailable"]
    recorded_reserved_minor: NonnegativeMinor | None
    reservation_gap_minor: NonnegativeMinor | None
    excess_reservation_minor: NonnegativeMinor | None
    confirmed_saved_minor: NonnegativeMinor | None = None
    confirmed_savings_gap_minor: NonnegativeMinor | None = None
    days_to_deadline: StrictInt
    deadline_state: Literal["upcoming","today","past"]
    required_daily_reservation_minor: NonnegativeMinor | None
    feasibility: Literal["not_assessed"] = "not_assessed"
    reason: str | None
    limitations: list[str]


def goal_progress(goal,*,reserved,consistent,now):
    days=(goal.deadline-now.astimezone(ZoneInfo("Europe/Helsinki")).date()).days
    available=consistent and type(reserved) is int and 0<=reserved<=2**53-1
    gap=max(0,goal.target_minor-reserved) if available else None
    return GoalProgressV1(status="available" if available else "unavailable",recorded_reserved_minor=reserved if available else None,
        reservation_gap_minor=gap,excess_reservation_minor=max(0,reserved-goal.target_minor) if available else None,
        days_to_deadline=days,deadline_state="upcoming" if days>0 else "today" if days==0 else "past",
        required_daily_reservation_minor=(gap+days-1)//days if available and days>0 else None,
        reason=None if available else "GOAL_RESERVATION_RECONCILIATION_REQUIRED",limitations=[
            "Recorded reservations are earmarks, not verified money saved or a bank transfer. Confirmed saved progress is not yet reconciled.",
            "The reservation gap describes this target's unreserved portion. It is not a verified gap in actual savings.",
            "Daily pacing divides the reservation gap by remaining Helsinki calendar days, rounded up. It does not assess income, affordability or achievable timing.",
            "Pausing a goal does not release reservations. Removing a goal with active reservations requires a separate explicit reservation review.",
        ])


class GoalViewV1(GoalSnapshotV1):
    as_of: AwareDatetime
    collection_version: GoalVersion
    data_version: GoalVersion
    plan_version: GoalVersion
    progress: GoalProgressV1


class GoalPageV1(Contract):
    rows: list[GoalViewV1] = Field(max_length=100)
    next_cursor: str | None
    collection_version: GoalVersion
    data_version: GoalVersion
    plan_version: GoalVersion
    as_of: AwareDatetime


class GoalCommandReceiptV1(Contract):
    schema_version: Literal["goal-command.v1"] = "goal-command.v1"
    id: UUID
    action: Literal["create","revise","set_state","remove"]
    goal: GoalSnapshotV1
    collection_version: GoalVersion
    applied_at: AwareDatetime
    historical_command_snapshot: Literal[True] = True


class GoalPagePositionV1(Contract):
    priority: GoalPriority
    deadline: date
    id: UUID


class GoalAllocationCommandReceiptV1(GoalCommandReceiptV1):
    action: Literal["link_allocation","unlink_allocation"]
    allocation_id: UUID
    reservation_mutated: Literal[False] = False
    bank_transfer_executed: Literal[False] = False


class GoalAllocationPageV1(Contract):
    goal_id: UUID
    goal_version: GoalVersion
    rows: list[AllocationReceiptV1] = Field(max_length=100)
    next_cursor: str | None
    collection_version: GoalVersion
    data_version: GoalVersion
    plan_version: GoalVersion
    as_of: AwareDatetime


class GoalAllocationPositionV1(Contract):
    accepted_at: AwareDatetime
    id: UUID
