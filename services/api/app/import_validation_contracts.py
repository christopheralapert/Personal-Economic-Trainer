"""Validation progress is independent of byte-integrity and financial publication."""
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime,Field,StrictInt

from .auth_routes import JobStatusView
from .contracts import Contract
from .import_contracts import FileRole

ValidationState=Literal["queued","validated","invalid","failed","cancelled"]


class ImportValidationReceiptV1(Contract):
    schema_version: Literal["import-validation-command.v1"] = "import-validation-command.v1"
    id: UUID
    import_id: UUID
    run_id: UUID
    action: Literal["start","cancel"]
    state: ValidationState
    job_id: UUID
    applied_at: AwareDatetime
    historical_command_snapshot: Literal[True] = True


class ImportFileProgressV1(Contract):
    role: FileRole
    offset_bytes: StrictInt = Field(ge=0)
    size_bytes: StrictInt = Field(ge=1)
    processed_rows: StrictInt = Field(ge=0)
    complete: bool


class ImportValidationViewV1(Contract):
    schema_version: Literal["import-validation.v1"] = "import-validation.v1"
    id: UUID
    import_id: UUID
    state: ValidationState
    parser_version: Literal["moneylens.csv-parser.v1"]
    generation: StrictInt = Field(ge=1)
    sequence: StrictInt = Field(ge=0)
    processed_rows: StrictInt = Field(ge=0)
    accepted_rows: StrictInt = Field(ge=0)
    rejected_rows: StrictInt = Field(ge=0)
    files: list[ImportFileProgressV1] = Field(min_length=2,max_length=3)
    created_at: AwareDatetime
    updated_at: AwareDatetime
    finished_at: AwareDatetime | None
    last_error_code: str | None
    job: JobStatusView
    publication: Literal["separate_workflow"] = "separate_workflow"
    mode: Literal["synthetic"] = "synthetic"
    limitations: list[str]


class ImportRejectedRowV1(Contract):
    position: StrictInt = Field(ge=1)
    role: FileRole
    ordinal: StrictInt = Field(ge=1)
    byte_start: StrictInt = Field(ge=0)
    byte_end: StrictInt = Field(ge=1)
    raw_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    reasons: list[str] = Field(min_length=1,max_length=5)
    fields: list[str] = Field(max_length=8)


class ImportRejectionsV1(Contract):
    import_id: UUID
    run_id: UUID
    rows: list[ImportRejectedRowV1] = Field(max_length=100)
    next_after: StrictInt | None
    traversal: Literal["live-owned-position"] = "live-owned-position"
    notice: str = "New rejects may appear while validation runs; restart at zero after completion. Raw row values remain in private source objects."
