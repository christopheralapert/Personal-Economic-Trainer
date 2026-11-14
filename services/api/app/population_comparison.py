"""Bounded household consumption context over authorized, observed ledger totals."""
from datetime import date
from typing import Annotated,Literal
from uuid import UUID

from pydantic import AwareDatetime,Field,StrictBool,StrictInt

from .category_crosswalk import CategoryMappingCoverageV1,Code
from .contracts import BenchmarkSnapshot,Contract,Currency,Minor
from .identity import AuthError
from .ledger import bounded_money
from .population_cohorts import CohortSelectionRequestV1,CohortSelectionV1,select_cohort
from .spending_comparison import percentage_change
from .statfin import EXPENDITURE_UNIT


class PopulationComparisonRequestV1(CohortSelectionRequestV1):
    start: date
    end_exclusive: date
    account_ids: list[UUID] | None = Field(default=None,min_length=1,max_length=50)
    currency: Currency = "EUR"
    coicop_codes: list[Code] = Field(min_length=1,max_length=6)
    expected_data_version: Annotated[StrictInt,Field(ge=1,le=2**53-1)] | None = None
    comparison_basis: Literal["annual_observed","monthly_equivalent"]
    household_coverage_confirmed: StrictBool = False
    allow_short_period_approximation: StrictBool = False
    allow_reference_year_mismatch: StrictBool = False


class PopulationComparisonReasonV1(Contract):
    code: str
    action: str


class PopulationCategoryResultV1(Contract):
    coicop_code: str
    label: str
    status: Literal["comparable","approximate","withheld"]
    public_annual_mean_minor: Minor | None
    public_equivalent_minor: Minor | None
    observed_equivalent_minor: Minor | None
    difference_minor: Minor | None
    relative_difference_basis_points: StrictInt | None
    relative_difference_unavailable_reason: str | None
    source_status: str | None
    reasons: list[PopulationComparisonReasonV1]


class PopulationComparisonV1(Contract):
    status: Literal["comparable","approximate","partial","withheld","unavailable"]
    as_of: AwareDatetime
    transform_version: Literal["population-comparison.v1"] = "population-comparison.v1"
    comparison_basis: Literal["annual_observed","monthly_equivalent"]
    observed_calendar_months: Annotated[StrictInt,Field(ge=1,le=12)]
    observed_currency: Currency
    public_currency: Literal["EUR"] = "EUR"
    statistic_type: Literal["mean"] = "mean"
    household_coverage: Literal["user_confirmed","unconfirmed"]
    known_owned_scope_complete: bool | None
    material_bank_sources_complete: bool | None
    source: BenchmarkSnapshot | None
    source_updated_at: AwareDatetime | None
    selection: CohortSelectionV1 | None
    mapping: CategoryMappingCoverageV1 | None
    rows: list[PopulationCategoryResultV1] = Field(max_length=6)
    reasons: list[PopulationComparisonReasonV1]
    transformations: list[str]
    limitations: list[str]


def calendar_months(body):
    months=(body.end_exclusive.year-body.start.year)*12+body.end_exclusive.month-body.start.month
    if body.start.day!=1 or body.end_exclusive.day!=1 or not 1<=months<=12:
        raise AuthError("INVALID_BENCHMARK_PERIOD",422)
    return months


def rounded_ratio(numerator,denominator):
    magnitude=(2*abs(numerator)+denominator)//(2*denominator)
    return bounded_money(magnitude if numerator>=0 else -magnitude)


def reason(code,action):
    return PopulationComparisonReasonV1(code=code,action=action)


def unavailable_comparison(body,now,code="VERIFIED_POPULATION_DATA_UNAVAILABLE"):
    return PopulationComparisonV1(status="unavailable",as_of=now,comparison_basis=body.comparison_basis,
        observed_calendar_months=calendar_months(body),observed_currency=body.currency,
        household_coverage="user_confirmed" if body.household_coverage_confirmed else "unconfirmed",source=None,source_updated_at=None,
        known_owned_scope_complete=None,material_bank_sources_complete=None,
        selection=None,mapping=None,rows=[],reasons=[reason(code,"retry_verified_public_snapshot")],transformations=[],
        limitations=["A verified compatible public source and mapping are required. No comparison or replacement population value was calculated."])


def compare_population(body,totals,context,catalog,crosswalk,*,now,taxonomy,known_owned_scope_complete,material_bank_sources_complete):
    months=calendar_months(body)
    selection=select_cohort(CohortSelectionRequestV1(household_code=body.household_code,reference_period=body.reference_period),catalog)
    source=context.snapshot
    if not context.available or source is None or source.id!=catalog.snapshot.id or source.response_sha256!=catalog.snapshot.response_sha256 or (
        source.id!=crosswalk.view().snapshot_id or source.reference_period!=catalog.reference_period or source.statistic_type!="mean" or source.unit!=EXPENDITURE_UNIT or context.classification_version!="COICOP2018"):
        return unavailable_comparison(body,now,"INCOMPATIBLE_POPULATION_SOURCE")
    expected=(body.start,body.end_exclusive,body.currency)
    if (totals.scope.start,totals.scope.end_exclusive,totals.scope.currency)!=expected or totals.evidence_filters.category is not None or totals.evidence_filters.merchant is not None:
        raise AuthError("INVALID_BENCHMARK_SCOPE",422)
    if totals.evidence_filters.status!="booked":
        raise AuthError("HISTORICAL_SPENDING_REQUIRES_BOOKED",422)
    mapping=crosswalk.apply(totals,taxonomy=taxonomy,target_codes=body.coicop_codes)
    common=[]
    if selection.status!="selected": common.append(reason(selection.reason,"choose_available_household_and_year"))
    if not body.household_coverage_confirmed: common.append(reason("HOUSEHOLD_COVERAGE_REQUIRED","confirm_complete_household_expense_scope"))
    if not known_owned_scope_complete: common.append(reason("KNOWN_ACCOUNT_SCOPE_INCOMPLETE","include_all_known_owned_accounts_or_review_missing_scope"))
    if not material_bank_sources_complete: common.append(reason("MATERIAL_BANK_SOURCE_INCOMPLETE","renew_and_publish_all_previously_granted_sources"))
    if totals.scope.dataset_coverage!="covered_synthetic_snapshot" or not totals.scope.account_ids:
        common.append(reason("INCOMPLETE_ACCOUNT_HISTORY","publish_complete_authorized_history_for_window"))
    if body.currency!="EUR": common.append(reason("CURRENCY_NOT_COMPARABLE","use_supported_eur_source_without_unverified_conversion"))
    if totals.unresolved_flow_count: common.append(reason("UNRESOLVED_ECONOMIC_FLOWS","review_unresolved_source_flows"))
    if mapping.status=="unavailable": common.append(reason("INCOMPLETE_CATEGORY_BREAKDOWN","use_complete_bounded_category_evidence"))
    if taxonomy!=crosswalk.view().category_taxonomy or any(item.status=="unmapped" for item in mapping.decisions):
        common.append(reason("UNMAPPED_CATEGORY_COVERAGE","review_source_taxonomy_and_unknown_categories"))
    if any(group.label=="transfer" and group.transaction_count for group in totals.category_baskets):
        common.append(reason("INCONSISTENT_CONSUMPTION_CATEGORY","review_transfer_economic_flow_before_comparison"))
    if body.comparison_basis=="annual_observed" and months!=12:
        common.append(reason("ANNUAL_WINDOW_REQUIRED","choose_twelve_complete_calendar_months"))
    short=months<12
    if short and body.comparison_basis=="monthly_equivalent" and not body.allow_short_period_approximation:
        common.append(reason("SHORT_PERIOD_APPROXIMATION_REQUIRES_CONFIRMATION","confirm_seasonality_limited_monthly_context"))
    reference_year=int(source.reference_period)
    same_price_year=body.start.year==reference_year and body.end_exclusive<=date(reference_year+1,1,1)
    if not same_price_year and not body.allow_reference_year_mismatch:
        common.append(reason("REFERENCE_YEAR_MISMATCH","confirm_unadjusted_older_reference_year_context"))
    approximate=body.comparison_basis=="monthly_equivalent" or not same_price_year
    observations={(item.coicop_code,item.household_code):item for item in context.observations}
    rows=[]
    for assignment in mapping.assignments:
        code=assignment.target.code
        observation=observations.get((code,selection.cohort.code)) if selection.cohort else None
        blockers=list(common)
        ambiguous=any(item.status=="ambiguous" and any(candidate.startswith(code) or code.startswith(candidate) for candidate in item.candidate_codes) for item in mapping.decisions)
        if ambiguous: blockers.append(reason("AMBIGUOUS_CATEGORY_COVERAGE","classify_or_split_relevant_ambiguous_purchases"))
        if observation is None or observation.annual_mean_minor is None or observation.source_status:
            blockers.append(reason("POPULATION_CELL_UNAVAILABLE","choose_an_explicit_available_cohort_or_category"))
        if assignment.assigned_observed.net_minor<0:
            blockers.append(reason("REFUND_DOMINATED_PERIOD","review_refund_booking_period_before_interpreting_consumption"))
        annual=observation.annual_mean_minor if observation is not None and not observation.source_status else None
        public_equivalent=rounded_ratio(annual,12) if annual is not None and body.comparison_basis=="monthly_equivalent" else annual
        personal=difference=percent=percent_reason=None
        if not blockers:
            personal=rounded_ratio(assignment.assigned_observed.net_minor,months) if body.comparison_basis=="monthly_equivalent" else assignment.assigned_observed.net_minor
            difference=bounded_money(personal-public_equivalent)
            percent,percent_reason=percentage_change(personal,public_equivalent)
        rows.append(PopulationCategoryResultV1(coicop_code=code,label=assignment.target.label,status="withheld" if blockers else "approximate" if approximate else "comparable",
            public_annual_mean_minor=annual,public_equivalent_minor=public_equivalent,observed_equivalent_minor=personal,difference_minor=difference,
            relative_difference_basis_points=percent,relative_difference_unavailable_reason=percent_reason,
            source_status=observation.source_status if observation else None,reasons=blockers))
    accepted=sum(row.status!="withheld" for row in rows)
    status="withheld" if not accepted else "partial" if accepted<len(rows) else "approximate" if approximate else "comparable"
    transforms=["Observed ledger consumption uses valid booked expenses minus booked refunds in the named half-open date window.",
        "Mapping: "+mapping.mapping_version+"; rule digest "+mapping.policy_sha256+".",
        "Money remains integer minor units; ratios round half-up. Relative differences use basis points, not population percentiles."]
    if body.comparison_basis=="monthly_equivalent":
        transforms.append(f"Observed consumption divided by {months} complete calendar month(s); published annual household mean divided by 12. No annual observation is invented.")
    else: transforms.append("Twelve complete observed calendar months are compared with the published annual household mean.")
    return PopulationComparisonV1(status=status,as_of=now,comparison_basis=body.comparison_basis,observed_calendar_months=months,observed_currency=body.currency,
        household_coverage="user_confirmed" if body.household_coverage_confirmed else "unconfirmed",source=source.model_copy(deep=True),
        known_owned_scope_complete=known_owned_scope_complete,material_bank_sources_complete=material_bank_sources_complete,
        source_updated_at=context.data_updated_at,selection=selection,mapping=mapping,rows=rows,reasons=common,transformations=transforms,limitations=[
            "The published statistic is a household mean for "+source.reference_period+" at that year's current prices. No inflation or currency adjustment is applied.",
            "Monthly equivalents provide approximate context, with seasonality and short-window limitations; they are not observed monthly survey means.",
            "Household coverage is the user's explicit assertion about the named accounts, not a bank-verified fact. Selected accounts do not establish whole finances automatically.",
            "Differences describe this observed consumption scope. They provide no spending target, saving capacity, rank, median or percentile.",
            "Ambiguity blocks affected categories; unknown categories, unresolved flows and missing source scope block all comparisons. Suppressed public cells remain unavailable.",
            "Private comparison is performed locally against the verified public artifact. No personal data is sent to Statistics Finland.",
        ])
