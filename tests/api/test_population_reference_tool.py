from datetime import datetime,timezone

import pytest
from pydantic import ValidationError

from app import analysis_tool_population
from app.analysis_tool_population import PopulationReferenceArgumentsV1,population_reference
from app.public_routes import bundled_public_context
from app.statfin import EXPENDITURE_UNIT,SnapshotError

NOW=datetime(2026,11,4,10,tzinfo=timezone.utc)


def test_reference_arguments_cannot_select_a_household_or_confirm_personal_scope():
    assert PopulationReferenceArgumentsV1().model_dump()=={}
    for field,value in {
        "household_code":"1","reference_period":"2022","account_ids":[],
        "household_coverage_confirmed":True,"allow_short_period_approximation":True,
        "allow_reference_year_mismatch":True,"owner_user_id":"other", "as_of":NOW,
        "url":"https://example.invalid","coicop_codes":["01"],
    }.items():
        with pytest.raises(ValidationError):
            PopulationReferenceArgumentsV1.model_validate({field:value})


def test_reference_preserves_verified_values_attribution_statuses_and_limitations():
    source=bundled_public_context()
    result=population_reference(NOW)
    assert result.status=="available" and result.reason is None and result.evaluated_at==NOW
    assert result.household_selection=="not_selected" and result.personal_comparison=="not_performed"
    assert result.context.model_dump()==source.model_dump()
    assert result.context.snapshot.statistic_type=="mean"
    assert result.context.snapshot.unit==EXPENDITURE_UNIT
    assert result.context.snapshot.reference_period=="2022" and result.context.snapshot.attribution
    assert result.context.snapshot.licence_url and result.context.snapshot.response_sha256
    assert len(result.context.cohorts)==7 and len(result.context.observations)==42
    assert any(row.annual_mean_minor is None and row.monthly_equivalent_minor is None for row in result.context.observations)
    assert result.context.limitations==source.limitations
    assert any("No personal transactions" in item for item in result.limitations)


def test_reference_result_cannot_mutate_the_cached_verified_bundle():
    source=bundled_public_context()
    before=source.model_dump()
    result=population_reference(NOW)
    result.context.snapshot.reference_period="forged"
    result.context.observations[0].annual_mean_minor=1
    result.context.cohorts.clear()
    result.context.limitations.clear()
    assert source.model_dump()==before
    assert population_reference(NOW).context.model_dump()==before


@pytest.mark.parametrize("failure",["missing","unavailable","oversized","wrong_statistic","wrong_unit"])
def test_unverified_or_unbounded_reference_is_missing_without_invented_amounts(monkeypatch,failure):
    def unavailable():
        if failure=="missing": raise SnapshotError("INTEGRITY_FAILURE")
        source=bundled_public_context().model_copy(deep=True)
        if failure=="unavailable": source.available=False
        if failure=="oversized": source.observations.extend(source.observations)
        if failure=="wrong_statistic": source.snapshot.statistic_type="median"
        if failure=="wrong_unit": source.snapshot.unit="individual"
        return source
    monkeypatch.setattr(analysis_tool_population,"bundled_public_context",unavailable)
    result=population_reference(NOW)
    assert result.status=="unavailable" and result.context is None
    assert result.reason=="VERIFIED_POPULATION_REFERENCE_UNAVAILABLE"
    assert result.household_selection=="not_selected" and result.personal_comparison=="not_performed"
