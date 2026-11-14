"""Coaching choices and local quiet hours; external delivery stays unavailable."""
from datetime import datetime
from typing import Annotated,Literal
from uuid import UUID
from zoneinfo import ZoneInfo,ZoneInfoNotFoundError

from pydantic import AwareDatetime,Field,StrictBool,StrictInt,field_validator,model_validator

from .contracts import Contract

Version=Annotated[StrictInt,Field(ge=1,le=2**53-1)]
ClockTime=Annotated[str,Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")]


class CoachingFieldsV1(Contract):
    coaching_enabled: StrictBool
    bill_insights: StrictBool
    headroom_insights: StrictBool
    spending_insights: StrictBool
    timezone: str = Field(default="Europe/Helsinki",min_length=1,max_length=100)
    quiet_start: ClockTime | None = None
    quiet_end: ClockTime | None = None
    paused_until: AwareDatetime | None = None
    delivery_mode: Literal["in_app_only"] = "in_app_only"

    @field_validator("timezone")
    @classmethod
    def known_timezone(cls,value):
        try: ZoneInfo(value)
        except (ZoneInfoNotFoundError,ValueError): raise ValueError("Choose an available IANA timezone") from None
        return value

    @model_validator(mode="after")
    def explicit_quiet_window(self):
        if (self.quiet_start is None)!=(self.quiet_end is None) or self.quiet_start is not None and self.quiet_start==self.quiet_end:
            raise ValueError("Choose two distinct quiet-hour times, or clear both")
        return self


class SetCoachingPreferencesV1(CoachingFieldsV1):
    key: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")
    expected_preferences_version: Version


class CoachingSnapshotV1(CoachingFieldsV1):
    id: UUID
    version: Version
    created_at: AwareDatetime | None
    updated_at: AwareDatetime | None


class CoachingStateV1(Contract):
    generation_active: StrictBool
    in_app_available: Literal[True] = True
    paused: StrictBool
    quiet_now: StrictBool
    external_delivery_available: Literal[False] = False
    limitations: list[str]


class CoachingPreferencesViewV1(CoachingSnapshotV1):
    as_of: AwareDatetime
    state: CoachingStateV1


class CoachingCommandReceiptV1(Contract):
    schema_version: Literal["coaching-command.v1"] = "coaching-command.v1"
    id: UUID
    action: Literal["set_preferences"] = "set_preferences"
    preferences: CoachingSnapshotV1
    applied_at: AwareDatetime
    historical_command_snapshot: Literal[True] = True


def coaching_state(preferences,now):
    if not isinstance(now,datetime) or now.utcoffset() is None: raise ValueError("Use an explicit aware server clock")
    paused=preferences.paused_until is not None and preferences.paused_until>now
    clock=now.astimezone(ZoneInfo(preferences.timezone)).strftime("%H:%M")
    start,end=preferences.quiet_start,preferences.quiet_end
    quiet=False if start is None else start<=clock<end if start<end else clock>=start or clock<end
    return CoachingStateV1(generation_active=preferences.coaching_enabled and not paused,paused=paused,quiet_now=quiet,limitations=[
        "Proactive generation requires explicit opt-in and no active pause; per-kind choices apply separately.",
        "Quiet hours use local wall-clock minutes, start included and end excluded, including both occurrences of a repeated DST hour.",
        "Quiet hours do not hide owned in-app history. External notification delivery is not yet available.",
        "Saving preferences does not deliver, dismiss or erase an insight. Persisted insights and push subscriptions are separate features."])


def coaching_allows(preferences,kind,now):
    field={"upcoming_bill":"bill_insights","low_headroom":"headroom_insights","higher_observed_spending":"spending_insights"}.get(kind)
    if field is None: raise ValueError("Unregistered coaching kind")
    return coaching_state(preferences,now).generation_active and getattr(preferences,field)
