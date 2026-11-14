"""Checkpointed, append-only source staging; canonical financial tables are untouched."""
from datetime import datetime,timedelta,timezone
from uuid import uuid4

from psycopg.types.json import Jsonb

from .identity import AuthError,authorized_transaction
from .import_contracts import ImportActionV1,ImportManifestV1
from .import_csv import MAX_MINOR,PARSER_VERSION,ROLES,ROLE_LIMITS
from .import_store import ImportStore
from .import_validation_contracts import (ImportFileProgressV1,ImportRejectedRowV1,ImportRejectionsV1,
    ImportValidationReceiptV1,ImportValidationViewV1)
from .jobs import JobStore
from .planning_store import fingerprint


class ImportValidationStore:
    def __init__(self,connection,user,*,settings,clock=lambda:datetime.now(timezone.utc)):
        self.connection,self.user,self.settings,self.clock=connection,user,settings,clock
        self.imports=ImportStore(connection,user,settings=settings,clock=clock)
        self.owner=self.imports.owner
        self.one,self.rows=self.imports.one,self.imports.rows

    def get(self,identifier,*,required=True):
        row=self.one("""SELECT * FROM moneylens.import_validation_runs WHERE tenant_id=%s AND owner_user_id=%s AND import_id=%s""",
            (*self.owner,identifier))
        if not row and required: raise AuthError("NOT_FOUND",404)
        return row

    def run(self,run_id):
        row=self.one("SELECT * FROM moneylens.import_validation_runs WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,run_id))
        if not row: raise AuthError("NOT_FOUND",404)
        return row

    def status(self,row):
        job=JobStore(self.connection,self.user.scope).status(row["job_id"])
        if job is None: raise ValueError("Validation job is missing")
        state=row["state"]
        if state=="queued":
            if job["state"]=="cancelled": state="cancelled"
            elif job["state"] in ("failed","dead_letter"): state="failed"
        return state,job

    def source(self,identifier):
        batch=self.imports.get(identifier)
        if batch["state"]!="source_ready": raise AuthError("IMPORT_SOURCE_NOT_VERIFIED",409)
        manifest=ImportManifestV1.model_validate(batch["manifest"])
        self.imports.check_files(identifier,manifest)
        files={file["role"]:file for file in self.imports.files(identifier)}
        if any(not file["verified_at"] or not file["etag"] for file in files.values()):
            raise AuthError("IMPORT_SOURCE_NOT_VERIFIED",409)
        return manifest,files

    def read(self,identifier):
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            self.imports.get(identifier);row=self.get(identifier);state,job=self.status(row)
            sizes={item["role"]:item["size_bytes"] for item in self.imports.files(identifier)}
            return ImportValidationViewV1(id=row["id"],import_id=identifier,state=state,parser_version=row["parser_version"],
                generation=row["generation"],sequence=row["sequence"],processed_rows=row["processed_rows"],
                accepted_rows=row["accepted_rows"],rejected_rows=row["rejected_rows"],
                files=[ImportFileProgressV1(role=role,offset_bytes=point["offset"],size_bytes=sizes[role],
                    processed_rows=point["rows"],complete=point["complete"]) for role,point in row["checkpoints"].items()],
                created_at=row["created_at"],updated_at=row["updated_at"],finished_at=row["finished_at"],
                last_error_code=row["last_error_code"] or job["last_error_code"],job=job,limitations=[
                    "Validation seals staged synthetic source claims; financial visibility is managed by the separate publication resource.",
                    "Control totals compare the declared native file snapshot, not organizer provenance or complete real bank history.",
                    "Source categories and relationships still require financial interpretation before recommendations."])

    def rejections(self,identifier,*,after=0,limit=50):
        if type(after) is not int or not 0<=after<=30000000 or type(limit) is not int or not 1<=limit<=100:
            raise AuthError("INVALID_IMPORT_PAGE",422)
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            self.imports.get(identifier);run=self.get(identifier)
            rows=self.rows("""SELECT position,role,ordinal,byte_start,byte_end,raw_sha256,reasons,fields
                FROM moneylens.import_rejected_rows WHERE tenant_id=%s AND owner_user_id=%s AND run_id=%s AND position>%s
                ORDER BY position LIMIT %s""",(*self.owner,run["id"],after,limit+1))
            return ImportRejectionsV1(import_id=identifier,run_id=run["id"],rows=[ImportRejectedRowV1(**row) for row in rows[:limit]],
                next_after=rows[limit-1]["position"] if len(rows)>limit else None)

    def previous(self,key,digest):
        row=self.one("""SELECT request_fingerprint,receipt FROM moneylens.import_validation_commands
            WHERE tenant_id=%s AND owner_user_id=%s AND command_key=%s""",(*self.owner,key))
        if not row: return None
        if row["request_fingerprint"]!=digest: raise AuthError("IDEMPOTENCY_CONFLICT",409)
        return ImportValidationReceiptV1.model_validate(row["receipt"])

    def enqueue(self,run_id,generation,sequence):
        return JobStore(self.connection,self.user.scope).enqueue("import.validate_chunk",
            f"validation:{run_id}:{generation}:{sequence}",{"run_id":str(run_id),"generation":generation,"sequence":sequence},max_attempts=3)

    def record(self,action,key,digest,row,now):
        receipt=ImportValidationReceiptV1(id=uuid4(),action=action,import_id=row["import_id"],run_id=row["id"],
            state=self.status(row)[0],job_id=row["job_id"],applied_at=now)
        self.connection.execute("""INSERT INTO moneylens.import_validation_commands
            (tenant_id,owner_user_id,id,run_id,command_key,request_fingerprint,applied_at,receipt) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (*self.owner,receipt.id,row["id"],key,digest,now,Jsonb(receipt.model_dump(mode="json"))))
        self.imports.audit("import.validation_"+action,row["import_id"],now)
        JobStore(self.connection,self.user.scope).emit("import.validation_"+action,"validation:"+str(receipt.id),
            {"import_id":str(row["import_id"]),"run_id":str(row["id"]),"state":receipt.state,"job_id":str(row["job_id"])})
        return receipt

    def command(self,identifier,body,action):
        if action not in ("start","cancel"): raise ValueError("Use a registered validation command")
        try: body=ImportActionV1.model_validate(body.model_dump(mode="python"),strict=True)
        except (ValueError,AttributeError): raise AuthError("INVALID_IMPORT_COMMAND",422) from None
        if action=="start": self.imports.editable()
        digest=fingerprint({"action":"validation."+action,"import_id":str(identifier)});now=self.clock()
        with authorized_transaction(self.connection,self.user,write=True):
            if action=="start": self.imports.synthetic_member()
            previous=self.previous(body.key,digest)
            if previous: return previous
            count=self.connection.execute("""SELECT count(*) FROM (SELECT 1 FROM moneylens.import_validation_commands
                WHERE tenant_id=%s AND owner_user_id=%s AND applied_at>%s LIMIT 100) recent""",(*self.owner,now-timedelta(hours=1))).fetchone()[0]
            if count>=100: raise AuthError("IMPORT_COMMAND_THROTTLED",429)
            self.imports.get(identifier);row=self.get(identifier,required=False)
            if action=="start":
                manifest,_=self.source(identifier)
                if row is None:
                    run_id=uuid4();job_id=self.enqueue(run_id,1,0)
                    points={role:{"offset":0,"rows":0,"complete":False} for role in ROLES if any(f.role==role for f in manifest.files)}
                    row=self.one("""INSERT INTO moneylens.import_validation_runs
                        (tenant_id,owner_user_id,id,import_id,parser_version,state,job_id,checkpoints,created_at,updated_at)
                        VALUES (%s,%s,%s,%s,%s,'queued',%s,%s,%s,%s) RETURNING *""",
                        (*self.owner,run_id,identifier,PARSER_VERSION,job_id,Jsonb(points),now,now))
                else:
                    state,_=self.status(row)
                    if state in ("cancelled","failed"):
                        if row["generation"]>=MAX_MINOR: raise AuthError("IMPORT_VALIDATION_CLOSED",409)
                        generation=row["generation"]+1;job_id=self.enqueue(row["id"],generation,row["sequence"])
                        self.connection.execute("""UPDATE moneylens.import_validation_runs SET state='queued',generation=%s,
                            job_id=%s,updated_at=%s,finished_at=NULL,last_error_code=NULL WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                            (generation,job_id,now,*self.owner,row["id"]))
                    elif state=="invalid": raise AuthError("IMPORT_VALIDATION_CLOSED",409)
            else:
                if row is None: raise AuthError("NOT_FOUND",404)
                if self.status(row)[0] in ("validated","invalid"): raise AuthError("IMPORT_VALIDATION_CLOSED",409)
                JobStore(self.connection,self.user.scope).cancel(row["job_id"])
                self.connection.execute("""UPDATE moneylens.import_validation_runs SET state='cancelled',updated_at=%s,finished_at=%s
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(now,now,*self.owner,row["id"]))
            return self.record(action,body.key,digest,self.get(identifier),now)

    def prepare(self,run_id,job_id,generation,sequence):
        self.imports.synthetic_member()
        row=self.run(run_id)
        if (row["state"],row["job_id"],row["generation"],row["sequence"])!=("queued",job_id,generation,sequence):
            raise ValueError("Superseded validation checkpoint")
        manifest,files=self.source(row["import_id"])
        points=row["checkpoints"]
        if set(points)!={file.role for file in manifest.files} or row["parser_version"]!=PARSER_VERSION:
            raise ValueError("Unsupported validation checkpoint")
        for role,point in points.items():
            if set(point)!={"offset","rows","complete"} or type(point["offset"]) is not int or not 0<=point["offset"]<=files[role]["size_bytes"] or (
                    type(point["rows"]) is not int or not 0<=point["rows"]<=ROLE_LIMITS[role]) or type(point["complete"]) is not bool:
                raise ValueError("Invalid source checkpoint")
            if point["complete"] and point["offset"]!=files[role]["size_bytes"]: raise ValueError("Incomplete source checkpoint")
        if sum(point["rows"] for point in points.values())!=row["processed_rows"]:
            raise ValueError("Incoherent source row checkpoint")
        role=next((role for role in ROLES if role in points and not points[role]["complete"]),None)
        if role is None: raise ValueError("No remaining source chunk")
        return row,manifest,files,role

    def apply_chunk(self,run_id,job_id,generation,sequence,role,chunk):
        row,manifest,files,expected_role=self.prepare(run_id,job_id,generation,sequence)
        point=row["checkpoints"][role]
        if role!=expected_role or not point["offset"]<=chunk.end_offset<=files[role]["size_bytes"]:
            raise ValueError("Source chunk does not match checkpoint")
        if chunk.complete and chunk.end_offset!=files[role]["size_bytes"]: raise ValueError("Truncated source chunk")
        if not chunk.complete and chunk.end_offset<=point["offset"]: raise ValueError("Source chunk made no progress")
        expected_ordinals=list(range(point["rows"]+1,point["rows"]+len(chunk.rows)+1))
        if [item.ordinal for item in chunk.rows]!=expected_ordinals: raise ValueError("Non-contiguous source chunk")
        self.copy_chunk(row,role,chunk)
        accepted,rejected=self.connection.execute("SELECT count(*) FILTER (WHERE cardinality(reasons)=0),count(*) FILTER (WHERE cardinality(reasons)>0) FROM import_chunk").fetchone()
        points=dict(row["checkpoints"])
        points[role]={"offset":chunk.end_offset,"rows":point["rows"]+len(chunk.rows),"complete":chunk.complete}
        processed=row["processed_rows"]+len(chunk.rows);accepted+=row["accepted_rows"];rejected+=row["rejected_rows"]
        sequence+=1;now=self.clock();state="queued";code=None
        if all(point["complete"] for point in points.values()):
            code=self.reconcile(run_id,rejected)
            state="invalid" if code else "validated"
        next_job=self.enqueue(run_id,generation,sequence) if state=="queued" else job_id
        self.connection.execute("""UPDATE moneylens.import_validation_runs SET checkpoints=%s,processed_rows=%s,
            accepted_rows=%s,rejected_rows=%s,sequence=%s,job_id=%s,state=%s,last_error_code=%s,updated_at=%s,finished_at=%s
            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
            (Jsonb(points),processed,accepted,rejected,sequence,next_job,state,code,now,now if state!="queued" else None,*self.owner,run_id))
        if state!="queued":
            self.imports.audit("import.validation_"+state,row["import_id"],now)
            JobStore(self.connection,self.user.scope).emit("import.validation_"+state,"validation-finished:"+str(run_id),
                {"import_id":str(row["import_id"]),"run_id":str(run_id),"accepted_rows":accepted,"rejected_rows":rejected,"state":state})

    def copy_chunk(self,run,role,chunk):
        # COPY into a transaction-local buffer, then scoped INSERT through forced RLS.
        self.connection.execute("""CREATE TEMP TABLE import_chunk (
            ordinal bigint,position bigint,byte_start bigint,byte_end bigint,raw_sha256 text,source_reference text,
            account_reference text,amount_minor bigint,currency text,booked_on date,observed_at timestamptz,
            payload jsonb,reasons text[],fields text[]) ON COMMIT DROP""")
        with self.connection.cursor().copy("COPY import_chunk FROM STDIN") as copy:
            for index,item in enumerate(chunk.rows,1):
                data=item.payload or {}
                copy.write_row((item.ordinal,run["processed_rows"]+index,item.byte_start,item.byte_end,item.sha256,
                    data.get("account_ref") if role=="accounts" else data.get("source_id"),
                    None if role=="accounts" else data.get("account_ref"),data.get("amount_minor"),data.get("currency"),
                    data.get("booked_on"),data.get("observed_at"),Jsonb(data),item.reasons,item.fields))
        if role!="accounts":
            self.connection.execute("""UPDATE import_chunk t SET reasons=ARRAY['unknown_account_reference'],fields=ARRAY['account_ref']
                WHERE cardinality(t.reasons)=0 AND NOT EXISTS (SELECT 1 FROM moneylens.import_stage_rows a
                    WHERE a.tenant_id=%s AND a.owner_user_id=%s AND a.run_id=%s AND a.role='accounts' AND a.source_reference=t.account_reference)""",
                (*self.owner,run["id"]))
        self.connection.execute("""UPDATE import_chunk t SET reasons=ARRAY['duplicate_source_reference'],fields=ARRAY[%s]::text[]
            WHERE cardinality(t.reasons)=0 AND (EXISTS (SELECT 1 FROM moneylens.import_stage_rows a
                WHERE a.tenant_id=%s AND a.owner_user_id=%s AND a.run_id=%s AND a.role=%s
                    AND a.account_reference IS NOT DISTINCT FROM t.account_reference AND a.source_reference=t.source_reference)
                OR EXISTS (SELECT 1 FROM import_chunk prior WHERE cardinality(prior.reasons)=0 AND prior.ordinal<t.ordinal
                    AND prior.account_reference IS NOT DISTINCT FROM t.account_reference AND prior.source_reference=t.source_reference))""",
            ("account_ref" if role=="accounts" else "source_id",*self.owner,run["id"],role))
        self.connection.execute("""INSERT INTO moneylens.import_stage_rows
            (tenant_id,owner_user_id,run_id,role,ordinal,position,byte_start,byte_end,raw_sha256,source_reference,account_reference,
                amount_minor,currency,booked_on,observed_at,payload)
            SELECT %s,%s,%s,%s,ordinal,position,byte_start,byte_end,raw_sha256,source_reference,account_reference,
                amount_minor,currency,booked_on,observed_at,payload FROM import_chunk WHERE cardinality(reasons)=0""",(*self.owner,run["id"],role))
        self.connection.execute("""INSERT INTO moneylens.import_rejected_rows
            (tenant_id,owner_user_id,run_id,role,ordinal,position,byte_start,byte_end,raw_sha256,reasons,fields)
            SELECT %s,%s,%s,%s,ordinal,position,byte_start,byte_end,raw_sha256,reasons,fields
                FROM import_chunk WHERE cardinality(reasons)>0""",(*self.owner,run["id"],role))

    def reconcile(self,run_id,rejected):
        if rejected: return "import_rejected_rows"
        # Group in SQL; no per-account/per-transaction Python collection grows with the file.
        stats=self.connection.execute("""WITH totals AS (
            SELECT account_reference,count(*) AS rows,sum(amount_minor) AS net FROM moneylens.import_stage_rows
            WHERE tenant_id=%s AND owner_user_id=%s AND run_id=%s AND role='transactions' GROUP BY account_reference)
            SELECT count(*),count(*) FILTER (WHERE coalesce(t.rows,0)<>(a.payload->>'expected_transactions')::bigint
                OR coalesce(t.net,0)<>(a.payload->>'expected_net_minor')::numeric),sum(coalesce(t.net,0))
            FROM moneylens.import_stage_rows a LEFT JOIN totals t ON t.account_reference=a.source_reference
            WHERE a.tenant_id=%s AND a.owner_user_id=%s AND a.run_id=%s AND a.role='accounts'""",
            (*self.owner,run_id,*self.owner,run_id)).fetchone()
        if stats[0]==0: return "import_accounts_missing"
        if stats[1]: return "import_control_totals_mismatch"
        if not -MAX_MINOR<=int(stats[2] or 0)<=MAX_MINOR: return "import_control_total_overflow"
        return None
