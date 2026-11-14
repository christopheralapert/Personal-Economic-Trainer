from copy import deepcopy

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from app.main import create_app
from app.population_cohorts import CohortSelectionRequestV1,bundled_cohort_catalog,catalog_from_snapshot,select_cohort
from app.settings import Settings
from app.statfin import HOUSEHOLD,SnapshotError,load_snapshot
from app import public_routes


@pytest.mark.parametrize("code",["1","2","3","4","5","6","SSS"])
def test_only_explicit_published_household_types_are_selected(code):
    request=CohortSelectionRequestV1(household_code=code,reference_period="2022")
    result=select_cohort(request)
    assert result.status=="selected" and result.cohort.code==code and result.reason is None
    assert not result.fallback_used and result.selection_source=="explicit_user_choice"
    assert result.cohort.specificity==("all_households" if code=="SSS" else "household_type")
    assert result.catalog.snapshot.reference_period=="2022" and result.catalog.unit=="household"
    assert set(result.catalog.metadata_fingerprints)=={"14ph","14lv"}


@pytest.mark.parametrize("body,reason",[
    ({"household_code":"unknown","reference_period":"2022"},"HOUSEHOLD_COHORT_UNAVAILABLE"),
    ({"household_code":"1","reference_period":"2026"},"REFERENCE_PERIOD_UNAVAILABLE"),
])
def test_unavailable_selection_does_not_infer_or_fall_back_to_total(body,reason):
    result=select_cohort(CohortSelectionRequestV1(**body))
    assert result.status=="unavailable" and result.cohort is None and result.reason==reason and not result.fallback_used


@pytest.mark.parametrize("body",[
    {"reference_period":"2022"},{"household_code":"1"},
    {"household_code":"1","reference_period":"2022","income_band":"high"},
    {"household_code":"1","reference_period":"2022","region":"Helsinki"},
    {"household_code":["1","2"],"reference_period":"2022"},
])
def test_missing_choices_and_fabricated_intersections_are_rejected(body):
    with pytest.raises(ValidationError): CohortSelectionRequestV1(**body)


def test_background_and_consumption_dimensions_must_match():
    manifest,documents,cells=load_snapshot()
    documents=deepcopy(documents)
    documents["14lv.response.json"]["dimension"][HOUSEHOLD]["category"]["label"]["1"]="Different household concept"
    with pytest.raises(SnapshotError,match="COHORT_DIMENSIONS_INCOMPATIBLE"):
        catalog_from_snapshot(manifest,documents,cells)


def test_suppressed_background_stays_null_and_not_an_individual_scaling_factor():
    manifest,documents,cells=load_snapshot()
    cells=deepcopy(cells)
    for cell in cells["14lv"]:
        if cell["coordinates"][HOUSEHOLD]=="1": cell["status"]="..."
    result=select_cohort(CohortSelectionRequestV1(household_code="1",reference_period="2022"),catalog_from_snapshot(manifest,documents,cells))
    assert result.status=="selected" and result.cohort.sample_households is None and result.cohort.average_household_size is None


def test_returned_choices_cannot_change_the_cached_catalog():
    body=CohortSelectionRequestV1(household_code="1",reference_period="2022")
    result=select_cohort(body)
    result.cohort.label="Changed";result.catalog.cohorts.clear();result.requested.household_code="SSS"
    assert select_cohort(body).cohort.label!="Changed" and body.household_code=="1"
    assert len(bundled_cohort_catalog().cohorts)==7


def test_public_catalog_and_source_failure_do_not_expose_personal_values(monkeypatch):
    with TestClient(create_app(Settings(environment="test"))) as client:
        response=client.get("/v1/public/benchmarks/cohorts")
        assert response.status_code==200 and "no-store" in response.headers["cache-control"]
        result=response.json()
        assert result["available"] and len(result["catalog"]["cohorts"])==7
        assert "account_ids" not in result["catalog"] and "household_code" not in result["catalog"]
        def broken(): raise SnapshotError("Integrity failure")
        monkeypatch.setattr(public_routes,"bundled_cohort_catalog",broken)
        assert client.get("/v1/public/benchmarks/cohorts").json()=={"available":False,"catalog":None,"reason":"VERIFIED_COHORTS_UNAVAILABLE"}
