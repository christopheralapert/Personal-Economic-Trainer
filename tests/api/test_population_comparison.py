from datetime import datetime,timezone

import pytest
from pydantic import ValidationError

from app.category_crosswalk import load_crosswalk
from app.identity import AuthError
from app.population_cohorts import bundled_cohort_catalog
from app.population_comparison import PopulationComparisonRequestV1,calendar_months,compare_population,rounded_ratio
from app.public_routes import bundled_public_context
from test_category_crosswalk import spending

NOW=datetime(2026,11,4,10,tzinfo=timezone.utc)


def request(**changes):
    return PopulationComparisonRequestV1(**{**dict(household_code="1",reference_period="2022",start="2026-10-01",end_exclusive="2026-11-01",
        coicop_codes=["07322"],comparison_basis="monthly_equivalent",household_coverage_confirmed=True,
        allow_short_period_approximation=True,allow_reference_year_mismatch=True),**changes})


def calculate(body=None,totals=None,*,context=None,taxonomy="moneylens.synthetic.categories.v1",known_scope=True,material_sources=True):
    body=body or request()
    totals=totals or spending(("taxi",10000,0,"everyday"))
    # Unit-only authorized-source fixture. Real source coverage is checked by
    # the HTTP/PostgreSQL tests, never supplied by the browser.
    totals.scope.start=totals.evidence_filters.start=body.start
    totals.scope.end_exclusive=totals.evidence_filters.end_exclusive=body.end_exclusive
    totals.scope.currency=totals.evidence_filters.currency=body.currency
    totals.scope.dataset_coverage="covered_synthetic_snapshot"
    return compare_population(body,totals,context or bundled_public_context().model_copy(deep=True),bundled_cohort_catalog(),load_crosswalk(),now=NOW,taxonomy=taxonomy,
        known_owned_scope_complete=known_scope,material_bank_sources_complete=material_sources)


def codes(row): return {item.code for item in row.reasons}


def test_monthly_context_preserves_real_mean_provenance_and_explicit_approximation():
    result=calculate()
    row=result.rows[0]
    assert result.status==row.status=="approximate" and row.observed_equivalent_minor==10000
    assert row.public_equivalent_minor==rounded_ratio(row.public_annual_mean_minor,12)
    assert row.difference_minor==10000-row.public_equivalent_minor
    assert result.statistic_type=="mean" and result.household_coverage=="user_confirmed"
    assert result.source.reference_period=="2022" and result.mapping.policy_sha256==load_crosswalk().digest
    assert result.selection.cohort.code=="1" and result.transform_version=="population-comparison.v1"
    assert result.source.attribution.startswith("Source: Statistics Finland") and result.source.licence_url
    assert any("No inflation" in item for item in result.limitations)


def test_same_reference_year_full_annual_observation_is_comparable():
    result=calculate(request(start="2022-01-01",end_exclusive="2023-01-01",comparison_basis="annual_observed",allow_reference_year_mismatch=False,allow_short_period_approximation=False))
    assert result.status==result.rows[0].status=="comparable" and result.observed_calendar_months==12
    assert result.rows[0].observed_equivalent_minor==10000 and result.rows[0].public_equivalent_minor==result.rows[0].public_annual_mean_minor


@pytest.mark.parametrize("changes,expected",[
    ({"household_coverage_confirmed":False},"HOUSEHOLD_COVERAGE_REQUIRED"),
    ({"allow_short_period_approximation":False},"SHORT_PERIOD_APPROXIMATION_REQUIRES_CONFIRMATION"),
    ({"allow_reference_year_mismatch":False},"REFERENCE_YEAR_MISMATCH"),
    ({"comparison_basis":"annual_observed"},"ANNUAL_WINDOW_REQUIRED"),
    ({"household_code":"unknown"},"HOUSEHOLD_COHORT_UNAVAILABLE"),
    ({"reference_period":"2026"},"REFERENCE_PERIOD_UNAVAILABLE"),
    ({"currency":"USD"},"CURRENCY_NOT_COMPARABLE"),
])
def test_material_compatibility_gaps_withhold_computed_figures(changes,expected):
    result=calculate(request(**changes))
    assert result.status=="withheld" and expected in codes(result.rows[0])
    assert result.rows[0].observed_equivalent_minor is None and result.rows[0].difference_minor is None


def test_ambiguity_blocks_affected_groups_without_suppressing_compatible_taxi_context():
    totals=spending(("taxi",10000,0,"everyday"),("groceries",5000,0,"mandatory_regular"))
    result=calculate(request(coicop_codes=["07322","01"]),totals)
    assert result.status=="partial" and result.rows[0].status=="approximate"
    assert result.rows[1].status=="withheld" and "AMBIGUOUS_CATEGORY_COVERAGE" in codes(result.rows[1])
    assert result.mapping.ambiguous.net_minor==5000


@pytest.mark.parametrize("category",["unknown","","transfer"])
def test_unknown_or_inconsistent_consumption_blocks_all_selected_categories(category):
    result=calculate(totals=spending(("taxi",10000,0,"everyday"),(category,10,0,"unresolved")))
    assert result.status=="withheld"
    assert ("INCONSISTENT_CONSUMPTION_CATEGORY" if category=="transfer" else "UNMAPPED_CATEGORY_COVERAGE") in codes(result.rows[0])


def test_unreviewed_taxonomy_and_unresolved_flows_are_not_treated_as_zero():
    assert "UNMAPPED_CATEGORY_COVERAGE" in codes(calculate(taxonomy="organizer.unknown").rows[0])
    totals=spending(("taxi",10000,0,"everyday"));totals.unresolved_flow_count=1
    assert "UNRESOLVED_ECONOMIC_FLOWS" in codes(calculate(totals=totals).rows[0])
    assert "KNOWN_ACCOUNT_SCOPE_INCOMPLETE" in codes(calculate(known_scope=False).rows[0])
    assert "MATERIAL_BANK_SOURCE_INCOMPLETE" in codes(calculate(material_sources=False).rows[0])


def test_truncated_category_input_and_refund_only_periods_are_explicit():
    totals=spending(("taxi",10000,0,"everyday"),truncated=True)
    assert "INCOMPLETE_CATEGORY_BREAKDOWN" in codes(calculate(totals=totals).rows[0])
    result=calculate(totals=spending(("taxi",0,500,"everyday")))
    assert result.mapping.total_observed.net_minor==-500
    assert result.status=="withheld" and "REFUND_DOMINATED_PERIOD" in codes(result.rows[0])


def test_actual_suppressed_cells_preserve_null_not_zero():
    context=bundled_public_context().model_copy(deep=True)
    missing=next(item for item in context.observations if item.source_status)
    result=calculate(request(household_code=missing.household_code,coicop_codes=[missing.coicop_code]),context=context)
    assert result.status=="withheld" and "POPULATION_CELL_UNAVAILABLE" in codes(result.rows[0])
    assert result.rows[0].public_annual_mean_minor is None and result.rows[0].public_equivalent_minor is None


@pytest.mark.parametrize("change",["unit","statistic","snapshot","classification","reference"])
def test_source_incompatibility_prevents_any_population_calculation(change):
    context=bundled_public_context().model_copy(deep=True)
    if change=="unit": context.snapshot.unit="EUR per individual"
    elif change=="statistic": context.snapshot.statistic_type="median"
    elif change=="snapshot": context.snapshot.id="changed"
    elif change=="classification": context.classification_version="different"
    elif change=="reference": context.snapshot.reference_period="2021"
    result=calculate(context=context)
    assert result.status=="unavailable" and result.mapping is None and result.rows==[]


@pytest.mark.parametrize("start,end",[("2026-10-02","2026-11-01"),("2026-10-01","2026-11-02"),("2026-11-01","2026-10-01"),("2026-10-01","2026-10-01"),("2025-01-01","2026-02-01")])
def test_periods_must_contain_one_to_twelve_whole_calendar_months(start,end):
    with pytest.raises(AuthError,match="INVALID_BENCHMARK_PERIOD"): calendar_months(request(start=start,end_exclusive=end))


def test_zero_public_mean_has_no_relative_ratio_and_averaging_is_exact():
    context=bundled_public_context().model_copy(deep=True)
    next(item for item in context.observations if item.coicop_code=="07322" and item.household_code=="1").annual_mean_minor=0
    result=calculate(request(start="2026-08-01"),spending(("taxi",10001,0,"everyday")),context=context)
    row=result.rows[0]
    assert result.observed_calendar_months==3 and row.observed_equivalent_minor==3334
    assert row.relative_difference_basis_points is None and row.relative_difference_unavailable_reason=="baseline_not_positive"
    assert rounded_ratio(-1,2)==-1 and rounded_ratio(1,2)==1


@pytest.mark.parametrize("extra",[{"owner_user_id":"other"},{"scope":{"dataset_coverage":"covered_synthetic_snapshot"}},{"household_coverage_confirmed":"true"}])
def test_client_source_authority_and_coerced_confirmation_are_rejected(extra):
    with pytest.raises(ValidationError): request(**extra)
