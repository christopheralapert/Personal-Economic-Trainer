"""Bounded local-simulator fetch jobs. Staging is never financial publication.

Every page is a separate short owner-fenced transaction. These adapters cannot
make external calls; future live adapters must fetch outside SQL transactions
and recheck consent before committing each checkpoint/publication.
"""
from datetime import date, datetime, timedelta, timezone
import json
from types import SimpleNamespace
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
from psycopg.types.json import Jsonb

from .bank_adapter import BankError
from .bank_store import BankStore
from .bank_staging import seal_stage, verify_stage
from .bank_reconciliation import merge_page
from .database import tenant_transaction
from .identity import AuthError, authorized_transaction
from .jobs import JobStore, LostLease
from .planning_policy import utc

MAX_PAGES=20
MAX_BYTES=200000  # Leaves room for JSONB whitespace under the database cap.


class BankFetch:
    def __init__(self,connection,user,secret,job,*,clock=lambda:datetime.now(timezone.utc),page_size=100):
        if type(page_size) is not int or not 1<=page_size<=100:
            raise ValueError("Use a bounded source page")
        self.connection,self.user,self.job,self.clock,self.page_size=connection,user,job,clock,page_size
        self.banks=BankStore(connection,user,secret,clock=clock)
        payload=job.payload
        if job.type!="bank.fetch" or job.schema_version!=1 or not isinstance(payload,dict) or set(payload)!={"connection_id","generation"}:
            raise BankError("invalid_fetch_job")
        try:
            self.identifier=UUID(payload["connection_id"])
            if type(payload["generation"]) is not int or payload["generation"]<1:
                raise ValueError()
        except (ValueError,TypeError,AttributeError):
            raise BankError("invalid_fetch_job") from None

    def authority(self):
        self.banks.require_synthetic()
        jobs=JobStore(self.connection,self.user.scope)
        leased=jobs._leased(self.job)
        if leased["permission_version"]!=self.user.permission_version:
            raise AuthError()
        row=self.banks.row(self.identifier)
        if row["refresh_job_id"]!=self.job.id or row["consent_generation"]!=self.job.payload["generation"]:
            raise BankError("consent_scope_changed")
        session=self.banks.session(row)
        self.banks.guard(session,"read")
        # Explicitly synthetic implementation: no registry can select a live
        # provider and perform network I/O while this transaction is open.
        return row,self.banks.adapter(row),session,jobs

    def checkpoint(self,row,adapter,session):
        checkpoint=row["sync_checkpoint"]
        now=utc(self.clock())
        if checkpoint:
            valid=(checkpoint.get("job_id")==str(self.job.id) and checkpoint.get("generation")==session.generation
                and checkpoint.get("page_size")==self.page_size)
            try:
                age=now-utc(datetime.fromisoformat(checkpoint["as_of"]))
            except (ValueError,KeyError,TypeError):
                age=timedelta(days=1)
            if valid and timedelta(0)<=age<timedelta(minutes=5):
                return checkpoint
        accounts=adapter.list_accounts(session)
        if len(accounts)!=1 or tuple(item.reference for item in accounts)!=session.account_references:
            raise BankError("invalid_fetch_scope")
        balances=adapter.fetch_balances(session,accounts[0].reference,as_of=now)
        if len(balances)!=1 or balances[0].account_reference!=accounts[0].reference:
            raise BankError("invalid_source_balance")
        return {"job_id":str(self.job.id),"generation":session.generation,"phase":"fetching","as_of":now.isoformat(),
            "page_size":self.page_size,"account":accounts[0].model_dump(mode="json"),
            "balances":[item.model_dump(mode="json") for item in balances],"rows":[],"pages":0,"cursor":None,
            "start":adapter.capabilities().history_from.isoformat(),
            "end_exclusive":(now.astimezone(ZoneInfo(adapter.capabilities().timezone)).date()+timedelta(days=1)).isoformat()}

    def step(self):
        """Persist one bounded page; return True only once a complete stage exists."""
        with authorized_transaction(self.connection,self.user,write=True):
            row,adapter,session,jobs=self.authority()
            checkpoint=self.checkpoint(row,adapter,session)
            if checkpoint["phase"]=="ready":
                # Recovery after final checkpoint but before job completion.
                verify_stage(self.banks.secret,self.user.scope,self.identifier,checkpoint)
                jobs.complete(self.job,lambda *_:None)
                return True
            if checkpoint["pages"]>=MAX_PAGES:
                raise BankError("source_page_budget_exceeded")
            instant=datetime.fromisoformat(checkpoint["as_of"])
            page=adapter.fetch_transactions(session,checkpoint["account"]["reference"],as_of=instant,
                start=date.fromisoformat(checkpoint["start"]),end_exclusive=date.fromisoformat(checkpoint["end_exclusive"]),
                cursor=checkpoint["cursor"],limit=self.page_size)
            balance=checkpoint["balances"][0]
            if page.source_version!=balance["source_version"] or page.observed_at!=datetime.fromisoformat(balance["observed_at"]):
                raise BankError("incoherent_source_snapshot")
            if utc(self.clock())-utc(page.observed_at)>timedelta(hours=24):
                raise BankError("source_stale")
            if not page.complete:
                raise BankError("source_incomplete")
            if page.next_cursor is not None and page.next_cursor==checkpoint["cursor"]:
                raise BankError("source_cursor_not_advanced")
            merged=merge_page(checkpoint["rows"],page.rows,checkpoint["account"]["reference"])
            checkpoint.update(rows=merged,
                pages=checkpoint["pages"]+1,cursor=page.next_cursor,source_version=page.source_version,
                source_observed_at=page.observed_at.isoformat(),coverage_from=page.coverage_from.isoformat(),
                coverage_to_exclusive=page.coverage_to_exclusive.isoformat())
            finished=page.next_cursor is None
            if finished:
                checkpoint["phase"]="ready"
                checkpoint["seal"]=seal_stage(self.banks.secret,self.user.scope,self.identifier,checkpoint)
            if len(json.dumps(checkpoint,ensure_ascii=True).encode())>MAX_BYTES:
                raise BankError("source_byte_budget_exceeded")
            self.banks.guard(session,"read")
            self.connection.execute("""UPDATE moneylens.connections SET sync_checkpoint=%s,last_attempt_at=%s,
                sync_health=%s,last_error_code=NULL,source_observed_at=%s,
                staged_at=CASE WHEN %s THEN %s ELSE NULL END WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                (Jsonb(checkpoint),utc(self.clock()),"staged" if finished else "syncing",page.observed_at,finished,utc(self.clock()),
                    *self.banks.owner,self.identifier))
            if finished:
                def stage_completed(store,job):
                    self.banks.record("bank.source_staged",self.identifier)
                    store.enqueue("bank.publish","publish:"+str(job.id),{
                        "connection_id":str(self.identifier),"fetch_job_id":str(job.id),"generation":session.generation},max_attempts=3)
                jobs.complete(self.job,stage_completed)
            else:
                jobs.heartbeat(self.job)
            return finished

    def fail(self,error):
        """Preserve last published success, discard partial stage and bound retries."""
        with authorized_transaction(self.connection,self.user,write=True):
            row,adapter,session,jobs=self.authority()
            health="partial" if error.code=="source_incomplete" else "stale" if error.code=="source_stale" else "error"
            self.connection.execute("""UPDATE moneylens.connections SET sync_health=%s,last_error_code=%s,
                last_attempt_at=%s,sync_checkpoint=NULL,staged_at=NULL WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                (health,error.code,utc(self.clock()),*self.banks.owner,self.identifier))
            jobs.fail(self.job,error.code,permanent=not error.retryable)
            if error.retry_after_seconds:
                self.connection.execute("""UPDATE moneylens.jobs SET available_at=greatest(available_at,
                    clock_timestamp()+(%s*interval '1 second')) WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND state='queued'""",
                    (error.retry_after_seconds,*self.banks.owner,self.job.id))
            self.banks.record("bank.fetch_failed",self.identifier)


def run_fetch_once(database_url,scope,secret,*,clock=lambda:datetime.now(timezone.utc),page_size=100):
    """One operator-scoped bounded fetch; never selects a global customer scope."""
    with psycopg.connect(database_url,autocommit=True,connect_timeout=5,
            options="-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000") as connection:
        with tenant_transaction(connection,scope):
            # Same lock order as financial writes and membership revocation.
            connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",
                (scope.tenant_id,scope.user_id)).fetchone()
            jobs=JobStore(connection,scope)
            claimed=jobs.claim(["bank.fetch"])
            if claimed is None:
                return False
            owner=connection.execute("SELECT permission_version,is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",
                (scope.tenant_id,scope.user_id)).fetchone()
            if not owner[1]:
                jobs.cancel(claimed.id)
                return True
            user=SimpleNamespace(scope=scope,permission_version=owner[0],synthetic=True,session_id=None)
        try:
            service=BankFetch(connection,user,secret,claimed,clock=clock,page_size=page_size)
        except BankError as error:
            with authorized_transaction(connection,user,write=True):
                JobStore(connection,scope).fail(claimed,error.code,permanent=True)
            return True
        try:
            for _ in range(MAX_PAGES):
                if service.step():
                    return True
            service.fail(BankError("source_page_budget_exceeded"))
        except (BankError,AuthError,LostLease) as error:
            try:
                if isinstance(error,BankError):
                    service.fail(error)
                else:
                    raise error
            except (BankError,AuthError,LostLease):
                # A changed membership/consent or cancelled lease must never
                # authorize new checkpoints or failure effects.
                with tenant_transaction(connection,scope):
                    connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",
                        (scope.tenant_id,scope.user_id)).fetchone()
                    current=connection.execute("""SELECT id FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s
                        AND id=%s AND state='running' AND lease_token=%s FOR UPDATE""",
                        (scope.tenant_id,scope.user_id,claimed.id,claimed.lease_token)).fetchone()
                    if current:
                        JobStore(connection,scope).cancel(claimed.id)
                        connection.execute("""UPDATE moneylens.connections SET sync_checkpoint=NULL,staged_at=NULL,
                            sync_health=CASE WHEN last_success_at IS NULL THEN 'never_synced' ELSE 'stale' END,
                            last_error_code='fetch_authority_changed'
                            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND refresh_job_id=%s AND consent_generation=%s""",
                            (scope.tenant_id,scope.user_id,service.identifier,claimed.id,claimed.payload["generation"]))
        return True
