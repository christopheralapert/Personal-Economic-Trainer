"""Verified public survey context without household inference or personal comparison."""
from typing import Literal

from pydantic import AwareDatetime,Field,model_validator

from .contracts import BenchmarkSnapshot,Contract
from .public_routes import (BenchmarkCohortV1,PublicBenchmarkContextV1,
    PublicObservationV1,bundled_public_context)
from .statfin import EXPENDITURE_UNIT,SnapshotError


class PopulationReferenceArgumentsV1(Contract):
    pass


class PopulationReferenceContextV1(PublicBenchmarkContextV1):
    available: Literal[True] = True
    snapshot: BenchmarkSnapshot
    data_updated_at: AwareDatetime
    classification_version: Literal["COICOP2018"]
    cohorts: list[BenchmarkCohortV1] = Field(min_length=1,max_length=7)
    observations: list[PublicObservationV1] = Field(min_length=1,max_length=42)
    reason: Literal[None] = None
    limitations: list[str] = Field(min_length=1,max_length=20)

    @model_validator(mode="after")
    def compatible_reference(self):
        if self.snapshot.statistic_type!="mean" or self.snapshot.unit!=EXPENDITURE_UNIT:
            raise ValueError("Unsupported population statistic or unit")
        return self


class PopulationReferenceV1(Contract):
    evaluated_at: AwareDatetime
    status: Literal["available","unavailable"]
    context: PopulationReferenceContextV1 | None
    household_selection: Literal["not_selected"] = "not_selected"
    personal_comparison: Literal["not_performed"] = "not_performed"
    reason: Literal["VERIFIED_POPULATION_REFERENCE_UNAVAILABLE"] | None
    limitations: list[str] = Field(min_length=1,max_length=10)

    @model_validator(mode="after")
    def consistent_availability(self):
        if (self.status=="available")!=(self.context is not None) or (self.status=="unavailable")!=(self.reason is not None):
            raise ValueError("Population reference availability must match its context and reason")
        return self


def population_reference(instant):
    try:
        # Validate and copy the cached public bundle. No personal inputs, source
        # refresh, provider request or user-selected household enters this read.
        context=PopulationReferenceContextV1.model_validate(bundled_public_context().model_dump(mode="python"))
    except (SnapshotError,ValueError):
        context=None
    return PopulationReferenceV1(evaluated_at=instant,status="available" if context is not None else "unavailable",
        context=context,reason=None if context is not None else "VERIFIED_POPULATION_REFERENCE_UNAVAILABLE",limitations=[
            "Public reference context only. No household type was selected or inferred for this user.",
            "All published household types are returned as reference data, not as a matched personal cohort.",
            "No personal transactions, household coverage, comparison, spending allowance or saving capacity were assessed.",
            "Missing or suppressed public observations remain unavailable; they do not become zero spending.",
            "No network request, bank refresh, confirmation or financial record change is made."])
