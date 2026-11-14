"""Public aggregates only. Personal comparisons require separate authorized domain work."""
from functools import lru_cache

from fastapi import APIRouter
from pydantic import AwareDatetime

from .contracts import BenchmarkSnapshot,Contract,NonnegativeMinor
from .statfin import COICOP,HOUSEHOLD,METRIC,SnapshotError,load_snapshot,money_minor
from .category_crosswalk import PublicCrosswalkContextV1,bundled_crosswalk
from .population_cohorts import PublicCohortCatalogV1,bundled_cohort_catalog

router = APIRouter()


class BenchmarkCohortV1(Contract):
    code: str
    label: str
    sample_households: int | None
    population_households: int | None
    average_household_size: str | None


class PublicObservationV1(Contract):
    coicop_code: str
    label: str
    household_code: str
    annual_mean_minor: NonnegativeMinor | None
    monthly_equivalent_minor: NonnegativeMinor | None
    source_status: str | None


class PublicBenchmarkContextV1(Contract):
    available: bool
    snapshot: BenchmarkSnapshot | None = None
    data_updated_at: AwareDatetime | None = None
    classification_version: str | None = None
    cohorts: list[BenchmarkCohortV1] = []
    observations: list[PublicObservationV1] = []
    reason: str | None = None
    limitations: list[str] = []


@lru_cache(maxsize=1)
def bundled_public_context():
    manifest,documents,cells = load_snapshot()
    document = documents["14ph.response.json"]
    labels = document["dimension"][COICOP]["category"]["label"]
    cohort_labels = document["dimension"][HOUSEHOLD]["category"]["label"]
    backgrounds = {(cell["coordinates"][HOUSEHOLD],cell["coordinates"][METRIC]):
                   None if cell["status"] else cell["value"] for cell in cells["14lv"]}
    cohorts = [BenchmarkCohortV1(code=code,label=label,sample_households=backgrounds.get((code,"oklkm_sum")),
        population_households=backgrounds.get((code,"pklkm_sum")),
        average_household_size=str(backgrounds[(code,"jlkm_mean")]) if backgrounds.get((code,"jlkm_mean")) is not None else None)
        for code,label in cohort_labels.items()]
    observations = []
    for cell in cells["14ph"]:
        value = None if cell["status"] else cell["value"]
        code = cell["coordinates"][COICOP]
        observations.append(PublicObservationV1(coicop_code=code,label=labels[code],household_code=cell["coordinates"][HOUSEHOLD],
            annual_mean_minor=money_minor(value),monthly_equivalent_minor=money_minor(value,12),source_status=cell["status"]))
    snapshot = BenchmarkSnapshot(id=manifest["snapshot_id"],source_url=manifest["tables"]["14ph"]["source_url"],table_id="14ph",
        response_sha256=manifest["files"]["14ph.response.json"],retrieved_at=manifest["retrieved_at"],reference_period="2022",
        unit=manifest["unit"],statistic_type="mean",attribution=manifest["attribution"],licence_url=manifest["licence_url"],mapping_version="unmapped.v1")
    return PublicBenchmarkContextV1(available=True,snapshot=snapshot,data_updated_at=manifest["tables"]["14ph"]["data_updated_at"],
        classification_version="COICOP2018",cohorts=cohorts,observations=observations,limitations=[
            "Public household survey means for reference year 2022 at 2022 current prices; no inflation adjustment.",
            "A monthly equivalent divides the annual mean by 12 and is not an observed calendar-month statistic.",
            "Means provide context, not a median, percentile, spending target or personal recommendation.",
            "Account totals do not establish complete household coverage or comparable statistical categories.",
            "Suppressed/missing cells are unavailable. Parent/subcategory observations overlap and must not be summed.",
            "Household type must be chosen explicitly. Separate marginal tables do not establish intersected cohorts.",
        ])


@router.get("/v1/public/benchmarks/consumption",response_model=PublicBenchmarkContextV1)
def public_benchmarks():
    try:
        return bundled_public_context()
    except (SnapshotError,ValueError):
        return PublicBenchmarkContextV1(available=False,reason="VERIFIED_SNAPSHOT_UNAVAILABLE")


@router.get("/v1/public/benchmarks/category-crosswalk",response_model=PublicCrosswalkContextV1)
def public_category_crosswalk():
    try:
        return PublicCrosswalkContextV1(available=True,policy=bundled_crosswalk().view())
    except (SnapshotError,ValueError):
        return PublicCrosswalkContextV1(available=False,reason="VERIFIED_CROSSWALK_UNAVAILABLE")


@router.get("/v1/public/benchmarks/cohorts",response_model=PublicCohortCatalogV1)
def public_cohorts():
    try:
        return PublicCohortCatalogV1(available=True,catalog=bundled_cohort_catalog().model_copy(deep=True))
    except (SnapshotError,ValueError):
        return PublicCohortCatalogV1(available=False,reason="VERIFIED_COHORTS_UNAVAILABLE")
