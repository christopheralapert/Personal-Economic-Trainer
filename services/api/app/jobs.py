"""At-least-once scoped jobs with fenced, atomic database effects."""
import json
import random
import re
from dataclasses import dataclass
from uuid import UUID, uuid4

from psycopg.pq import TransactionStatus
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.database import TrustedScope

NAME = re.compile(r"^[a-z][a-z0-9_.-]{1,63}$")


class IdempotencyConflict(ValueError):
    pass


class LostLease(RuntimeError):
    pass


def canonical_json(value):
    def validate(item, depth=0):
        if depth > 32:
            raise ValueError("JSON payload nesting is limited to 32 levels")
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise ValueError("JSON object keys must be strings")
            for child in item.values():
                validate(child, depth + 1)
        elif isinstance(item, (list, tuple)):
            for child in item:
                validate(child, depth + 1)
    validate(value)
    try:
        return json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":"))
    except TypeError as error:
        raise ValueError("Payload must contain JSON values") from error


def validate_message(kind, key, payload, schema_version):
    if not isinstance(kind, str) or not NAME.fullmatch(kind):
        raise ValueError("Invalid registered message type")
    if not isinstance(key, str) or not 1 <= len(key) <= 200:
        raise ValueError("Idempotency keys must contain 1-200 characters")
    if type(schema_version) is not int or schema_version < 1:
        raise ValueError("Invalid message schema version")
    if not isinstance(payload, dict) or len(canonical_json(payload).encode()) > 65536:
        raise ValueError("Payload must be a bounded JSON object")


@dataclass(frozen=True)
class ClaimedJob:
    id: UUID
    type: str
    payload: dict
    schema_version: int
    attempts: int
    lease_token: UUID


class JobStore:
    def __init__(self, connection, scope: TrustedScope):
        self.connection = connection
        self.scope = scope
        self.owner = (scope.tenant_id, scope.user_id)
        self._check()

    def _check(self):
        if self.connection.info.transaction_status != TransactionStatus.INTRANS:
            raise RuntimeError("Job operations require a scoped transaction")
        current = self.connection.execute("""SELECT current_user,
            current_setting('app.tenant_id',true), current_setting('app.user_id',true)""").fetchone()
        if current != ("moneylens_runtime", str(self.scope.tenant_id), str(self.scope.user_id)):
            raise RuntimeError("Job scope does not match the active transaction")

    def _one(self, query, params=()):
        with self.connection.cursor(row_factory=dict_row) as cursor:
            return cursor.execute(query, params).fetchone()

    def enqueue(self, kind, key, payload, *, schema_version=1, max_attempts=5):
        self._check()
        validate_message(kind, key, payload, schema_version)
        if type(max_attempts) is not int or not 1 <= max_attempts <= 20:
            raise ValueError("Attempt limit must be 1-20")
        user = self._one("SELECT active,permission_version FROM moneylens.users WHERE tenant_id=%s AND id=%s", self.owner)
        if not user or not user["active"]:
            raise PermissionError("Inactive job owner")
        created = self._one("""INSERT INTO moneylens.jobs
            (tenant_id,owner_user_id,id,type,schema_version,state,idempotency_key,payload,max_attempts,permission_version)
            VALUES (%s,%s,%s,%s,%s,'queued',%s,%s,%s,%s)
            ON CONFLICT (tenant_id,owner_user_id,type,idempotency_key) DO NOTHING RETURNING id""",
            (*self.owner, uuid4(), kind, schema_version, key, Jsonb(payload), max_attempts, user["permission_version"]))
        if created:
            return created["id"]
        existing = self._one("""SELECT id,payload=%s AS same_payload,schema_version,max_attempts FROM moneylens.jobs
            WHERE tenant_id=%s AND owner_user_id=%s AND type=%s AND idempotency_key=%s""", (Jsonb(payload), *self.owner, kind, key))
        if not existing["same_payload"] or (existing["schema_version"], existing["max_attempts"]) != (schema_version, max_attempts):
            raise IdempotencyConflict("The job key already names different input")
        return existing["id"]

    def emit(self, kind, key, payload, *, schema_version=1):
        self._check()
        validate_message(kind, key, payload, schema_version)
        if len(canonical_json(payload).encode()) > 60000:
            raise ValueError("Outbox payload must leave room for its delivery envelope")
        user = self._one("SELECT active,permission_version FROM moneylens.users WHERE tenant_id=%s AND id=%s", self.owner)
        if not user or not user["active"]:
            raise PermissionError("Inactive event owner")
        created = self._one("""INSERT INTO moneylens.outbox_events
            (tenant_id,owner_user_id,id,type,event_key,payload,schema_version,permission_version)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (tenant_id,owner_user_id,event_key) DO NOTHING RETURNING id""",
            (*self.owner, uuid4(), kind, key, Jsonb(payload), schema_version, user["permission_version"]))
        if created:
            return created["id"]
        existing = self._one("""SELECT id,type,payload=%s AS same_payload,schema_version FROM moneylens.outbox_events
            WHERE tenant_id=%s AND owner_user_id=%s AND event_key=%s""", (Jsonb(payload), *self.owner, key))
        if not existing["same_payload"] or (existing["type"], existing["schema_version"]) != (kind, schema_version):
            raise IdempotencyConflict("The event key already names different input")
        return existing["id"]

    def dispatch_one(self, subscriptions):
        """Fan out one event to durable consumer jobs in this same transaction."""
        self._check()
        if not subscriptions or len(subscriptions) > 32:
            raise ValueError("Register 1-32 event types explicitly")
        for event_type, consumers in subscriptions.items():
            if not NAME.fullmatch(event_type) or not consumers or len(consumers) > 32 or len(set(consumers)) != len(consumers):
                raise ValueError("Each event needs 1-32 distinct registered consumers")
            if any(not NAME.fullmatch(consumer) for consumer in consumers):
                raise ValueError("Invalid consumer type")
        event = self._one("""SELECT * FROM moneylens.outbox_events
            WHERE tenant_id=%s AND owner_user_id=%s AND published_at IS NULL AND discarded_at IS NULL AND type=ANY(%s)
            ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1""", (*self.owner, list(subscriptions)))
        if not event:
            return None
        user = self._one("SELECT active,permission_version FROM moneylens.users WHERE tenant_id=%s AND id=%s", self.owner)
        if not user or not user["active"] or user["permission_version"] != event["permission_version"]:
            self.connection.execute("""UPDATE moneylens.outbox_events SET discarded_at=clock_timestamp(),discard_reason='permission_changed'
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""", (*self.owner,event["id"]))
            return event["id"]
        for consumer in subscriptions[event["type"]]:
            self.enqueue(consumer, "outbox:" + str(event["id"]), {
                "event_id": str(event["id"]), "event_type": event["type"],
                "schema_version": event["schema_version"], "data": event["payload"],
            })
        self.connection.execute("""UPDATE moneylens.outbox_events SET published_at=clock_timestamp()
            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""", (*self.owner, event["id"]))
        return event["id"]

    def claim(self, kinds, *, lease_seconds=30):
        self._check()
        if not kinds or len(kinds) > 32 or any(not NAME.fullmatch(kind) for kind in kinds):
            raise ValueError("Claim only explicitly registered job types")
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= 900:
            raise ValueError("Lease must be 1-900 seconds")
        job = self._one("""SELECT * FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s
            AND type=ANY(%s) AND ((state='queued' AND available_at<=statement_timestamp())
                OR (state='running' AND lease_until<=statement_timestamp()))
            ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1""", (*self.owner, list(kinds)))
        if not job:
            return None
        user = self._one("SELECT active,permission_version FROM moneylens.users WHERE tenant_id=%s AND id=%s", self.owner)
        if not user or not user["active"] or user["permission_version"] != job["permission_version"]:
            self._terminal(job["id"], "cancelled", "permission_changed")
            return None
        if job["attempts"] >= job["max_attempts"]:
            self._terminal(job["id"], "dead_letter", "attempts_exhausted")
            return None
        token = uuid4()
        self.connection.execute("""UPDATE moneylens.jobs SET state='running',attempts=attempts+1,
            lease_token=%s,lease_until=clock_timestamp()+(%s*interval '1 second'),last_error_code=NULL
            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""", (token,lease_seconds,*self.owner,job["id"]))
        return ClaimedJob(job["id"],job["type"],job["payload"],job["schema_version"],job["attempts"]+1,token)

    def _terminal(self, job_id, state, error_code=None):
        self.connection.execute("""UPDATE moneylens.jobs SET state=%s,last_error_code=%s,
            finished_at=clock_timestamp(),lease_until=NULL,lease_token=NULL
            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""", (state,error_code,*self.owner,job_id))

    def _leased(self, job):
        self._check()
        row = self._one("""SELECT * FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s
            AND id=%s AND state='running' AND lease_token=%s AND lease_until>statement_timestamp()
            FOR UPDATE""", (*self.owner,job.id,job.lease_token))
        if not row:
            raise LostLease("Expired, cancelled or superseded job attempt")
        return row

    def heartbeat(self, job, *, lease_seconds=30):
        self._leased(job)
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= 900:
            raise ValueError("Lease must be 1-900 seconds")
        self.connection.execute("""UPDATE moneylens.jobs SET lease_until=clock_timestamp()+(%s*interval '1 second')
            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""", (lease_seconds,*self.owner,job.id))

    def complete(self, job, handler):
        """Handler database effects and completion commit together; never call external effects here."""
        row = self._leased(job)
        user = self._one("SELECT active,permission_version FROM moneylens.users WHERE tenant_id=%s AND id=%s", self.owner)
        if not user or not user["active"] or user["permission_version"] != row["permission_version"]:
            self._terminal(job.id, "cancelled", "permission_changed")
            return False
        # Handler exceptions must escape the surrounding transaction to roll back effects.
        with self.connection.transaction():
            handler(self, ClaimedJob(row['id'],row['type'],row['payload'],row['schema_version'],row['attempts'],row['lease_token']))
            self._terminal(job.id, "completed")
        return True

    def fail(self, job, error_code, *, permanent=False):
        row = self._leased(job)
        if not isinstance(error_code,str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", error_code):
            raise ValueError("Store a safe error code, never raw exception text")
        if permanent or row["attempts"] >= row["max_attempts"]:
            self._terminal(job.id, "dead_letter", error_code)
        else:
            # Positive-floor jitter and bounded backoff; database time is authoritative.
            delay = random.uniform(0.5, min(300, 2 ** row["attempts"]))
            self.connection.execute("""UPDATE moneylens.jobs SET state='queued',last_error_code=%s,
                available_at=clock_timestamp()+(%s*interval '1 second'),lease_until=NULL,lease_token=NULL
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""", (error_code,delay,*self.owner,job.id))

    def cancel(self, job_id):
        self._check()
        row = self._one("""SELECT id FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s
            AND id=%s AND state IN ('queued','running') FOR UPDATE""", (*self.owner,job_id))
        if not row:
            return False
        self._terminal(job_id, "cancelled")
        return True

    def status(self, job_id):
        self._check()
        return self._one("""SELECT id,type,state,attempts,max_attempts,available_at,lease_until,
            finished_at,last_error_code FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""", (*self.owner,job_id))
