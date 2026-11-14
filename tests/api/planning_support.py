from datetime import datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from app.planning_policy import PlanningPolicyV1

NOW = datetime(2026,11,4,tzinfo=ZoneInfo("Europe/Helsinki"))
END = NOW+timedelta(days=30)
POLICY = PlanningPolicyV1()


def uid(number):
    return UUID(int=number)


def valid_inputs():
    return {"data_version":1,"plan_version":1,"as_of":NOW, "obligations_reviewed_through":END, "source":"synthetic_user_confirmed",
        "accounts":[{"id":uid(1),"currency":"EUR","account_type":"current","liquid":True,"material":True,
            "synced_at":NOW,"coverage":"user_confirmed","coverage_through":NOW,"liability_covered":None}],
        "balances":[{"id":uid(2),"account_id":uid(1),"amount_minor":80000,"currency":"EUR","kind":"available",
            "observed_at":NOW,"pending_reflection":"excluded","included_credit_minor":0,"inaccessible_minor":0}],
        "protections":[{"id":uid(index+10),"kind":kind,"amount_minor":amount,"reviewed_through":END,
            "routes":[{"account_id":uid(1),"amount_minor":amount}] if amount else []}
            for index,(kind,amount) in enumerate((("essentials",15000),("irregular",0),("savings",0),("buffer",10000)))],
        "costs":[{"id":uid(20),"economic_cost_id":uid(21),"account_id":uid(1),"at":NOW+timedelta(days=16),
            "amount_minor":35000,"opening_reflected":False,"kind":"bill"}]}
