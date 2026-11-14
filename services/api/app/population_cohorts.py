"""Explicit household selection from jointly published immutable dimensions."""
from functools import lru_cache
from typing import Annotated,Literal

from pydantic import Field,StrictInt

from .contracts import BenchmarkSnapshot,Contract
from .statfin import HOUSEHOLD,METRIC,SnapshotError,load_snapshot


class CohortSelectionRequestV1(Contract):
    household_code: str = Field(min_length=1,max_length=50)
    reference_period: str = Field(pattern=r"^[0-9]{4}$")


class HouseholdCohortV1(Contract):
    code: str
    label: str
    specificity: Literal["household_type","all_households"]
    sample_households: Annotated[StrictInt,Field(ge=0)] | None
    population_households: Annotated[StrictInt,Field(ge=0)] | None
    average_household_size: str | None


class HouseholdCohortCatalogV1(Contract):
    policy_version: Literal["household-cohorts.v1"] = "household-cohorts.v1"
    snapshot: BenchmarkSnapshot
    reference_period: str
    dimension: Literal["elinvaihe_13_20160101"] = "elinvaihe_13_20160101"
    unit: Literal["household"] = "household"
    metadata_fingerprints: dict[str,str]
    cohorts: list[HouseholdCohortV1] = Field(max_length=7)
    limitations: list[str]


class PublicCohortCatalogV1(Contract):
    available: bool
    catalog: HouseholdCohortCatalogV1 | None = None
    reason: str | None = None


class CohortSelectionV1(Contract):
    status: Literal["selected","unavailable"]
    requested: CohortSelectionRequestV1
    catalog: HouseholdCohortCatalogV1 | None
    cohort: HouseholdCohortV1 | None
    reason: Literal["VERIFIED_COHORTS_UNAVAILABLE","REFERENCE_PERIOD_UNAVAILABLE","HOUSEHOLD_COHORT_UNAVAILABLE"] | None
    fallback_used: Literal[False] = False
    selection_source: Literal["explicit_user_choice"] = "explicit_user_choice"


def catalog_from_snapshot(manifest,documents,cells):
    labels=documents["14ph.response.json"]["dimension"][HOUSEHOLD]["category"]["label"]
    backgrounds=documents["14lv.response.json"]["dimension"][HOUSEHOLD]["category"]["label"]
    if labels!=backgrounds:
        raise SnapshotError("COHORT_DIMENSIONS_INCOMPATIBLE")
    table=manifest["tables"]["14ph"]
    values={(cell["coordinates"][HOUSEHOLD],cell["coordinates"][METRIC]):None if cell["status"] else cell["value"] for cell in cells["14lv"]}
    cohorts=[]
    for code,label in labels.items():
        size=values.get((code,"jlkm_mean"))
        cohorts.append(HouseholdCohortV1(code=code,label=label,specificity="all_households" if code=="SSS" else "household_type",
            sample_households=values.get((code,"oklkm_sum")),population_households=values.get((code,"pklkm_sum")),
            average_household_size=None if size is None else str(size)))
    snapshot=BenchmarkSnapshot(id=manifest["snapshot_id"],source_url=table["source_url"],table_id="14ph",
        response_sha256=manifest["files"]["14ph.response.json"],retrieved_at=manifest["retrieved_at"],reference_period=manifest["reference_period"],
        unit=manifest["unit"],statistic_type=manifest["statistic_type"],attribution=manifest["attribution"],
        licence_url=manifest["licence_url"],mapping_version=manifest["mapping_version"])
    return HouseholdCohortCatalogV1(snapshot=snapshot,reference_period=manifest["reference_period"],cohorts=cohorts,
        metadata_fingerprints={table:entry["schema_fingerprint"] for table,entry in manifest["tables"].items()},limitations=[
            "Select the published household type explicitly. Transactions and account ownership do not establish household composition.",
            "Only the household-type dimension is used. Age, region and income intersections cannot be constructed from separate marginal tables.",
            "Total means all households, not a more specific match. Unavailable choices never fall back to Total automatically.",
            "The reference year and household unit belong to the source. Selecting a cohort does not establish household financial coverage or price/period compatibility.",
            "Suppressed or missing background values remain unavailable. Average household size is descriptive and cannot scale an individual into a household.",
        ])


@lru_cache(maxsize=1)
def bundled_cohort_catalog():
    return catalog_from_snapshot(*load_snapshot())


def select_cohort(body,catalog=None):
    catalog=(catalog if catalog is not None else bundled_cohort_catalog()).model_copy(deep=True)
    reason=None
    cohort=None
    if body.reference_period!=catalog.reference_period:
        reason="REFERENCE_PERIOD_UNAVAILABLE"
    else:
        cohort=next((item for item in catalog.cohorts if item.code==body.household_code),None)
        if cohort is None:
            reason="HOUSEHOLD_COHORT_UNAVAILABLE"
    return CohortSelectionV1(status="selected" if cohort is not None else "unavailable",requested=body.model_copy(deep=True),
        catalog=catalog,cohort=cohort,reason=reason)
