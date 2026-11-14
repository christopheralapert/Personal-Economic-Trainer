"""Small import commands; uploaded bytes and source claims are not financial authority."""
from datetime import date
from typing import Annotated,Literal
from uuid import UUID
from zoneinfo import ZoneInfo,ZoneInfoNotFoundError

from pydantic import AwareDatetime,Field,StrictInt,field_validator,model_validator

from .contracts import Contract,Currency
from .auth_routes import JobStatusView

ImportKey=Annotated[str,Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")]
SourceReference=Annotated[str,Field(pattern=r"^[A-Za-z0-9._:-]{1,100}$")]
FileRole=Literal["accounts","transactions","balances"]
ImportState=Literal["awaiting_uploads","queued","source_ready","failed","cancelled"]
MAX_OBJECT_BYTES=5*1024**3


class ImportFileV1(Contract):
    role: FileRole
    size_bytes: Annotated[StrictInt,Field(ge=1,le=MAX_OBJECT_BYTES)]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class ImportManifestV1(Contract):
    mapping_version: Literal["moneylens.synthetic-csv.v1"]
    source_version: SourceReference
    source_customer_ref: SourceReference
    currency: Currency
    timezone: str = Field(min_length=1,max_length=100)
    claimed_from: date
    claimed_to_exclusive: date
    files: list[ImportFileV1] = Field(min_length=2,max_length=3)

    @field_validator("timezone")
    @classmethod
    def known_timezone(cls,value):
        try: ZoneInfo(value)
        except (ZoneInfoNotFoundError,ValueError): raise ValueError("Use an available IANA timezone") from None
        return value

    @model_validator(mode="after")
    def explicit_files_and_window(self):
        roles=[item.role for item in self.files]
        if len(set(roles))!=len(roles) or not {"accounts","transactions"}<=set(roles):
            raise ValueError("Include distinct accounts and transactions files, with optional balances")
        if not 1<=(self.claimed_to_exclusive-self.claimed_from).days<=3660:
            raise ValueError("Declare one to 3660 booking days without truncation")
        # Canonical order makes identical manifests independent of form ordering.
        self.files.sort(key=lambda item:item.role)
        return self


class StartImportV1(Contract):
    key: ImportKey
    manifest: ImportManifestV1


class ImportActionV1(Contract):
    key: ImportKey


class ImportUploadRequestV1(Contract):
    pass


class ImportFileStatusV1(ImportFileV1):
    verified_at: AwareDatetime | None


class ImportViewV1(Contract):
    id: UUID
    state: ImportState
    manifest: ImportManifestV1
    files: list[ImportFileStatusV1] = Field(max_length=3)
    created_at: AwareDatetime
    updated_at: AwareDatetime
    upload_expires_at: AwareDatetime
    job: JobStatusView | None
    source_integrity_verified: bool
    published: Literal[False] = False
    mode: Literal["synthetic"] = "synthetic"
    as_of: AwareDatetime
    limitations: list[str]


class ImportReceiptV1(Contract):
    schema_version: Literal["import-command.v1"] = "import-command.v1"
    id: UUID
    action: Literal["start","submit","cancel"]
    import_id: UUID
    job_id: UUID | None
    state: ImportState
    applied_at: AwareDatetime
    historical_command_snapshot: Literal[True] = True


class UploadLinkV1(Contract):
    role: FileRole
    method: Literal["PUT"] = "PUT"
    url: str
    headers: dict[str,str]
    size_bytes: Annotated[StrictInt,Field(ge=1,le=MAX_OBJECT_BYTES)]


class ImportUploadLinksV1(Contract):
    import_id: UUID
    expires_at: AwareDatetime
    files: list[UploadLinkV1] = Field(min_length=2,max_length=3)
    notice: str = "Private, short-lived write-only capabilities. Keep URLs in memory; do not log, share or cache them."
