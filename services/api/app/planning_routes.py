"""Private planning commands. Identity, policy and source facts stay server-owned."""
from typing import Annotated, Literal
from uuid import UUID, uuid5

from fastapi import APIRouter, Depends, Query, Request
from pydantic import AwareDatetime, Field, StrictBool, StrictInt

from .allocation_contracts import AllocationReceiptV1, AllocationSnapshotV1
from .auth_routes import principal, write_principal
from .contracts import Blocker, Contract, FinancialResult, NonnegativeMinor
from .planning_engine import AllocationProposalV1, PlanningOutcomeV1, propose_allocation
from .planning_store import PlanningStore
from .planning_policy import PlanningPolicyV1
from .planning_review import CreateReviewedPlanV1, PlanningReview, ReviewContextV1
from .planning_inputs import PlanningInputsV1
from .scoped_keys import CursorCodec

router = APIRouter()
Version = Annotated[StrictInt, Field(ge=1, le=2**53-1)]
CommandKey = Annotated[str, Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")]


class PlanningEvidenceV1(Contract):
    plan_id: UUID
    data_version: Version
    plan_version: Version
    source: Literal["synthetic_user_confirmed", "verified"]
    balance_snapshot_ids: list[UUID]
    interpretation: Literal["reviewed_assumptions_not_bank_transfer"] = "reviewed_assumptions_not_bank_transfer"


class PlanningAnalysisV1(Contract):
    calculation_id: UUID
    calculation_version: Literal[1] = 1
    data_version: Version
    status: Literal["estimated", "blocked"]
    as_of: AwareDatetime
    result: FinancialResult
    evidence: PlanningEvidenceV1
    assumptions: list[str]
    blockers: list[Blocker]


class PlanViewV1(Contract):
    id: UUID
    state: Literal["draft", "active", "superseded"]
    data_version: Version
    plan_version: Version
    as_of: AwareDatetime
    expires_at: AwareDatetime
    current: StrictBool
    calculation: PlanningOutcomeV1 | None
    analysis: PlanningAnalysisV1


class ProposalRequestV1(Contract):
    desired_discretionary_minor: NonnegativeMinor
    chosen_savings_minor: NonnegativeMinor | None = None


class AcceptAllocationV1(Contract):
    key: CommandKey
    expected_data_version: Version
    expected_plan_version: Version
    account_id: UUID
    amount_minor: Annotated[NonnegativeMinor, Field(gt=0)]
    desired_discretionary_minor: NonnegativeMinor


class ReleaseAllocationV1(Contract):
    key: CommandKey
    expected_data_version: Version
    expected_plan_version: Version


class ReviewedPlanResultV1(Contract):
    plan: PlanViewV1 | None
    calculation: PlanningOutcomeV1 | None


class SavedPlanReviewV1(Contract):
    plan_id: UUID
    current: StrictBool
    inputs: PlanningInputsV1
    policy: PlanningPolicyV1


class AllocationPageV1(Contract):
    rows: list[AllocationReceiptV1]
    next_cursor: str | None
    data_version: Version
    plan_version: Version


def repository(request, connection, user):
    options = {}
    # Tests may inject a server clock; there is deliberately no client clock field.
    if hasattr(request.app.state, "planning_clock"):
        options["clock"] = request.app.state.planning_clock
    return PlanningStore(connection, user, **options)


def plan_view(view):
    outcome = view["calculation"]
    forecast = outcome.baseline.consolidated if outcome and outcome.baseline else None
    blockers = [Blocker(code=item.code, action=item.action,
        message="Review the named planning input before using an amount.") for item in outcome.blockers] if outcome else [
        Blocker(code="PLANNING_REVIEW_REQUIRED", action="refresh_and_review_plan",
            message="This plan is no longer current. Refresh its source facts and review it again.")]
    analysis = PlanningAnalysisV1(calculation_id=uuid5(view["id"], f"{view['data_version']}:{view['plan_version']}:v1"),
        data_version=view["data_version"], status=outcome.status if outcome else "blocked", as_of=view["as_of"],
        result=FinancialResult(amount_minor=outcome.amount_minor if outcome else None,
            **(forecast.model_dump() if forecast else {})),
        evidence=PlanningEvidenceV1(plan_id=view["id"], data_version=view["data_version"],
            plan_version=view["plan_version"], source=view["source"], balance_snapshot_ids=view["balance_snapshot_ids"]),
        assumptions=outcome.assumptions if outcome else ["Historical receipts do not provide current spending guidance."],
        blockers=blockers)
    return PlanViewV1(**{key:value for key,value in view.items() if key not in ("source", "balance_snapshot_ids")}, analysis=analysis)


@router.get("/v1/planning/context", response_model=ReviewContextV1)
def review_context(request: Request, user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        service = PlanningReview(repository(request, connection, user), PlanningPolicyV1.from_settings(request.app.state.settings))
        return service.context()


@router.post("/v1/plans", response_model=ReviewedPlanResultV1)
def create_plan(body: CreateReviewedPlanV1, request: Request, user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        service = PlanningReview(repository(request, connection, user), PlanningPolicyV1.from_settings(request.app.state.settings))
        view, outcome = service.create(body)
        return ReviewedPlanResultV1(plan=plan_view(view) if view else None, calculation=outcome)


@router.get("/v1/plans/current", response_model=PlanViewV1 | None)
def current_plan(request: Request, user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        view = repository(request, connection, user).current()
        return plan_view(view) if view else None


@router.get("/v1/plans/{plan_id}", response_model=PlanViewV1)
def read_plan(plan_id: UUID, request: Request, user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return plan_view(repository(request, connection, user).read(plan_id))


@router.post("/v1/plans/{plan_id}/proposal", response_model=AllocationProposalV1)
def preview_allocation(plan_id: UUID, body: ProposalRequestV1, request: Request, user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        view = repository(request, connection, user).read(plan_id)
        if view["calculation"] is None:
            return AllocationProposalV1(status="blocked", surplus_minor=None,
                desired_discretionary_minor=body.desired_discretionary_minor, savings_capacity_minor=None,
                chosen_savings_minor=body.chosen_savings_minor, remaining_spending_minor=None,
                blockers=[dict(code="PLANNING_REVIEW_REQUIRED", action="refresh_and_review_plan")])
        return propose_allocation(view["calculation"], **body.model_dump())


@router.get("/v1/plans/{plan_id}/review", response_model=SavedPlanReviewV1)
def read_review(plan_id: UUID, request: Request, user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request, connection, user).review(plan_id)


@router.get("/v1/plans/{plan_id}/allocations", response_model=AllocationPageV1)
def allocation_history(plan_id: UUID, request: Request, user=Depends(principal),
    cursor: Annotated[str | None, Query(max_length=4096)]=None,limit: Annotated[int, Query(ge=1,le=50)]=20):
    with request.app.state.pools.finance.connection() as connection:
        codec = CursorCodec(request.app.state.settings.session_secret.get_secret_value())
        return repository(request, connection, user).receipts(plan_id,codec,cursor=cursor,limit=limit)


@router.post("/v1/plans/{plan_id}/allocations", response_model=AllocationReceiptV1)
def accept_allocation(plan_id: UUID, body: AcceptAllocationV1, request: Request, user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request, connection, user).accept(plan_id, **body.model_dump())


@router.get("/v1/plans/{plan_id}/allocations/{allocation_id}", response_model=AllocationReceiptV1)
def read_allocation(plan_id: UUID, allocation_id: UUID, request: Request, user=Depends(principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request, connection, user).read_receipt(plan_id, allocation_id)


@router.post("/v1/plans/{plan_id}/allocations/{allocation_id}/release", response_model=AllocationReceiptV1)
def release_allocation(plan_id: UUID, allocation_id: UUID, body: ReleaseAllocationV1, request: Request, user=Depends(write_principal)):
    with request.app.state.pools.finance.connection() as connection:
        return repository(request, connection, user).release(plan_id, allocation_id, **body.model_dump())
