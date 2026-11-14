"""Small owned discovery resources for a recoverable import interface."""
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime,Field,StrictInt

from .auth_routes import AccountView
from .contracts import Contract,Currency
from .identity import AuthError,authorized_transaction
from .import_contracts import ImportState
from .import_store import ImportStore
from .import_validation_contracts import ValidationState
from .import_publication_contracts import PublicationState
from .ledger import Ledger
from .scoped_keys import CursorCodec


class ImportCapabilitiesV1(Contract):
    enabled: bool
    synthetic_only: Literal[True] = True
    mapping_version: Literal["moneylens.synthetic-csv.v1"] = "moneylens.synthetic-csv.v1"
    maximum_manifest_bytes: Literal[8192] = 8192
    maximum_source_bytes: StrictInt
    notice: str


class ImportSummaryV1(Contract):
    id: UUID
    source_version: str
    currency: Currency
    created_at: AwareDatetime
    total_bytes: StrictInt = Field(ge=1)
    intake_state: ImportState | Literal["published"]
    validation_state: ValidationState | None
    publication_state: PublicationState | None
    active: bool


class ImportListV1(Contract):
    rows: list[ImportSummaryV1] = Field(max_length=50)
    next_before_id: UUID | None
    traversal: Literal["live-owned-created-order"] = "live-owned-created-order"


class NativeAccountListV1(Contract):
    publication_id: UUID
    active: bool
    accounts: list[AccountView] = Field(max_length=1000)


def job_state(state,job):
    if state=="queued" and job=="cancelled": return "cancelled"
    if state=="queued" and job in ("dead_letter","failed"): return "failed"
    return state


class ImportCatalog:
    def __init__(self,connection,user,*,settings):
        self.connection,self.user,self.settings=connection,user,settings
        self.imports=ImportStore(connection,user,settings=settings)
        self.owner=self.imports.owner

    def capabilities(self):
        with authorized_transaction(self.connection,self.user):
            member=self.connection.execute("SELECT is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",self.owner).fetchone()
            enabled=bool(self.settings.imports_enabled and member and member[0])
            return ImportCapabilitiesV1(enabled=enabled,maximum_source_bytes=self.settings.import_maximum_bytes,
                notice="Compatible synthetic file imports are configured for this profile." if enabled else
                    "File import is unavailable here. Existing imports can still be reviewed.")

    def list(self,*,before_id=None,limit=20):
        if type(limit) is not int or not 1<=limit<=50: raise AuthError("INVALID_IMPORT_PAGE",422)
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            condition="";params=list(self.owner)
            if before_id:
                anchor=self.imports.get(before_id)
                condition=" AND (b.created_at,b.id)<(%s,%s)";params.extend((anchor["created_at"],anchor["id"]))
            rows=self.imports.rows("""SELECT b.id,b.source_version,b.manifest->>'currency' AS currency,b.created_at,b.state AS intake_state,
                (SELECT sum((item->>'size_bytes')::bigint) FROM jsonb_array_elements(b.manifest->'files') AS item) AS total_bytes,
                source_job.state AS intake_job_state,v.state AS validation_state,vj.state AS validation_job_state,
                p.state AS publication_state,pj.state AS publication_job_state,coalesce(f.active_publication_id=p.id,false) AS active
                FROM moneylens.import_batches b LEFT JOIN moneylens.jobs source_job
                    ON (source_job.tenant_id,source_job.owner_user_id,source_job.id)=(b.tenant_id,b.owner_user_id,b.verification_job_id)
                LEFT JOIN moneylens.import_validation_runs v
                    ON (v.tenant_id,v.owner_user_id,v.import_id)=(b.tenant_id,b.owner_user_id,b.id)
                LEFT JOIN moneylens.jobs vj ON (vj.tenant_id,vj.owner_user_id,vj.id)=(v.tenant_id,v.owner_user_id,v.job_id)
                LEFT JOIN moneylens.import_publications p
                    ON (p.tenant_id,p.owner_user_id,p.import_id)=(b.tenant_id,b.owner_user_id,b.id)
                LEFT JOIN moneylens.jobs pj ON (pj.tenant_id,pj.owner_user_id,pj.id)=(p.tenant_id,p.owner_user_id,p.job_id)
                LEFT JOIN moneylens.native_feeds f ON (f.tenant_id,f.owner_user_id,f.id)=(p.tenant_id,p.owner_user_id,p.feed_id)
                WHERE b.tenant_id=%s AND b.owner_user_id=%s AND b.manifest IS NOT NULL"""+condition+
                " ORDER BY b.created_at DESC,b.id DESC LIMIT %s",(*params,limit+1))
            visible=[]
            for row in rows[:limit]:
                publication=job_state(row["publication_state"],row["publication_job_state"])
                if publication=="published" and not row["active"]: publication="superseded"
                visible.append(ImportSummaryV1(**{name:row[name] for name in ("id","source_version","currency","created_at","active")},total_bytes=int(row["total_bytes"]),
                    intake_state=job_state(row["intake_state"],row["intake_job_state"]),
                    validation_state=job_state(row["validation_state"],row["validation_job_state"]),publication_state=publication))
            return ImportListV1(rows=visible,next_before_id=visible[-1].id if len(rows)>limit else None)

    def accounts(self,identifier):
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            self.imports.get(identifier)
            publication=self.imports.one("""SELECT p.id,p.feed_id,coalesce(p.id=f.active_publication_id,false) AS active
                FROM moneylens.import_publications p JOIN moneylens.native_feeds f
                    ON (f.tenant_id,f.owner_user_id,f.id)=(p.tenant_id,p.owner_user_id,p.feed_id)
                WHERE p.tenant_id=%s AND p.owner_user_id=%s AND p.import_id=%s AND p.state='published'""",(*self.owner,identifier))
            if not publication: raise AuthError("NOT_FOUND",404)
            if not publication["active"]: raise AuthError("IMPORT_SOURCE_VERSION_CHANGED",409)
            rows=self.imports.rows("""SELECT id,name,currency,account_type,included FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s
                AND native_feed_id=%s ORDER BY native_reference,id LIMIT 1001""",(*self.owner,publication["feed_id"]))
            if len(rows)>1000: raise AuthError("NARROW_ACCOUNT_SCOPE",409)
            return NativeAccountListV1(publication_id=publication["id"],active=publication["active"],accounts=[AccountView(**row) for row in rows])

    def transactions(self,identifier,filters,*,cursor=None,limit=50):
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            self.imports.get(identifier)
            publication=self.imports.one("""SELECT p.id,p.feed_id,f.active_publication_id FROM moneylens.import_publications p
                JOIN moneylens.native_feeds f ON (f.tenant_id,f.owner_user_id,f.id)=(p.tenant_id,p.owner_user_id,p.feed_id)
                WHERE p.tenant_id=%s AND p.owner_user_id=%s AND p.import_id=%s AND p.state='published'""",(*self.owner,identifier))
            if not publication: raise AuthError("NOT_FOUND",404)
            if publication["active_publication_id"]!=publication["id"]: raise AuthError("IMPORT_SOURCE_VERSION_CHANGED",409)
            chosen=filters.account_ids
            if chosen is None:
                rows=self.connection.execute("""SELECT id FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s
                    AND native_feed_id=%s ORDER BY id LIMIT 201""",(*self.owner,publication["feed_id"])).fetchall()
                if len(rows)>200: raise AuthError("NARROW_ACCOUNT_SCOPE",422)
                chosen=[row[0] for row in rows]
            else:
                count=self.connection.execute("""SELECT count(*) FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s
                    AND native_feed_id=%s AND id=ANY(%s)""",(*self.owner,publication["feed_id"],chosen)).fetchone()[0]
                if count!=len(chosen): raise AuthError("NOT_FOUND",404)
            filters=filters.model_copy(update={"account_ids":chosen})
            ledger=Ledger(self.connection,self.user,filters,maximum_age_hours=self.settings.balance_maximum_age_hours)
            return ledger.page(CursorCodec(self.settings.session_secret.get_secret_value()),cursor=cursor,limit=limit)
