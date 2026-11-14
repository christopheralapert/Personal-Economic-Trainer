from datetime import date,datetime,timezone
from typing import Annotated,Literal
from uuid import UUID

from fastapi import APIRouter,Depends,Query,Request

from .auth_routes import principal
from .identity import authorized_transaction
from .ledger import Ledger,LedgerFilterV1,LedgerPageV1,LedgerInventoryV1,SpendingTotalsV1
from .scoped_keys import CursorCodec
from .spending_comparison import ComparisonMode,SpendingComparisonV1,comparison_window,load_spending_comparison

router = APIRouter()


def ledger_filters(start:date,end_exclusive:date,
    currency:Annotated[str,Query(pattern="^[A-Z]{3}$")]="EUR",
    account_id:Annotated[list[UUID] | None,Query(max_length=50)]=None,
    category:Annotated[str | None,Query(max_length=100)]=None,
    merchant:Annotated[str | None,Query(max_length=200)]=None,
    status:Literal["booked","pending","reversed"]="booked",spending_only:bool=False,needs_review:bool=False):
    return LedgerFilterV1(start=start,end_exclusive=end_exclusive,currency=currency,account_ids=account_id,
        category=category,merchant=merchant,status=status,spending_only=spending_only,needs_review=needs_review)


@router.get("/v1/ledger/transactions",response_model=LedgerPageV1)
def transactions(request:Request,filters=Depends(ledger_filters),user=Depends(principal),
    cursor:Annotated[str | None,Query(max_length=4096)]=None,limit:Annotated[int,Query(ge=1,le=200)]=50,
    expected_data_version:Annotated[int | None,Query(ge=1)]=None):
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            now=request.app.state.bank_clock() if hasattr(request.app.state,"bank_clock") else None
            ledger = Ledger(connection,user,filters,expected_data_version=expected_data_version,now=now,
                maximum_age_hours=request.app.state.settings.balance_maximum_age_hours)
            codec = CursorCodec(request.app.state.settings.session_secret.get_secret_value())
            return ledger.page(codec,cursor=cursor,limit=limit)


@router.get("/v1/ledger/inventory",response_model=LedgerInventoryV1)
def inventory(request:Request,filters=Depends(ledger_filters),user=Depends(principal),
    expected_data_version:Annotated[int | None,Query(ge=1)]=None):
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            return Ledger(connection,user,filters,expected_data_version=expected_data_version).inventory()


@router.get("/v1/analysis/spending",response_model=SpendingTotalsV1)
def spending(request:Request,filters=Depends(ledger_filters),user=Depends(principal),
    expected_data_version:Annotated[int | None,Query(ge=1)]=None):
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            now=request.app.state.bank_clock() if hasattr(request.app.state,"bank_clock") else None
            return Ledger(connection,user,filters,expected_data_version=expected_data_version,now=now,
                maximum_age_hours=request.app.state.settings.balance_maximum_age_hours).totals()


@router.get("/v1/analysis/spending/comparison",response_model=SpendingComparisonV1)
def comparison(request:Request,filters=Depends(ledger_filters),user=Depends(principal),
    mode:ComparisonMode="previous_period",baseline_start:date | None=None,baseline_end_exclusive:date | None=None,
    expected_data_version:Annotated[int | None,Query(ge=1)]=None):
    comparison_window(filters.start,filters.end_exclusive,mode,baseline_start,baseline_end_exclusive)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            now=request.app.state.bank_clock() if hasattr(request.app.state,"bank_clock") else datetime.now(timezone.utc)
            options={"expected_data_version":expected_data_version,"now":now,
                "maximum_age_hours":request.app.state.settings.balance_maximum_age_hours}
            return load_spending_comparison(connection,user,filters,mode=mode,baseline_start=baseline_start,baseline_end_exclusive=baseline_end_exclusive,**options)
