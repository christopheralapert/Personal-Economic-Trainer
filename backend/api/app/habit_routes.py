from datetime import datetime,timezone

from fastapi import APIRouter,Depends,Request

from .auth_routes import write_principal
from .identity import authorized_transaction
from .ledger import Ledger
from .spending_habits import SpendingHabitsArgumentsV1,SpendingHabitsV1,spending_habits

router=APIRouter()


@router.post("/v1/analysis/spending/habits",response_model=SpendingHabitsV1)
def habits(body:SpendingHabitsArgumentsV1,request:Request,user=Depends(write_principal)):
    config=request.app.state.settings
    now=request.app.state.bank_clock() if hasattr(request.app.state,"bank_clock") else datetime.now(timezone.utc)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            totals=Ledger(connection,user,body.filters(),expected_data_version=body.expected_data_version,now=now,
                maximum_age_hours=config.balance_maximum_age_hours).totals()
            return spending_habits(body,totals,now=now)
