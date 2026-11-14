"""Explicit authored assumptions for the public fixture, never customer input loading."""
from datetime import timedelta
from uuid import uuid5

from .planning_engine import calculate_planning
from .planning_inputs import PlanningInputsV1
from .planning_policy import PlanningPolicyV1, protection_period


def demo_forecast(profile, settings):
    policy = PlanningPolicyV1.from_settings(settings)
    period = protection_period(profile.as_of,policy)
    first, second = profile.accounts
    def identity(label):
        return uuid5(first.id,label)
    data = PlanningInputsV1(data_version=1,plan_version=1,as_of=profile.as_of,
        source="synthetic_user_confirmed",obligations_reviewed_through=period.protection_through,
        accounts=[dict(id=account.id,currency=account.currency,account_type=account.account_type,
            liquid=True,material=True,synced_at=profile.as_of,coverage="user_confirmed",
            coverage_through=profile.as_of,liability_covered=None) for account in profile.accounts],
        balances=[dict(id=balance.id,account_id=balance.account_id,amount_minor=balance.amount_minor,
            currency=balance.currency,kind=balance.kind,observed_at=balance.observed_at,
            pending_reflection=balance.pending_reflection,included_credit_minor=balance.included_credit_minor,
            inaccessible_minor=0) for balance in profile.balances],
        protections=[dict(id=identity(kind),kind=kind,amount_minor=amount,
            reviewed_through=period.protection_through,routes=[dict(account_id=account,amount_minor=amount)] if amount else [])
            for kind,amount,account in (("essentials",profile.essentials_minor,first.id),
                ("irregular",0,first.id),("savings",0,first.id),("buffer",profile.buffer_minor,second.id))],
        costs=[dict(id=identity("bill"),economic_cost_id=identity("bill-economic"),account_id=first.id,
            at=profile.as_of+timedelta(days=16),amount_minor=profile.bills_minor,opening_reflected=False,kind="bill")])
    return calculate_planning(data,policy)
