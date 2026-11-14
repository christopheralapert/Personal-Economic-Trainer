"""Owned, replayable goal metadata; financial reservations remain separate."""
from datetime import datetime,timedelta,timezone
import json
from uuid import uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from .allocation_contracts import AllocationReceiptV1
from .goals import (CreateGoalV1,GoalAllocationCommandReceiptV1,GoalAllocationPageV1,GoalAllocationPositionV1,
    GoalCommandReceiptV1,GoalPagePositionV1,GoalPageV1,GoalSnapshotV1,GoalVersionedCommandV1,GoalViewV1,
    ReviseGoalV1,SetGoalStateV1,UnlinkGoalAllocationV1,goal_progress)
from .identity import AuthError,authorized_transaction
from .jobs import JobStore
from .planning_store import PlanningStore,fingerprint
from .scoped_keys import DataScope

MAX_VERSION=2**53-1


class GoalStore:
    def __init__(self,connection,user,*,clock=lambda:datetime.now(timezone.utc)):
        self.connection,self.user,self.clock=connection,user,clock
        self.owner=(user.scope.tenant_id,user.scope.user_id)

    def one(self,query,params=()):
        with self.connection.cursor(row_factory=dict_row) as cursor:
            return cursor.execute(query,params).fetchone()

    def state(self):
        return self.one("SELECT goal_version,data_version,plan_version FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",self.owner)

    def goal(self,goal_id):
        row=self.one("SELECT * FROM moneylens.goals WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,goal_id))
        if row is None: raise AuthError("NOT_FOUND",404)
        return row

    @staticmethod
    def snapshot(row):
        return GoalSnapshotV1(**{field:row[field] for field in GoalSnapshotV1.model_fields})

    def views(self,rows,state,now):
        ids=[row["id"] for row in rows]
        # One bounded set query, never one query per listed goal. Confirmed
        # savings are deliberately not inferred from balances or reservations.
        recorded=self.connection.execute("""SELECT a.goal_id,sum(r.amount_minor-r.consumed_minor-r.released_minor),
            count(*) FILTER (WHERE a.currency<>g.currency OR r.currency<>g.currency
                OR c.currency<>g.currency OR a.amount_minor<>r.amount_minor OR r.kind<>'savings')
            FROM moneylens.allocations a JOIN moneylens.goals g
                ON (g.tenant_id,g.owner_user_id,g.id)=(a.tenant_id,a.owner_user_id,a.goal_id)
            JOIN moneylens.reserves r ON (r.tenant_id,r.owner_user_id,r.id)=(a.tenant_id,a.owner_user_id,a.reserve_id)
            JOIN moneylens.accounts c ON (c.tenant_id,c.owner_user_id,c.id)=(r.tenant_id,r.owner_user_id,r.account_id)
            WHERE a.tenant_id=%s AND a.owner_user_id=%s AND a.goal_id=ANY(%s::uuid[]) AND a.state='active'
            GROUP BY a.goal_id""",(*self.owner,ids)).fetchall() if ids else []
        progress={goal_id:(int(amount),bad==0) for goal_id,amount,bad in recorded}
        result=[]
        for row in rows:
            goal=self.snapshot(row);amount,consistent=progress.get(goal.id,(0,True))
            result.append(GoalViewV1(**goal.model_dump(),as_of=now,collection_version=state["goal_version"],
                data_version=state["data_version"],plan_version=state["plan_version"],
                progress=goal_progress(goal,reserved=amount,consistent=consistent,now=now)))
        return result

    def read(self,goal_id):
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            return self.views([self.goal(goal_id)],self.state(),self.clock())[0]

    def page(self,codec,*,state=None,currency=None,cursor=None,limit=50):
        if type(limit) is not int or not 1<=limit<=100: raise AuthError("INVALID_GOAL_PAGE",422)
        now=self.clock()
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            versions=self.state()
            scope=DataScope(self.user.scope,self.user.permission_version,versions["data_version"],versions["plan_version"],(),currency or "ALL",
                {"goal_collection_version":versions["goal_version"],"state":state,"currency":currency})
            where="tenant_id=%s AND owner_user_id=%s";params=list(self.owner)
            if state is None: where+=" AND state<>'removed'"
            else: where+=" AND state=%s";params.append(state)
            if currency is not None: where+=" AND currency=%s";params.append(currency)
            if cursor:
                position=codec.decode(cursor,scope,namespace="goals.page.v1")
                try: after=GoalPagePositionV1.model_validate_json(json.dumps(position),strict=True)
                except (ValueError,ValidationError): raise AuthError("INVALID_CURSOR",400) from None
                where+=" AND (priority,deadline,id)>(%s,%s,%s)";params.extend([after.priority,after.deadline,after.id])
            with self.connection.cursor(row_factory=dict_row) as query:
                rows=query.execute("SELECT * FROM moneylens.goals WHERE "+where+" ORDER BY priority,deadline,id LIMIT %s",[*params,limit+1]).fetchall()
            selected=rows[:limit]
            next_cursor=codec.encode(scope,{"priority":selected[-1]["priority"],"deadline":selected[-1]["deadline"].isoformat(),"id":str(selected[-1]["id"])},
                namespace="goals.page.v1") if len(rows)>limit else None
            return GoalPageV1(rows=self.views(selected,versions,now),next_cursor=next_cursor,collection_version=versions["goal_version"],
                data_version=versions["data_version"],plan_version=versions["plan_version"],as_of=now)

    def replay(self,key,digest):
        previous=self.one("SELECT request_fingerprint,receipt FROM moneylens.goal_commands WHERE tenant_id=%s AND owner_user_id=%s AND command_key=%s",(*self.owner,key))
        if previous is None: return None
        if previous["request_fingerprint"]!=digest: raise AuthError("IDEMPOTENCY_CONFLICT",409)
        schema=GoalAllocationCommandReceiptV1 if previous["receipt"].get("action") in ("link_allocation","unlink_allocation") else GoalCommandReceiptV1
        return schema.model_validate(previous["receipt"])

    def budget(self,now):
        count=self.connection.execute("""SELECT count(*) FROM (SELECT 1 FROM moneylens.goal_commands
            WHERE tenant_id=%s AND owner_user_id=%s AND applied_at>%s LIMIT 100) recent""",(*self.owner,now-timedelta(hours=1))).fetchone()[0]
        if count>=100: raise AuthError("GOAL_COMMAND_THROTTLED",429)

    def finish(self,action,row,key,digest,now,state,*,allocation_id=None):
        if state["goal_version"]>=MAX_VERSION: raise AuthError("GOAL_VERSION_EXHAUSTED",409)
        version=state["goal_version"]+1
        schema=GoalAllocationCommandReceiptV1 if allocation_id is not None else GoalCommandReceiptV1
        extra={"allocation_id":allocation_id} if allocation_id is not None else {}
        receipt=schema(id=uuid4(),action=action,goal=self.snapshot(row),collection_version=version,applied_at=now,**extra)
        metadata={"goal_version":row["version"],"collection_version":version}
        if allocation_id is not None: metadata["allocation_id"]=str(allocation_id)
        self.connection.execute("UPDATE moneylens.user_state SET goal_version=%s WHERE tenant_id=%s AND owner_user_id=%s",(version,*self.owner))
        self.connection.execute("""INSERT INTO moneylens.goal_commands
            (tenant_id,owner_user_id,id,goal_id,command_key,action,request_fingerprint,applied_at,receipt)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",(*self.owner,receipt.id,row["id"],key,action,digest,now,Jsonb(receipt.model_dump(mode="json"))))
        self.connection.execute("""INSERT INTO moneylens.audit_events
            (tenant_id,owner_user_id,id,action,resource_id,trace_id,metadata) VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (*self.owner,uuid4(),"goal."+action,row["id"],uuid4(),Jsonb(metadata)))
        JobStore(self.connection,self.user.scope).emit("goal."+action,"goal."+str(receipt.id),
            {"goal_id":str(row["id"]),**metadata})
        return receipt

    def allocations(self,goal_id,codec,*,cursor=None,limit=50):
        if type(limit) is not int or not 1<=limit<=100: raise AuthError("INVALID_GOAL_PAGE",422)
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            goal=self.goal(goal_id);versions=self.state();now=self.clock()
            scope=DataScope(self.user.scope,self.user.permission_version,versions["data_version"],versions["plan_version"],(),goal["currency"],
                {"goal_id":str(goal_id),"goal_version":goal["version"],"goal_collection_version":versions["goal_version"]})
            namespace="goals.allocations.v1";condition="";params=[*self.owner,goal_id]
            if cursor:
                position=codec.decode(cursor,scope,namespace=namespace)
                try: after=GoalAllocationPositionV1.model_validate_json(json.dumps(position),strict=True)
                except (ValueError,ValidationError): raise AuthError("INVALID_CURSOR",400) from None
                condition=" AND (a.accepted_at,a.id)<(%s,%s)";params.extend([after.accepted_at,after.id])
            with self.connection.cursor(row_factory=dict_row) as query:
                rows=query.execute("""SELECT a.*,r.account_id FROM moneylens.allocations a
                    JOIN moneylens.reserves r ON (r.tenant_id,r.owner_user_id,r.id)=(a.tenant_id,a.owner_user_id,a.reserve_id)
                    WHERE a.tenant_id=%s AND a.owner_user_id=%s AND a.goal_id=%s"""+condition+
                    " ORDER BY a.accepted_at DESC,a.id DESC LIMIT %s",[*params,limit+1]).fetchall()
            selected=rows[:limit]
            next_cursor=codec.encode(scope,{"accepted_at":selected[-1]["accepted_at"].isoformat(),"id":str(selected[-1]["id"])},
                namespace=namespace) if len(rows)>limit else None
            repository=PlanningStore(self.connection,self.user)
            try:
                return GoalAllocationPageV1(goal_id=goal_id,goal_version=goal["version"],rows=[repository.receipt(row) for row in selected],
                    next_cursor=next_cursor,collection_version=versions["goal_version"],data_version=versions["data_version"],
                    plan_version=versions["plan_version"],as_of=now)
            except ValidationError: raise AuthError("GOAL_RESERVATION_RECONCILIATION_REQUIRED",409) from None

    def assign(self,goal_id,allocation_id,body,*,unlink=False):
        schema=UnlinkGoalAllocationV1 if unlink else GoalVersionedCommandV1
        try: body=schema.model_validate(body.model_dump(mode="python"),strict=True)
        except (ValueError,AttributeError): raise AuthError("INVALID_GOAL_COMMAND",422) from None
        action="unlink_allocation" if unlink else "link_allocation"
        digest=fingerprint({"action":action,"goal_id":str(goal_id),"allocation_id":str(allocation_id),"body":body.model_dump(mode="json",exclude={"key"})})
        now=self.clock()
        with authorized_transaction(self.connection,self.user,write=True):
            previous=self.replay(body.key,digest)
            if previous: return previous
            goal=self.goal(goal_id)
            allocation=self.one("""SELECT a.*,r.account_id,r.kind,r.amount_minor AS reserve_amount,r.currency AS reserve_currency,
                r.consumed_minor,r.released_minor,c.currency AS account_currency FROM moneylens.allocations a
                JOIN moneylens.reserves r ON (r.tenant_id,r.owner_user_id,r.id)=(a.tenant_id,a.owner_user_id,a.reserve_id)
                JOIN moneylens.accounts c ON (c.tenant_id,c.owner_user_id,c.id)=(r.tenant_id,r.owner_user_id,r.account_id)
                WHERE a.tenant_id=%s AND a.owner_user_id=%s AND a.id=%s""",(*self.owner,allocation_id))
            if allocation is None: raise AuthError("NOT_FOUND",404)
            try: AllocationReceiptV1.model_validate(PlanningStore(self.connection,self.user).receipt(allocation))
            except ValidationError: raise AuthError("GOAL_RESERVATION_RECONCILIATION_REQUIRED",409) from None
            if goal["version"]!=body.expected_goal_version: raise AuthError("GOAL_VERSION_CHANGED",409)
            if goal["state"]=="removed": raise AuthError("GOAL_REMOVED",409)
            if goal["version"]>=MAX_VERSION: raise AuthError("GOAL_VERSION_EXHAUSTED",409)
            if not unlink and goal["state"]!="active": raise AuthError("GOAL_NOT_ACTIVE",409)
            if allocation["state"]!="active": raise AuthError("GOAL_ALLOCATION_NOT_ACTIVE",409)
            if (allocation["kind"]!="savings" or allocation["consumed_minor"] or allocation["released_minor"]
                or allocation["amount_minor"]!=allocation["reserve_amount"]
                or any(allocation[field]!=goal["currency"] for field in ("currency","reserve_currency","account_currency"))):
                raise AuthError("GOAL_RESERVATION_RECONCILIATION_REQUIRED",409)
            if unlink:
                if allocation["goal_id"]!=goal_id: raise AuthError("GOAL_ALLOCATION_NOT_LINKED",409)
            else:
                if allocation["goal_id"] is not None: raise AuthError("GOAL_ALLOCATION_ALREADY_LINKED",409)
                count=self.connection.execute("""SELECT count(*) FROM (SELECT 1 FROM moneylens.allocations
                    WHERE tenant_id=%s AND owner_user_id=%s AND goal_id=%s LIMIT 200) assigned""",(*self.owner,goal_id)).fetchone()[0]
                if count>=200: raise AuthError("GOAL_ALLOCATION_LIMIT_REACHED",409)
                progress=self.views([goal],self.state(),now)[0].progress
                if progress.status!="available" or progress.recorded_reserved_minor+allocation["amount_minor"]>MAX_VERSION:
                    raise AuthError("GOAL_RESERVATION_RECONCILIATION_REQUIRED",409)
            self.budget(now);state=self.state()
            # This changes association only. The existing reserve, acceptance
            # snapshot, financial versions and available capacity stay intact.
            self.connection.execute("UPDATE moneylens.allocations SET goal_id=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",
                (None if unlink else goal_id,*self.owner,allocation_id))
            self.connection.execute("UPDATE moneylens.goals SET version=version+1,updated_at=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",
                (now,*self.owner,goal_id))
            return self.finish(action,self.goal(goal_id),body.key,digest,now,state,allocation_id=allocation_id)

    def create(self,body):
        try: body=CreateGoalV1.model_validate(body.model_dump(mode="python"),strict=True)
        except (ValueError,AttributeError): raise AuthError("INVALID_GOAL_COMMAND",422) from None
        digest=fingerprint({"action":"create","body":body.model_dump(mode="json",exclude={"key"})})
        now=self.clock()
        with authorized_transaction(self.connection,self.user,write=True):
            previous=self.replay(body.key,digest)
            if previous: return previous
            self.budget(now)
            count=self.connection.execute("SELECT count(*) FROM (SELECT 1 FROM moneylens.goals WHERE tenant_id=%s AND owner_user_id=%s LIMIT 1000) owned",self.owner).fetchone()[0]
            if count>=1000: raise AuthError("GOAL_LIMIT_REACHED",409)
            goal_id=uuid4();state=self.state()
            self.connection.execute("""INSERT INTO moneylens.goals
                (tenant_id,owner_user_id,id,name,target_minor,currency,deadline,state,priority,created_at,updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,'active',%s,%s,%s)""",
                (*self.owner,goal_id,body.name,body.target_minor,body.currency,body.deadline,body.priority,now,now))
            return self.finish("create",self.goal(goal_id),body.key,digest,now,state)

    def mutate(self,goal_id,body,*,action):
        schema={"revise":ReviseGoalV1,"set_state":SetGoalStateV1,"remove":GoalVersionedCommandV1}.get(action)
        if schema is None: raise ValueError("Unregistered goal command")
        try: body=schema.model_validate(body.model_dump(mode="python"),strict=True)
        except (ValueError,AttributeError): raise AuthError("INVALID_GOAL_COMMAND",422) from None
        digest=fingerprint({"action":action,"goal_id":str(goal_id),"body":body.model_dump(mode="json",exclude={"key"})})
        now=self.clock()
        with authorized_transaction(self.connection,self.user,write=True):
            previous=self.replay(body.key,digest)
            if previous: return previous
            row=self.goal(goal_id)
            if row["version"]!=body.expected_goal_version: raise AuthError("GOAL_VERSION_CHANGED",409)
            if row["state"]=="removed": raise AuthError("GOAL_REMOVED",409)
            if row["version"]>=MAX_VERSION: raise AuthError("GOAL_VERSION_EXHAUSTED",409)
            self.budget(now);state=self.state()
            if action=="revise":
                if body.currency!=row["currency"] and self.one("SELECT id FROM moneylens.allocations WHERE tenant_id=%s AND owner_user_id=%s AND goal_id=%s LIMIT 1",(*self.owner,goal_id)):
                    raise AuthError("GOAL_CURRENCY_LINKED",409)
                self.connection.execute("""UPDATE moneylens.goals SET name=%s,target_minor=%s,currency=%s,deadline=%s,priority=%s,
                    version=version+1,updated_at=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                    (body.name,body.target_minor,body.currency,body.deadline,body.priority,now,*self.owner,goal_id))
            elif action in ("set_state","remove"):
                if action=="remove" and self.one("SELECT id FROM moneylens.allocations WHERE tenant_id=%s AND owner_user_id=%s AND goal_id=%s AND state='active' LIMIT 1",(*self.owner,goal_id)):
                    raise AuthError("GOAL_ALLOCATION_REVIEW_REQUIRED",409)
                self.connection.execute("""UPDATE moneylens.goals SET state=%s,version=version+1,updated_at=%s
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",("removed" if action=="remove" else body.state,now,*self.owner,goal_id))
            else: raise ValueError("Unregistered goal command")
            return self.finish(action,self.goal(goal_id),body.key,digest,now,state)
