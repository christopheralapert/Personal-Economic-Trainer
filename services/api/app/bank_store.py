"""Owned durable synthetic consent authority. External provider operations are absent."""
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
import hashlib
import hmac
from uuid import uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .bank_adapter import BankError, BankSession
from .identity import AuthError, authorized_transaction, derive
from .jobs import JobStore
from .planning_policy import utc
from .planning_store import command_key, fingerprint
from .synthetic_banks import FAULTS, SyntheticBank


class BankStore:
    def __init__(self,connection,user,secret,*,clock=lambda:datetime.now(timezone.utc)):
        self.connection,self.user,self.secret,self.clock = connection,user,secret,clock
        self.owner = (user.scope.tenant_id,user.scope.user_id)

    def require_synthetic(self):
        if not self.user.synthetic:
            raise AuthError("SYNTHETIC_BANKS_ONLY",403)

    def current_synthetic(self):
        self.require_synthetic()
        if self.connection.execute("SELECT is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",self.owner).fetchone()!=(True,):
            raise AuthError("SYNTHETIC_BANKS_ONLY",403)

    @contextmanager
    def transaction(self,*,write=False):
        with authorized_transaction(self.connection,self.user,write=write):
            self.current_synthetic()
            yield

    def one(self,query,params=()):
        with self.connection.cursor(row_factory=dict_row) as cursor:
            return cursor.execute(query,params).fetchone()

    def row(self,identifier):
        row = self.one("SELECT * FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,identifier))
        if row is None or row["provider_mode"]!="synthetic":
            raise AuthError("NOT_FOUND",404)
        return row

    def session(self,row):
        return BankSession(self.user.scope,row["id"],row["consent_generation"],tuple(row["scopes"]),row["expires_at"])

    def guard(self,session,purpose):
        # Called only inside the service's membership-fenced transaction. SQL
        # guards stay current across process restarts; no in-memory allow list.
        JobStore(self.connection,self.user.scope)._check()
        self.current_synthetic()
        row = self.row(session.connection_id)
        if session.scope!=self.user.scope or session.generation!=row["consent_generation"] or session.account_references!=tuple(row["scopes"]):
            raise BankError("consent_scope_changed")
        now = utc(self.clock())
        if purpose=="revoke":
            return
        if purpose=="authorize":
            if row["consent_state"]!="authorizing" or row["authorization_session_id"]!=self.user.session_id:
                raise BankError("authorization_not_active")
            if row["authorization_expires_at"]<=now:
                raise BankError("authorization_expired")
        elif purpose=="discover" and row["consent_state"]=="authorizing":
            if row["authorization_session_id"]!=self.user.session_id or row["authorization_expires_at"]<=now:
                raise BankError("authorization_not_active")
        elif row["consent_state"]!="active" or row["expires_at"] is None or row["expires_at"]<=now:
            raise BankError("consent_not_active")

    def adapter(self,row):
        return SyntheticBank(row["provider"],self.guard,self.secret,clock=self.clock,fault=row["synthetic_fault"])

    def token(self,row):
        return derive(self.secret,"bank.callback.v1",":".join(map(str,(*self.owner,row["id"],row["authorization_session_id"]))))

    def effective_state(self,row,now):
        if row["consent_state"]=="authorizing" and row["authorization_expires_at"] is not None and row["authorization_expires_at"]<=now:
            return "expired"
        if row["consent_state"]=="active" and (row["expires_at"] is None or row["expires_at"]<=now):
            return "expired"
        return row["consent_state"]

    def view(self,row):
        return {"id":row["id"],"institution_id":row["provider"],"mode":"synthetic",
            "name":self.adapter(row).capabilities().name,"consent_state":self.effective_state(row,utc(self.clock())),
            "generation":row["consent_generation"],"account_references":row["scopes"],"expires_at":row["expires_at"],
            "sync_health":row["sync_health"],"last_success_at":row["last_success_at"],"last_error_code":row["last_error_code"],
            "synthetic_fault":row["synthetic_fault"],"refresh_job_id":row["refresh_job_id"],"last_attempt_at":row["last_attempt_at"],
            "source_observed_at":row["source_observed_at"],"staged_at":row["staged_at"]}

    def record(self,action,resource,*,invalidate=False):
        if invalidate:
            self.connection.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",self.owner)
        self.connection.execute("""INSERT INTO moneylens.audit_events
            (tenant_id,owner_user_id,id,action,resource_id,trace_id,metadata) VALUES (%s,%s,%s,%s,%s,%s,'{}')""",
            (*self.owner,uuid4(),action,resource,uuid4()))
        JobStore(self.connection,self.user.scope).emit(action,action+":"+str(uuid4()),{"connection_id":str(resource)})

    def start_view(self,row):
        authorizing = row["consent_state"]=="authorizing" and row["callback_consumed_at"] is None and row["authorization_expires_at"]>utc(self.clock())
        if authorizing and row["authorization_session_id"]!=self.user.session_id:
            raise AuthError("BANK_AUTH_SESSION_CHANGED",409)
        authorization = self.adapter(row).begin_consent(self.session(row)) if authorizing else None
        if authorization:
            authorization = authorization.model_copy(update={"expires_at":row["authorization_expires_at"]})
        return {"connection":self.view(row),"authorization":authorization,
            "state_token":self.token(row) if authorizing else None}

    def start(self,institution,*,key):
        self.require_synthetic(); command_key(key)
        if institution not in ("s-bank-demo","north-demo"):
            raise AuthError("BANK_NOT_SUPPORTED",422)
        digest = fingerprint({"institution":institution})
        now = utc(self.clock())
        with self.transaction(write=True):
            prior = self.one("SELECT * FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s AND start_key=%s",(*self.owner,key))
            if prior:
                if prior["start_fingerprint"]!=digest:
                    raise AuthError("IDEMPOTENCY_CONFLICT",409)
                return self.start_view(prior)
            rows = self.connection.execute("SELECT id FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s LIMIT 51",self.owner).fetchall()
            if len(rows)>=50:
                raise AuthError("BANK_CONNECTION_LIMIT",409)
            existing = self.one("""SELECT * FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s AND provider=%s
                AND provider_mode='synthetic' AND consent_state IN ('requested','authorizing','active')""",(*self.owner,institution))
            if existing:
                if (existing["consent_state"]=="active" and existing["expires_at"] and existing["expires_at"]<=now) or (
                    existing["consent_state"]=="authorizing" and existing["authorization_expires_at"]<=now):
                    self.cancel_fetch(existing)
                    self.connection.execute("""UPDATE moneylens.connections SET consent_state='expired',consent_generation=consent_generation+1,callback_hash=NULL
                        WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(*self.owner,existing["id"]))
                    self.record("bank.expired",existing["id"],invalidate=bool(existing["scopes"]))
                else:
                    raise AuthError("BANK_CONNECTION_EXISTS",409)
            identifier = uuid4()
            self.connection.execute("""INSERT INTO moneylens.connections
                (tenant_id,owner_user_id,id,provider,provider_mode,consent_state,authorization_session_id,authorization_expires_at,start_key,start_fingerprint)
                VALUES (%s,%s,%s,%s,'synthetic','requested',%s,%s+interval '10 minutes',%s,%s)""",
                (*self.owner,identifier,institution,self.user.session_id,now,key,digest))
            self.record("bank.requested",identifier)
            row = self.row(identifier)
            hashed = hashlib.sha256(self.token(row).encode()).hexdigest()
            self.connection.execute("""UPDATE moneylens.connections SET consent_state='authorizing',callback_hash=%s
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(hashed,*self.owner,identifier))
            self.record("bank.authorizing",identifier)
            return self.start_view(self.row(identifier))

    def complete(self,identifier,*,key,state_token,account_references,approved):
        self.require_synthetic(); command_key(key)
        digest = fingerprint({"accounts":list(account_references),"approved":approved,"state_hash":hashlib.sha256(state_token.encode()).hexdigest()})
        now = utc(self.clock())
        with self.transaction(write=True):
            row = self.row(identifier)
            if row["complete_key"] is not None:
                if row["complete_key"]!=key or row["complete_fingerprint"]!=digest:
                    raise AuthError("IDEMPOTENCY_CONFLICT",409)
                return self.view(row)
            if row["consent_state"]!="authorizing" or row["callback_consumed_at"] is not None or row["authorization_expires_at"]<=now:
                raise AuthError("BANK_AUTH_EXPIRED",409)
            if row["authorization_session_id"]!=self.user.session_id or row["callback_hash"] is None or not hmac.compare_digest(
                row["callback_hash"],hashlib.sha256(state_token.encode()).hexdigest()):
                raise AuthError("BANK_CALLBACK_REJECTED",403)
            if not approved and account_references:
                raise AuthError("BANK_INVALID_SELECTION",422)
            grant = self.adapter(row).complete_consent(self.session(row),tuple(account_references)) if approved else None
            self.connection.execute("""UPDATE moneylens.connections SET consent_state=%s,scopes=%s,expires_at=%s,
                consent_generation=consent_generation+1,callback_hash=NULL,callback_consumed_at=%s,complete_key=%s,complete_fingerprint=%s
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                ("active" if approved else "denied",Jsonb(grant.account_references if grant else []),grant.expires_at if grant else None,
                    now,key,digest,*self.owner,identifier))
            self.record("bank.activated" if approved else "bank.denied",identifier,invalidate=approved)
            return self.view(self.row(identifier))

    def list(self):
        self.require_synthetic()
        with self.transaction():
            with self.connection.cursor(row_factory=dict_row) as query:
                rows = query.execute("SELECT * FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s AND provider_mode='synthetic' ORDER BY id LIMIT 51",self.owner).fetchall()
            if len(rows)>50:
                raise AuthError("BANK_CONNECTION_LIMIT",409)
            return [self.view(row) for row in rows]

    def read(self,identifier):
        self.require_synthetic()
        with self.transaction():
            return self.view(self.row(identifier))

    def disconnect(self,identifier):
        self.require_synthetic()
        with self.transaction(write=True):
            row = self.row(identifier)
            if row["consent_state"]!="revoked":
                self.cancel_fetch(row)
                self.adapter(row).revoke_consent(self.session(row))
                self.connection.execute("""UPDATE moneylens.connections SET consent_state='revoked',revoked_at=%s,
                    consent_generation=consent_generation+1,callback_hash=NULL WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                    (utc(self.clock()),*self.owner,identifier))
                self.record("bank.revoked",identifier,invalidate=bool(row["scopes"]))
            return self.view(self.row(identifier))

    def control(self,identifier,*,fault):
        self.require_synthetic()
        if fault not in FAULTS:
            raise AuthError("BANK_UNSUPPORTED_SCENARIO",422)
        with self.transaction(write=True):
            row = self.row(identifier)
            if self.effective_state(row,utc(self.clock()))!="active":
                raise AuthError("BANK_CONSENT_NOT_ACTIVE",409)
            if row["synthetic_fault"]!=fault:
                self.cancel_fetch(row)
                self.connection.execute("""UPDATE moneylens.connections SET synthetic_fault=%s,consent_generation=consent_generation+1,
                    sync_health=CASE WHEN last_success_at IS NULL THEN 'never_synced' ELSE 'stale' END,
                    consent_state=CASE WHEN %s='expired' THEN 'expired' ELSE consent_state END,
                    expires_at=CASE WHEN %s='expired' THEN %s ELSE expires_at END
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(fault,fault,fault,utc(self.clock()),*self.owner,identifier))
                self.record("bank.scenario_changed",identifier,invalidate=True)
            return self.view(self.row(identifier))

    def cancel_fetch(self,row):
        if row["refresh_job_id"]:
            JobStore(self.connection,self.user.scope).cancel(row["refresh_job_id"])
            publications=self.connection.execute("""SELECT id FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s
                AND type='bank.publish' AND idempotency_key=%s AND state IN ('queued','running')""",
                (*self.owner,"publish:"+str(row["refresh_job_id"]))).fetchall()
            for publication in publications:
                JobStore(self.connection,self.user.scope).cancel(publication[0])
        self.connection.execute("""UPDATE moneylens.connections SET sync_checkpoint=NULL,staged_at=NULL
            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(*self.owner,row["id"]))

    def refresh_result(self,row,job_id,*,coalesced):
        published=self.one("""SELECT published_at FROM moneylens.bank_refresh_requests WHERE tenant_id=%s AND owner_user_id=%s
            AND connection_id=%s AND job_id=%s AND published_at IS NOT NULL LIMIT 1""",(*self.owner,row["id"],job_id)) is not None
        return {"connection":self.view(row),"job":JobStore(self.connection,self.user.scope).status(job_id),
            "coalesced":coalesced,"financial_publication_complete":published}

    def refresh(self,identifier,*,key):
        self.require_synthetic(); command_key(key)
        now=utc(self.clock())
        with self.transaction(write=True):
            row=self.row(identifier)
            prior=self.one("""SELECT job_id FROM moneylens.bank_refresh_requests
                WHERE tenant_id=%s AND owner_user_id=%s AND connection_id=%s AND command_key=%s""",(*self.owner,identifier,key))
            if prior:
                return self.refresh_result(row,prior["job_id"],coalesced=True)
            if self.effective_state(row,now)!="active":
                raise AuthError("BANK_CONSENT_NOT_ACTIVE",409)
            recent=self.connection.execute("""SELECT job_id FROM moneylens.bank_refresh_requests
                WHERE tenant_id=%s AND owner_user_id=%s AND requested_at>%s ORDER BY requested_at DESC LIMIT 61""",
                (*self.owner,now-timedelta(hours=1))).fetchall()
            if len(recent)>=60:
                raise BankError("refresh_throttled",retryable=True,retry_after_seconds=60)
            jobs=JobStore(self.connection,self.user.scope)
            current=self.one("SELECT id,state,permission_version,payload FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",
                (*self.owner,row["refresh_job_id"])) if row["refresh_job_id"] else None
            coalesced=bool(current and current["state"] in ("queued","running") and current["permission_version"]==self.user.permission_version
                and current["payload"]=={"connection_id":str(identifier),"generation":row["consent_generation"]})
            if coalesced:
                job_id=current["id"]
            else:
                if current and current["state"] in ("queued","running"):
                    jobs.cancel(current["id"])
                if len({item[0] for item in recent})>=20:
                    raise BankError("refresh_throttled",retryable=True,retry_after_seconds=60)
                cadence=self.adapter(row).capabilities().minimum_refresh_seconds
                if row["last_requested_at"] and (now-row["last_requested_at"]).total_seconds()<cadence:
                    raise BankError("refresh_throttled",retryable=True,retry_after_seconds=cadence)
                job_id=jobs.enqueue("bank.fetch","fetch:"+str(identifier)+":"+key,
                    {"connection_id":str(identifier),"generation":row["consent_generation"]},max_attempts=5)
                self.connection.execute("""UPDATE moneylens.connections SET refresh_job_id=%s,last_requested_at=%s,
                    sync_health='syncing',last_error_code=NULL,sync_checkpoint=NULL,staged_at=NULL
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(job_id,now,*self.owner,identifier))
                self.record("bank.refresh_requested",identifier,invalidate=True)
            self.connection.execute("""INSERT INTO moneylens.bank_refresh_requests
                (tenant_id,owner_user_id,id,connection_id,job_id,command_key,requested_at) VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (*self.owner,uuid4(),identifier,job_id,key,now))
            return self.refresh_result(self.row(identifier),job_id,coalesced=coalesced)
