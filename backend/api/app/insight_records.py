"""Typed stored rule snapshots; historical records are never spending permission."""
from typing import Annotated,Literal
from uuid import UUID

from pydantic import AwareDatetime,Field,StrictInt

from .contracts import Contract
from .goals import GoalKey,GoalVersion
from .insights import InsightCandidateV1,PlanningInsightEvidenceV1,InsightRulePolicyV1
from .spending_comparison import SpendingComparisonV1

InsightStatus=Literal["active","superseded","dismissed"]


class PlanningStoredEvidenceV1(Contract):
    kind: Literal["planning"] = "planning"
    policy: InsightRulePolicyV1
    planning: PlanningInsightEvidenceV1
    omitted_candidate_count: Annotated[StrictInt,Field(ge=0)] = 0


class SpendingStoredEvidenceV1(Contract):
    kind: Literal["spending"] = "spending"
    policy: InsightRulePolicyV1
    comparison: SpendingComparisonV1


StoredEvidenceV1=Annotated[PlanningStoredEvidenceV1|SpendingStoredEvidenceV1,Field(discriminator="kind")]


class InsightRecordV1(Contract):
    id: UUID
    status: InsightStatus
    version: GoalVersion
    candidate: InsightCandidateV1
    data_version: GoalVersion
    plan_version: GoalVersion
    preferences_version: GoalVersion
    generated_at: AwareDatetime
    expires_at: AwareDatetime
    created_at: AwareDatetime
    updated_at: AwareDatetime
    dismissed_at: AwareDatetime | None
    current: bool
    current_blockers: list[str]
    interpretation: Literal["stored_rule_snapshot_not_spending_permission"] = "stored_rule_snapshot_not_spending_permission"


class InsightSummaryV1(InsightRecordV1):
    evidence_kind: Literal["planning","spending"]


class InsightViewV1(InsightRecordV1):
    evidence: StoredEvidenceV1


class InsightPageV1(Contract):
    rows: list[InsightSummaryV1] = Field(max_length=100)
    next_cursor: str | None
    collection_version: GoalVersion
    data_version: GoalVersion
    plan_version: GoalVersion
    preferences_version: GoalVersion
    as_of: AwareDatetime


class InsightPositionV1(Contract):
    updated_at: AwareDatetime
    id: UUID


class RefreshInsightsV1(Contract):
    key: GoalKey


class DismissInsightV1(Contract):
    key: GoalKey
    expected_insight_version: GoalVersion


class InsightCommandReceiptV1(Contract):
    schema_version: Literal["insight-command.v1"] = "insight-command.v1"
    id: UUID
    action: Literal["dismiss"] = "dismiss"
    insight_id: UUID
    insight_version: GoalVersion
    collection_version: GoalVersion
    status: Literal["dismissed"] = "dismissed"
    applied_at: AwareDatetime
    historical_command_snapshot: Literal[True] = True
