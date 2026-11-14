"""Shared rule loading inside the caller's current authorized transaction."""
from .insights import planning_insights,planning_unavailable,spending_insights
from .planning_inputs import PlanningInputsV1
from .planning_policy import PlanningPolicyV1
from .planning_store import PlanningStore
from .spending_comparison import load_spending_comparison


def planning_preview(connection,user,now):
    store=PlanningStore(connection,user,clock=lambda:now)
    row=store.one("""SELECT * FROM moneylens.plans WHERE tenant_id=%s AND owner_user_id=%s
        AND state='active' AND reviewed_inputs IS NOT NULL""",store.owner)
    if row is None: return planning_unavailable(now,"CURRENT_PLAN_REQUIRED")
    inputs=PlanningInputsV1.model_validate(row["reviewed_inputs"])
    policy=PlanningPolicyV1.model_validate(row["planning_policy"])
    if not store.usable(row,now,inputs,policy): return planning_unavailable(now,"CURRENT_PLAN_REVIEW_REQUIRED")
    return planning_insights(row["id"],inputs,policy,quote_expires_at=row["quote_expires_at"],now=now)


def spending_preview(connection,user,body,now,maximum_age_hours=24):
    comparison=load_spending_comparison(connection,user,body.filters(),mode="previous_period",now=now,
        expected_data_version=body.expected_data_version,maximum_age_hours=maximum_age_hours)
    return spending_insights(comparison,now=now)
