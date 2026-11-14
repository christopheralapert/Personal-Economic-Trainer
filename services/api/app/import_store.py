"""Owned manifest intake; no ledger, balance or financial version is published here."""
from datetime import datetime,timedelta,timezone
from uuid import uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .identity import AuthError,authorized_transaction
from .import_contracts import (ImportActionV1,ImportFileStatusV1,ImportManifestV1,ImportReceiptV1,
    ImportUploadLinksV1,ImportViewV1,StartImportV1)
from .jobs import JobStore
from .planning_store import fingerprint


class ImportStore:
    def __init__(self,connection,user,*,settings,clock=lambda:datetime.now(timezone.utc)):
        self.connection,self.user,self.settings,self.clock=connection,user,settings,clock
        self.owner=(user.scope.tenant_id,user.scope.user_id)

    def one(self,query,params=()):
        with self.connection.cursor(row_factory=dict_row) as cursor: return cursor.execute(query,params).fetchone()

    def rows(self,query,params=()):
        with self.connection.cursor(row_factory=dict_row) as cursor: return cursor.execute(query,params).fetchall()

    def get(self,identifier):
        row=self.one("""SELECT * FROM moneylens.import_batches WHERE tenant_id=%s AND owner_user_id=%s
            AND id=%s AND manifest IS NOT NULL""",(*self.owner,identifier))
        if not row: raise AuthError("NOT_FOUND",404)
        return row

    def files(self,identifier):
        return self.rows("""SELECT role,size_bytes,sha256,verified_at,etag FROM moneylens.import_files
            WHERE tenant_id=%s AND owner_user_id=%s AND import_id=%s ORDER BY role""",(*self.owner,identifier))

    def status(self,row):
        job=JobStore(self.connection,self.user.scope).status(row["verification_job_id"]) if row["verification_job_id"] else None
        state=row["state"]
        if state=="queued" and job:
            if job["state"]=="cancelled": state="cancelled"
            elif job["state"] in ("dead_letter","failed"): state="failed"
        return state,job

    def read(self,identifier):
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            row=self.get(identifier);state,job=self.status(row)
            if state=="published": raise AuthError("IMPORT_INTAKE_MOVED",409)
            return ImportViewV1(id=row["id"],state=state,manifest=ImportManifestV1.model_validate(row["manifest"]),
                files=[ImportFileStatusV1(**{name:item[name] for name in ImportFileStatusV1.model_fields}) for item in self.files(identifier)],
                created_at=row["created_at"],updated_at=row["updated_at"],upload_expires_at=row["upload_expires_at"],job=job,
                source_integrity_verified=state=="source_ready",as_of=self.clock(),limitations=[
                    "Claimed coverage, currency and customer reference are unverified manifest declarations, not source authority.",
                    "Source-ready means file byte lengths and SHA-256 hashes passed; row validation and financial publication are separate.",
                    "No organizer endorsement, rights clearance, bank transfer, balance update or financial permission is established."])

    def editable(self):
        if not self.user.synthetic: raise AuthError("IMPORT_SYNTHETIC_REQUIRED",409)
        if not self.settings.imports_enabled: raise AuthError("IMPORT_UNAVAILABLE",503)

    def synthetic_member(self):
        # Eligibility can change after the session principal was resolved.
        current=self.connection.execute("SELECT is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",self.owner).fetchone()
        if current!=(True,): raise AuthError("IMPORT_SYNTHETIC_REQUIRED",409)

    def previous(self,key,digest):
        row=self.one("""SELECT request_fingerprint,receipt FROM moneylens.import_commands
            WHERE tenant_id=%s AND owner_user_id=%s AND command_key=%s""",(*self.owner,key))
        if not row: return None
        if row["request_fingerprint"]!=digest: raise AuthError("IDEMPOTENCY_CONFLICT",409)
        return ImportReceiptV1.model_validate(row["receipt"])

    def budget(self,now):
        count=self.connection.execute("""SELECT count(*) FROM (SELECT 1 FROM moneylens.import_commands
            WHERE tenant_id=%s AND owner_user_id=%s AND applied_at>%s LIMIT 100) recent""",(*self.owner,now-timedelta(hours=1))).fetchone()[0]
        if count>=100: raise AuthError("IMPORT_COMMAND_THROTTLED",429)

    def record(self,action,key,digest,row,now):
        receipt=ImportReceiptV1(id=uuid4(),action=action,import_id=row["id"],state=self.status(row)[0],
            job_id=row["verification_job_id"],applied_at=now)
        self.connection.execute("""INSERT INTO moneylens.import_commands
            (tenant_id,owner_user_id,id,import_id,command_key,request_fingerprint,applied_at,receipt)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",(*self.owner,receipt.id,row["id"],key,digest,now,Jsonb(receipt.model_dump(mode="json"))))
        self.audit("import."+action,row["id"],now)
        JobStore(self.connection,self.user.scope).emit("import."+action,"import."+str(receipt.id),
            {"import_id":str(row["id"]),"state":receipt.state,"job_id":str(receipt.job_id) if receipt.job_id else None})
        return receipt

    def audit(self,action,identifier,now):
        self.connection.execute("""INSERT INTO moneylens.audit_events
            (tenant_id,owner_user_id,id,action,resource_id,trace_id,created_at,metadata)
            VALUES (%s,%s,%s,%s,%s,%s,%s,'{}')""",(*self.owner,uuid4(),action,identifier,uuid4(),now))

    def start(self,body):
        try: body=StartImportV1.model_validate(body.model_dump(mode="python"),strict=True)
        except (ValueError,AttributeError): raise AuthError("INVALID_IMPORT_COMMAND",422) from None
        self.editable();now=self.clock()
        manifest=body.manifest.model_dump(mode="json");source_digest=fingerprint(manifest)
        digest=fingerprint({"action":"start","manifest":manifest})
        total=sum(file.size_bytes for file in body.manifest.files)
        with authorized_transaction(self.connection,self.user,write=True):
            self.synthetic_member()
            previous=self.previous(body.key,digest)
            if previous: return previous
            if total>self.settings.import_maximum_bytes: raise AuthError("IMPORT_TOO_LARGE",413)
            self.budget(now)
            row=self.one("""SELECT * FROM moneylens.import_batches WHERE tenant_id=%s AND owner_user_id=%s
                AND source_sha256=%s AND mapping_version=%s""",(*self.owner,source_digest,body.manifest.mapping_version))
            if row is None:
                counts=self.connection.execute("""SELECT count(*),count(*) FILTER (WHERE created_at>%s),
                    coalesce(sum((SELECT coalesce(sum(f.size_bytes),0) FROM moneylens.import_files f
                        WHERE f.tenant_id=b.tenant_id AND f.owner_user_id=b.owner_user_id AND f.import_id=b.id))
                        FILTER (WHERE created_at>%s),0)
                    FROM moneylens.import_batches b WHERE tenant_id=%s AND owner_user_id=%s AND manifest IS NOT NULL""",
                    (now-timedelta(hours=1),now-timedelta(days=1),*self.owner)).fetchone()
                if counts[0]>=1000 or counts[1]>=10 or counts[2]+total>self.settings.import_daily_bytes:
                    raise AuthError("IMPORT_INTAKE_THROTTLED",429)
                identifier=uuid4()
                row=self.one("""INSERT INTO moneylens.import_batches
                    (tenant_id,owner_user_id,id,object_key,source_sha256,mapping_version,source_version,state,manifest,
                        created_at,updated_at,upload_expires_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,'awaiting_uploads',%s,%s,%s,%s) RETURNING *""",
                    (*self.owner,identifier,f"raw/{self.owner[0]}/{self.owner[1]}/{identifier}/",source_digest,
                        body.manifest.mapping_version,body.manifest.source_version,Jsonb(manifest),now,now,now+timedelta(days=1)))
                for file in body.manifest.files:
                    self.connection.execute("""INSERT INTO moneylens.import_files
                        (tenant_id,owner_user_id,id,import_id,role,size_bytes,sha256) VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                        (*self.owner,uuid4(),identifier,file.role,file.size_bytes,file.sha256))
            elif row["state"]=="published": raise AuthError("IMPORT_INTAKE_MOVED",409)
            return self.record("start",body.key,digest,row,now)

    def upload_links(self,identifier,objects):
        self.editable();now=self.clock()
        with authorized_transaction(self.connection,self.user,write=True):
            self.synthetic_member()
            row=self.get(identifier);state,_=self.status(row)
            if state not in ("awaiting_uploads","failed") or row["upload_expires_at"]<=now:
                raise AuthError("IMPORT_UPLOAD_CLOSED",409)
            count=self.connection.execute("""SELECT count(*) FROM (SELECT 1 FROM moneylens.audit_events
                WHERE tenant_id=%s AND owner_user_id=%s AND action='import.upload_links' AND created_at>%s LIMIT 30) recent""",
                (*self.owner,now-timedelta(hours=1))).fetchone()[0]
            if count>=30: raise AuthError("IMPORT_COMMAND_THROTTLED",429)
            seconds=min(self.settings.import_upload_link_seconds,int((row["upload_expires_at"]-now).total_seconds()))
            if seconds<1: raise AuthError("IMPORT_UPLOAD_CLOSED",409)
            manifest=ImportManifestV1.model_validate(row["manifest"])
            links=[objects.upload_link(self.user.scope,identifier,file,seconds) for file in manifest.files]
            self.audit("import.upload_links",identifier,now)
            return ImportUploadLinksV1(import_id=identifier,expires_at=now+timedelta(seconds=seconds),files=links)

    def action(self,identifier,body,action):
        if action not in ("submit","cancel"): raise ValueError("Use a registered import command")
        try: body=ImportActionV1.model_validate(body.model_dump(mode="python"),strict=True)
        except (ValueError,AttributeError): raise AuthError("INVALID_IMPORT_COMMAND",422) from None
        if action=="submit": self.editable()
        digest=fingerprint({"action":action,"import_id":str(identifier)});now=self.clock()
        with authorized_transaction(self.connection,self.user,write=True):
            if action=="submit": self.synthetic_member()
            previous=self.previous(body.key,digest)
            if previous: return previous
            self.budget(now);row=self.get(identifier);state,job=self.status(row)
            if action=="submit":
                if state not in ("awaiting_uploads","failed") or row["upload_expires_at"]<=now:
                    raise AuthError("IMPORT_UPLOAD_CLOSED",409)
                job_id=JobStore(self.connection,self.user.scope).enqueue("import.verify_source","import:"+body.key,
                    {"import_id":str(identifier)},max_attempts=3)
                self.connection.execute("""UPDATE moneylens.import_batches SET state='queued',verification_job_id=%s,updated_at=%s
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(job_id,now,*self.owner,identifier))
            else:
                if state in ("source_ready","published"): raise AuthError("IMPORT_ALREADY_VERIFIED",409)
                if job: JobStore(self.connection,self.user.scope).cancel(job["id"])
                self.connection.execute("""UPDATE moneylens.import_batches SET state='cancelled',updated_at=%s
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(now,*self.owner,identifier))
            return self.record(action,body.key,digest,self.get(identifier),now)

    def finish_source(self,identifier,job_id,verified):
        row=self.get(identifier)
        if row["state"]!="queued" or row["verification_job_id"]!=job_id:
            raise AuthError("IMPORT_STATE_CHANGED",409)
        manifest=ImportManifestV1.model_validate(row["manifest"])
        if sorted((item.role,item.size_bytes,item.sha256) for item in verified)!=sorted((file.role,file.size_bytes,file.sha256) for file in manifest.files):
            raise ValueError("Source verification does not match the immutable manifest")
        self.check_files(identifier,manifest)
        now=self.clock()
        for item in verified:
            self.connection.execute("""UPDATE moneylens.import_files SET verified_at=%s,etag=%s
                WHERE tenant_id=%s AND owner_user_id=%s AND import_id=%s AND role=%s""",(now,item.etag,*self.owner,identifier,item.role))
        self.connection.execute("""UPDATE moneylens.import_batches SET state='source_ready',updated_at=%s
            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(now,*self.owner,identifier))
        self.audit("import.source_ready",identifier,now)
        JobStore(self.connection,self.user.scope).emit("import.source_ready","source-ready:"+str(job_id),{"import_id":str(identifier)})

    def check_files(self,identifier,manifest):
        actual=sorted((item['role'],item['size_bytes'],item['sha256']) for item in self.files(identifier))
        expected=sorted((file.role,file.size_bytes,file.sha256) for file in manifest.files)
        if actual!=expected: raise ValueError("Stored file metadata differs from the immutable manifest")
