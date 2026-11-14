"""Private benchmark choices. Public sources never receive personal inputs."""
from datetime import datetime,timezone
from fastapi import APIRouter,Depends,Request

from .auth_routes import write_principal
from .identity import authorized_transaction
from .population_cohorts import CohortSelectionRequestV1,CohortSelectionV1,select_cohort
from .statfin import SnapshotError
from .population_cohorts import bundled_cohort_catalog
from .category_crosswalk import bundled_crosswalk
from .population_comparison import PopulationComparisonRequestV1,PopulationComparisonV1,calendar_months,compare_population,unavailable_comparison
from .public_routes import bundled_public_context
from .ledger import Ledger,LedgerFilterV1
from .identity import AuthError
from .bank_access import planning_sources_ready

router=APIRouter()


@router.post("/v1/benchmarks/cohort-selection",response_model=CohortSelectionV1)
def cohort_selection(body:CohortSelectionRequestV1,request:Request,user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user):
            try:
                return select_cohort(body)
            except (SnapshotError,ValueError):
                return CohortSelectionV1(status="unavailable",requested=body,catalog=None,cohort=None,reason="VERIFIED_COHORTS_UNAVAILABLE")


@router.post("/v1/benchmarks/comparison",response_model=PopulationComparisonV1)
def comparison(body:PopulationComparisonRequestV1,request:Request,user=Depends(write_principal)):
    calendar_months(body)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,repeatable_read=True):
            now=request.app.state.bank_clock() if hasattr(request.app.state,"bank_clock") else datetime.now(timezone.utc)
            try:
                crosswalk=bundled_crosswalk()
                context,catalog=bundled_public_context(),bundled_cohort_catalog()
            except (SnapshotError,ValueError):
                return unavailable_comparison(body,now)
            try: crosswalk.selection(body.coicop_codes)
            except ValueError: raise AuthError("INVALID_BENCHMARK_CATEGORIES",422) from None
            totals=Ledger(connection,user,LedgerFilterV1(start=body.start,end_exclusive=body.end_exclusive,currency=body.currency,account_ids=body.account_ids),
                expected_data_version=body.expected_data_version,now=now,maximum_age_hours=request.app.state.settings.balance_maximum_age_hours).totals()
            current_synthetic=connection.execute("SELECT is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",(user.scope.tenant_id,user.scope.user_id)).fetchone()==(True,)
            taxonomy="moneylens.synthetic.categories.v1" if current_synthetic else "unreviewed"
            known=connection.execute("SELECT id FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s ORDER BY id LIMIT 201",(user.scope.tenant_id,user.scope.user_id)).fetchall()
            complete=bool(known) and len(known)<=200 and {row[0] for row in known}==set(totals.scope.account_ids)
            sources_ready=True
            try: planning_sources_ready(connection,user,now)
            except AuthError as error:
                if error.code!="BANK_SOURCE_NOT_READY": raise
                sources_ready=False
            return compare_population(body,totals,context,catalog,crosswalk,now=now,taxonomy=taxonomy,
                known_owned_scope_complete=complete,material_bank_sources_complete=sources_ready)
