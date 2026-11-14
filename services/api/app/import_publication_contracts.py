"""Publication state is separate from historical byte/row validation receipts."""
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime,Field,StrictInt

from .auth_routes import JobStatusView
from .contracts import Contract
from .import_contracts import ImportManifestV1

PublicationState=Literal["queued","published","superseded","failed","cancelled"]


class ImportPublicationReceiptV1(Contract):
    schema_version: Literal["import-publication-command.v1"] = "import-publication-command.v1"
    id: UUID
    import_id: UUID
    publication_id: UUID
    feed_id: UUID
    job_id: UUID
    state: PublicationState
    action: Literal["start","cancel"]
    applied_at: AwareDatetime
    historical_command_snapshot: Literal[True] = True


class ImportPublicationViewV1(Contract):
    schema_version: Literal["import-publication.v1"] = "import-publication.v1"
    id: UUID
    import_id: UUID
    run_id: UUID
    feed_id: UUID
    state: PublicationState
    active: bool
    active_publication_id: UUID | None
    generation: StrictInt = Field(ge=1)
    manifest: ImportManifestV1
    source_manifest_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    account_count: StrictInt = Field(ge=1,le=1000)
    transaction_count: StrictInt = Field(ge=0,le=10000000)
    balance_count: StrictInt = Field(ge=0,le=10000)
    created_at: AwareDatetime
    updated_at: AwareDatetime
    published_at: AwareDatetime | None
    published_data_version: StrictInt | None
    last_error_code: str | None
    job: JobStatusView
    mode: Literal["synthetic"] = "synthetic"
    limitations: list[str]
