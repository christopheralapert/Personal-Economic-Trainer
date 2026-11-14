"""Owned, optimistic and replayable coaching opt-in; no financial effects."""
from datetime import datetime,timedelta,timezone
from uuid import UUID,uuid4,uuid5

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .coaching import CoachingCommandReceiptV1,CoachingPreferencesViewV1,CoachingSnapshotV1,SetCoachingPreferencesV1,coaching_state
from .identity import AuthError,authorized_transaction
from .jobs import JobStore
from .planning_store import fingerprint

NAMESPACE=UUID("140d51e6-a0f5-4f6f-bf58-68e861825235")


class CoachingStore:
    def __init__(self,connection,user,*,clock=lambda:datetime.now(timezone.utc)):
        self.connection,self.user,self.clock=connection,user,clock
        self.owner=(user.scope.tenant_id,user.scope.user_id)

    def one(self,query,params=()):
        with self.connection.cursor(row_factory=dict_row) as cursor: return cursor.execute(query,params).fetchone()

    def snapshot(self):
        row=self.one("SELECT * FROM moneylens.coaching_preferences WHERE tenant_id=%s AND owner_user_id=%s",self.owner)
        if row: return CoachingSnapshotV1(**{name:row[name] for name in CoachingSnapshotV1.model_fields})
        return CoachingSnapshotV1(id=uuid5(NAMESPACE,":".join(map(str,self.owner))),version=1,coaching_enabled=False,
            bill_insights=True,headroom_insights=True,spending_insights=True,created_at=None,updated_at=None)

    def read(self):
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            preferences=self.snapshot();now=self.clock()
            return CoachingPreferencesViewV1(**preferences.model_dump(),as_of=now,state=coaching_state(preferences,now))

    def set(self,body):
        try: body=SetCoachingPreferencesV1.model_validate(body.model_dump(mode="python"),strict=True)
        except (ValueError,AttributeError): raise AuthError("INVALID_COACHING_PREFERENCES",422) from None
        digest=fingerprint(body.model_dump(mode="json",exclude={"key"}));now=self.clock()
        with authorized_transaction(self.connection,self.user,write=True):
            previous=self.one("SELECT request_fingerprint,receipt FROM moneylens.coaching_commands WHERE tenant_id=%s AND owner_user_id=%s AND command_key=%s",(*self.owner,body.key))
            if previous:
                if previous["request_fingerprint"]!=digest: raise AuthError("IDEMPOTENCY_CONFLICT",409)
                return CoachingCommandReceiptV1.model_validate(previous["receipt"])
            current=self.snapshot()
            if body.expected_preferences_version!=current.version: raise AuthError("COACHING_VERSION_CHANGED",409)
            if current.version>=2**53-1: raise AuthError("COACHING_VERSION_EXHAUSTED",409)
            if body.paused_until is not None and not now<body.paused_until<=now+timedelta(days=365):
                raise AuthError("INVALID_COACHING_PAUSE",422)
            count=self.connection.execute("""SELECT count(*) FROM (SELECT 1 FROM moneylens.coaching_commands
                WHERE tenant_id=%s AND owner_user_id=%s AND applied_at>%s LIMIT 100) recent""",(*self.owner,now-timedelta(hours=1))).fetchone()[0]
            if count>=100: raise AuthError("COACHING_COMMAND_THROTTLED",429)
            values=body.model_dump(include=set(CoachingSnapshotV1.model_fields)-{"id","version","created_at","updated_at"})
            snapshot=CoachingSnapshotV1(**values,id=current.id,version=current.version+1,created_at=current.created_at or now,updated_at=now)
            self.connection.execute("""INSERT INTO moneylens.coaching_preferences
                (tenant_id,owner_user_id,id,version,coaching_enabled,bill_insights,headroom_insights,spending_insights,
                    timezone,quiet_start,quiet_end,paused_until,delivery_mode,created_at,updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (tenant_id,owner_user_id) DO UPDATE SET version=EXCLUDED.version,coaching_enabled=EXCLUDED.coaching_enabled,
                    bill_insights=EXCLUDED.bill_insights,headroom_insights=EXCLUDED.headroom_insights,spending_insights=EXCLUDED.spending_insights,
                    timezone=EXCLUDED.timezone,quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,paused_until=EXCLUDED.paused_until,
                    delivery_mode=EXCLUDED.delivery_mode,updated_at=EXCLUDED.updated_at""",
                (*self.owner,snapshot.id,snapshot.version,snapshot.coaching_enabled,snapshot.bill_insights,snapshot.headroom_insights,
                    snapshot.spending_insights,snapshot.timezone,snapshot.quiet_start,snapshot.quiet_end,snapshot.paused_until,
                    snapshot.delivery_mode,snapshot.created_at,snapshot.updated_at))
            receipt=CoachingCommandReceiptV1(id=uuid4(),preferences=snapshot,applied_at=now)
            self.connection.execute("""INSERT INTO moneylens.coaching_commands
                (tenant_id,owner_user_id,id,preferences_id,command_key,request_fingerprint,applied_at,receipt)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",(*self.owner,receipt.id,current.id,body.key,digest,now,Jsonb(receipt.model_dump(mode="json"))))
            metadata={"preferences_version":snapshot.version}
            self.connection.execute("""INSERT INTO moneylens.audit_events (tenant_id,owner_user_id,id,action,resource_id,trace_id,metadata)
                VALUES (%s,%s,%s,'coaching.preferences_changed',%s,%s,%s)""",(*self.owner,uuid4(),snapshot.id,uuid4(),Jsonb(metadata)))
            JobStore(self.connection,self.user.scope).emit("coaching.preferences_changed","coaching."+str(receipt.id),
                {"preferences_id":str(snapshot.id),**metadata})
            return receipt
