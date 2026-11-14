"""Prepare immutable snapshot checks, then atomically switch a small owned pointer."""
from dataclasses import dataclass
from datetime import datetime,timedelta,timezone
from uuid import uuid4

from psycopg.types.json import Jsonb

from .identity import AuthError,authorized_transaction
from .import_contracts import ImportActionV1,ImportManifestV1
from .import_csv import MAX_MINOR
from .import_publication_contracts import ImportPublicationReceiptV1,ImportPublicationViewV1
from .import_store import ImportStore
from .jobs import JobStore
from .native_ids import feed_identity,native_id
from .planning_store import fingerprint


class PublicationError(ValueError):
    def __init__(self,code):
        self.code=code
        super().__init__(code)


@dataclass(frozen=True)
class PreparedPublication:
    publication_id: object
    job_id: object
    generation: int
    run_id: object
    expected_previous_id: object
    accounts: tuple


class ImportPublicationStore:
    def __init__(self,connection,user,*,settings,clock=lambda:datetime.now(timezone.utc)):
        self.connection,self.user,self.settings,self.clock=connection,user,settings,clock
        self.imports=ImportStore(connection,user,settings=settings,clock=clock)
        self.owner=self.imports.owner;self.one,self.rows=self.imports.one,self.imports.rows

    def get(self,identifier,*,required=True):
        row=self.one("SELECT * FROM moneylens.import_publications WHERE tenant_id=%s AND owner_user_id=%s AND import_id=%s",(*self.owner,identifier))
        if not row and required: raise AuthError("NOT_FOUND",404)
        return row

    def publication(self,identifier):
        row=self.one("SELECT * FROM moneylens.import_publications WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,identifier))
        if not row: raise AuthError("NOT_FOUND",404)
        return row

    def feed(self,identifier):
        row=self.one("SELECT * FROM moneylens.native_feeds WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,identifier))
        if not row: raise ValueError("Native feed is missing")
        return row

    def validation(self,identifier):
        batch=self.imports.get(identifier)
        if batch["state"] not in ("source_ready","published"): raise AuthError("IMPORT_VALIDATION_REQUIRED",409)
        run=self.one("SELECT * FROM moneylens.import_validation_runs WHERE tenant_id=%s AND owner_user_id=%s AND import_id=%s",(*self.owner,identifier))
        if not run or run["state"]!="validated" or run["rejected_rows"] or run["accepted_rows"]!=run["processed_rows"]:
            raise AuthError("IMPORT_VALIDATION_REQUIRED",409)
        manifest=ImportManifestV1.model_validate(batch["manifest"])
        counts={role:point["rows"] for role,point in run["checkpoints"].items()}
        if set(counts)!={file.role for file in manifest.files} or not all(point["complete"] for point in run["checkpoints"].values()):
            raise AuthError("IMPORT_VALIDATION_REQUIRED",409)
        if sum(counts.values())!=run["accepted_rows"] or counts.get("accounts",0)<1:
            raise AuthError("IMPORT_VALIDATION_REQUIRED",409)
        job=JobStore(self.connection,self.user.scope).status(run["job_id"])
        if not job or job["state"]!="completed": raise AuthError("IMPORT_VALIDATION_REQUIRED",409)
        return batch,run,manifest,counts

    def status(self,row):
        feed=self.feed(row["feed_id"]);job=JobStore(self.connection,self.user.scope).status(row["job_id"])
        if job is None: raise ValueError("Publication job is missing")
        state=row["state"]
        if state=="published" and feed["active_publication_id"]!=row["id"]: state="superseded"
        if state=="queued":
            if job["state"]=="cancelled": state="cancelled"
            elif job["state"] in ("failed","dead_letter"): state="failed"
        return state,feed,job

    def read(self,identifier):
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            batch=self.imports.get(identifier);row=self.get(identifier);state,feed,job=self.status(row)
            return ImportPublicationViewV1(id=row["id"],import_id=identifier,run_id=row["run_id"],feed_id=row["feed_id"],
                state=state,active=feed["active_publication_id"]==row["id"],active_publication_id=feed["active_publication_id"],
                generation=row["generation"],manifest=ImportManifestV1.model_validate(batch["manifest"]),source_manifest_sha256=batch["source_sha256"],
                account_count=row["account_count"],transaction_count=row["transaction_count"],balance_count=row["balance_count"],
                created_at=row["created_at"],updated_at=row["updated_at"],published_at=row["published_at"],published_data_version=row["published_data_version"],
                last_error_code=row["last_error_code"] or job["last_error_code"],job=job,limitations=[
                    "Active versions expose only this declared native synthetic feed; no organizer endorsement or whole-finance coverage is established.",
                    "Imported expense labels are source claims. Other economic flows remain unresolved until relationship review; currencies are never converted.",
                    "Missing/ambiguous/stale balance or planning facts still block recommendations. Source publication transfers and reserves no money.",
                    "Different feeds and bank connections are not automatically merged or deduplicated."])

    def previous(self,key,digest):
        row=self.one("""SELECT request_fingerprint,receipt FROM moneylens.import_publication_commands
            WHERE tenant_id=%s AND owner_user_id=%s AND command_key=%s""",(*self.owner,key))
        if not row: return None
        if row["request_fingerprint"]!=digest: raise AuthError("IDEMPOTENCY_CONFLICT",409)
        return ImportPublicationReceiptV1.model_validate(row["receipt"])

    def enqueue(self,identifier,generation):
        return JobStore(self.connection,self.user.scope).enqueue("import.publish",f"publication:{identifier}:{generation}",
            {"publication_id":str(identifier),"generation":generation},max_attempts=3)

    def record(self,action,key,digest,row,now):
        receipt=ImportPublicationReceiptV1(id=uuid4(),action=action,import_id=row["import_id"],publication_id=row["id"],
            feed_id=row["feed_id"],job_id=row["job_id"],state=self.status(row)[0],applied_at=now)
        self.connection.execute("""INSERT INTO moneylens.import_publication_commands
            (tenant_id,owner_user_id,id,publication_id,command_key,request_fingerprint,applied_at,receipt) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (*self.owner,receipt.id,row["id"],key,digest,now,Jsonb(receipt.model_dump(mode="json"))))
        self.imports.audit("import.publication_"+action,row["import_id"],now)
        JobStore(self.connection,self.user.scope).emit("import.publication_"+action,"publication-command:"+str(receipt.id),
            {"publication_id":str(row["id"]),"import_id":str(row["import_id"]),"state":receipt.state})
        return receipt

    def command(self,identifier,body,action):
        if action not in ("start","cancel"): raise ValueError("Use a registered publication command")
        try: body=ImportActionV1.model_validate(body.model_dump(mode="python"),strict=True)
        except (ValueError,AttributeError): raise AuthError("INVALID_IMPORT_COMMAND",422) from None
        if action=="start": self.imports.editable()
        digest=fingerprint({"action":"publication."+action,"import_id":str(identifier)});now=self.clock()
        with authorized_transaction(self.connection,self.user,write=True):
            if action=="start": self.imports.synthetic_member()
            previous=self.previous(body.key,digest)
            if previous: return previous
            count=self.connection.execute("""SELECT count(*) FROM (SELECT 1 FROM moneylens.import_publication_commands
                WHERE tenant_id=%s AND owner_user_id=%s AND applied_at>%s LIMIT 100) recent""",(*self.owner,now-timedelta(hours=1))).fetchone()[0]
            if count>=100: raise AuthError("IMPORT_COMMAND_THROTTLED",429)
            self.imports.get(identifier);row=self.get(identifier,required=False)
            if action=="start":
                batch,run,manifest,counts=self.validation(identifier)
                feed_id,digest_namespace=feed_identity(self.user.scope,manifest)
                if row is None:
                    self.connection.execute("""INSERT INTO moneylens.native_feeds
                        (tenant_id,owner_user_id,id,namespace_sha256,mapping_version,source_customer_ref,currency,created_at,updated_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                        (*self.owner,feed_id,digest_namespace,manifest.mapping_version,manifest.source_customer_ref,manifest.currency,now,now))
                    feed=self.feed(feed_id);publication_id=uuid4();job_id=self.enqueue(publication_id,1)
                    row=self.one("""INSERT INTO moneylens.import_publications
                        (tenant_id,owner_user_id,id,import_id,run_id,feed_id,expected_previous_id,state,job_id,
                            account_count,transaction_count,balance_count,created_at,updated_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,'queued',%s,%s,%s,%s,%s,%s) RETURNING *""",
                        (*self.owner,publication_id,identifier,run["id"],feed_id,feed["active_publication_id"],job_id,
                            counts["accounts"],counts["transactions"],counts.get("balances",0),now,now))
                elif self.status(row)[0] in ("failed","cancelled"):
                    failure=row["last_error_code"] or self.status(row)[2]["last_error_code"]
                    if failure and failure not in ("import_source_version_changed","import_publication_failed","attempts_exhausted","permission_changed"):
                        raise AuthError("IMPORT_PUBLICATION_CLOSED",409)
                    if row["generation"]>=MAX_MINOR: raise AuthError("IMPORT_PUBLICATION_CLOSED",409)
                    generation=row["generation"]+1;job_id=self.enqueue(row["id"],generation)
                    self.connection.execute("""UPDATE moneylens.import_publications SET state='queued',generation=%s,job_id=%s,
                        expected_previous_id=%s,updated_at=%s,last_error_code=NULL WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                        (generation,job_id,self.feed(row["feed_id"])["active_publication_id"],now,*self.owner,row["id"]))
            else:
                if row is None: raise AuthError("NOT_FOUND",404)
                if row["state"]=="published": raise AuthError("IMPORT_PUBLICATION_CLOSED",409)
                JobStore(self.connection,self.user.scope).cancel(row["job_id"])
                self.connection.execute("UPDATE moneylens.import_publications SET state='cancelled',updated_at=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",
                    (now,*self.owner,row["id"]))
            return self.record(action,body.key,digest,self.get(identifier),now)

    def context(self,identifier,job_id,generation):
        self.imports.synthetic_member();row=self.publication(identifier)
        if (row["state"],row["job_id"],row["generation"])!=("queued",job_id,generation):
            raise PublicationError("import_publication_superseded")
        batch,run,manifest,counts=self.validation(row["import_id"])
        feed=self.feed(row["feed_id"])
        if feed["active_publication_id"]!=row["expected_previous_id"]:
            raise PublicationError("import_source_version_changed")
        if row["run_id"]!=run["id"] or row["feed_id"]!=feed_identity(self.user.scope,manifest)[0]:
            raise PublicationError("import_publication_identity_changed")
        if (feed["namespace_sha256"],feed["mapping_version"],feed["source_customer_ref"],feed["currency"])!=(
                feed_identity(self.user.scope,manifest)[1],manifest.mapping_version,manifest.source_customer_ref,manifest.currency):
            raise PublicationError("import_publication_identity_changed")
        if (row["account_count"],row["transaction_count"],row["balance_count"])!=(counts["accounts"],counts["transactions"],counts.get("balances",0)):
            raise PublicationError("import_publication_counts_changed")
        return row,batch,run,manifest,feed

    def prepare(self,identifier,job_id,generation):
        row,batch,run,manifest,feed=self.context(identifier,job_id,generation)
        counts=dict(self.connection.execute("""SELECT role,count(*) FROM moneylens.import_stage_rows
            WHERE tenant_id=%s AND owner_user_id=%s AND run_id=%s GROUP BY role""",(*self.owner,run["id"])).fetchall())
        if (counts.get("accounts",0),counts.get("transactions",0),counts.get("balances",0))!=(row["account_count"],row["transaction_count"],row["balance_count"]):
            raise PublicationError("import_publication_counts_changed")
        accounts=self.rows("""SELECT source_reference,payload FROM moneylens.import_stage_rows WHERE tenant_id=%s AND owner_user_id=%s
            AND run_id=%s AND role='accounts' ORDER BY source_reference LIMIT 1001""",(*self.owner,run["id"]))
        if len(accounts)!=row["account_count"]: raise PublicationError("import_publication_counts_changed")
        self.check_balances(run["id"])
        if row["expected_previous_id"]:
            prior=self.publication(row["expected_previous_id"])
            old=self.imports.get(prior["import_id"]);old_manifest=ImportManifestV1.model_validate(old["manifest"])
            if manifest.timezone!=old_manifest.timezone or manifest.claimed_from>old_manifest.claimed_from or manifest.claimed_to_exclusive<old_manifest.claimed_to_exclusive:
                raise PublicationError("import_source_coverage_regressed")
            self.check_replacement(prior["run_id"],run["id"])
        shaped=tuple((native_id(row["feed_id"],"account",account["source_reference"]),account["source_reference"],
            account["payload"]["name"],account["payload"]["currency"],account["payload"]["account_type"]) for account in accounts)
        return PreparedPublication(row["id"],job_id,generation,run["id"],row["expected_previous_id"],shaped)

    def check_balances(self,run_id):
        ambiguous=self.connection.execute("""SELECT 1 FROM moneylens.import_stage_rows WHERE tenant_id=%s AND owner_user_id=%s
            AND run_id=%s AND role='balances' GROUP BY account_reference,observed_at HAVING count(*)>1 LIMIT 1""",(*self.owner,run_id)).fetchone()
        if ambiguous: raise PublicationError("import_balance_ambiguous")

    def check_replacement(self,old_run,new_run):
        missing=self.connection.execute("""SELECT 1 FROM moneylens.import_stage_rows old WHERE old.tenant_id=%s AND old.owner_user_id=%s
            AND old.run_id=%s AND old.role='accounts' AND NOT EXISTS (SELECT 1 FROM moneylens.import_stage_rows next
                WHERE next.tenant_id=old.tenant_id AND next.owner_user_id=old.owner_user_id AND next.run_id=%s AND next.role='accounts'
                    AND next.source_reference=old.source_reference AND next.currency=old.currency
                    AND next.payload->>'account_type'=old.payload->>'account_type') LIMIT 1""",(*self.owner,old_run,new_run)).fetchone()
        if missing: raise PublicationError("import_source_accounts_changed")
        conflict=self.one("""SELECT CASE WHEN next.source_reference IS NULL THEN 'import_source_history_removed'
                WHEN (next.payload->>'revision')::bigint<(old.payload->>'revision')::bigint THEN 'import_source_revision_regressed'
                WHEN next.observed_at<old.observed_at THEN 'import_source_observation_regressed'
                WHEN old.payload->>'status'='booked' AND next.payload->>'status'='pending' THEN 'import_source_status_regressed'
                WHEN old.payload->>'status'='reversed' AND next.payload->>'status'<>'reversed' THEN 'import_source_status_regressed'
                ELSE 'import_source_revision_conflict' END AS code
            FROM moneylens.import_stage_rows old LEFT JOIN moneylens.import_stage_rows next
                ON (next.tenant_id,next.owner_user_id,next.run_id,next.role,next.account_reference,next.source_reference)
                =(old.tenant_id,old.owner_user_id,%s,old.role,old.account_reference,old.source_reference)
            WHERE old.tenant_id=%s AND old.owner_user_id=%s AND old.run_id=%s AND old.role='transactions' AND (
                next.source_reference IS NULL OR (next.payload->>'revision')::bigint<(old.payload->>'revision')::bigint
                OR next.observed_at<old.observed_at OR (old.payload->>'status'='booked' AND next.payload->>'status'='pending')
                OR (old.payload->>'status'='reversed' AND next.payload->>'status'<>'reversed')
                OR ((next.payload->>'revision')::bigint=(old.payload->>'revision')::bigint
                    AND (next.payload-'observed_at') IS DISTINCT FROM (old.payload-'observed_at'))) LIMIT 1""",
            (new_run,*self.owner,old_run))
        if conflict: raise PublicationError(conflict["code"])
        old_balances=self.connection.execute("""WITH prior AS (
            SELECT DISTINCT ON (account_reference) account_reference,observed_at,payload FROM moneylens.import_stage_rows
                WHERE tenant_id=%s AND owner_user_id=%s AND run_id=%s AND role='balances' ORDER BY account_reference,observed_at DESC),
            next AS (SELECT DISTINCT ON (account_reference) account_reference,observed_at,payload FROM moneylens.import_stage_rows
                WHERE tenant_id=%s AND owner_user_id=%s AND run_id=%s AND role='balances' ORDER BY account_reference,observed_at DESC)
            SELECT 1 FROM prior LEFT JOIN next USING (account_reference) WHERE next.account_reference IS NULL
                OR next.observed_at<prior.observed_at OR (next.observed_at=prior.observed_at AND
                    (next.payload-'source_id') IS DISTINCT FROM (prior.payload-'source_id')) LIMIT 1""",(*self.owner,old_run,*self.owner,new_run)).fetchone()
        if old_balances: raise PublicationError("import_source_balance_regressed")

    def activate(self,prepared):
        row,batch,run,manifest,feed=self.context(prepared.publication_id,prepared.job_id,prepared.generation)
        if (row["run_id"],row["expected_previous_id"])!=(prepared.run_id,prepared.expected_previous_id):
            raise PublicationError("import_publication_identity_changed")
        now=self.clock()
        self.activate_accounts(feed["id"],prepared.accounts,row["account_count"])
        state=self.connection.execute("""UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s
            AND data_version<9007199254740991 RETURNING data_version""",self.owner).fetchone()
        if not state: raise PublicationError("import_data_version_exhausted")
        self.connection.execute("UPDATE moneylens.native_feeds SET active_publication_id=%s,updated_at=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",
            (row["id"],now,*self.owner,feed["id"]))
        self.connection.execute("""UPDATE moneylens.import_publications SET state='published',published_at=%s,published_data_version=%s,
            updated_at=%s,last_error_code=NULL WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(now,state[0],now,*self.owner,row["id"]))
        self.connection.execute("""UPDATE moneylens.import_batches SET state='published',published_at=%s,updated_at=%s,
            accepted_rows=%s,rejected_rows=0 WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
            (now,now,run["accepted_rows"],*self.owner,row["import_id"]))
        self.imports.audit("import.published",row["import_id"],now)
        JobStore(self.connection,self.user.scope).emit("import.published","import-published:"+str(row["id"]),
            {"import_id":str(row["import_id"]),"publication_id":str(row["id"]),"feed_id":str(feed["id"]),"data_version":state[0]})

    def activate_accounts(self,feed_id,accounts,expected_count):
        if len(accounts)!=expected_count: raise PublicationError("import_publication_counts_changed")
        self.connection.execute("CREATE TEMP TABLE publication_accounts (id uuid,reference text,name text,currency text,kind text) ON COMMIT DROP")
        with self.connection.cursor().copy("COPY publication_accounts FROM STDIN") as copy:
            for account in accounts: copy.write_row(account)
        conflict=self.connection.execute("""SELECT 1 FROM publication_accounts p JOIN moneylens.accounts a
            ON a.tenant_id=%s AND a.owner_user_id=%s AND a.id=p.id
            WHERE (a.native_feed_id,a.native_reference,a.currency,a.account_type) IS DISTINCT FROM (%s,p.reference,p.currency,p.kind) LIMIT 1""",
            (*self.owner,feed_id)).fetchone()
        if conflict: raise PublicationError("import_canonical_account_conflict")
        count=self.connection.execute("""INSERT INTO moneylens.accounts
            (tenant_id,owner_user_id,id,name,currency,account_type,native_feed_id,native_reference)
            SELECT %s,%s,id,name,currency,kind,%s,reference FROM publication_accounts WHERE true
            ON CONFLICT (tenant_id,owner_user_id,id) DO UPDATE SET name=excluded.name
            WHERE moneylens.accounts.native_feed_id=excluded.native_feed_id AND moneylens.accounts.native_reference=excluded.native_reference
                AND moneylens.accounts.currency=excluded.currency AND moneylens.accounts.account_type=excluded.account_type""",(*self.owner,feed_id)).rowcount
        if count!=expected_count: raise PublicationError("import_canonical_account_conflict")
