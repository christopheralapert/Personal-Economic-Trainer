"""Scoped transactional planning receipts. No bank transfer is initiated here."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
from uuid import UUID, uuid4, uuid5

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .identity import AuthError, authorized_transaction
from .bank_access import bank_account_access, planning_sources_ready
from .jobs import JobStore
from .planning_engine import calculate_planning, propose_allocation
from .planning_inputs import PlanningInputsV1, ProtectionRouteV1
from .planning_policy import PlanningPolicyV1, utc
from .scoped_keys import DataScope


def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest()


def command_key(value):
    if not isinstance(value,str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}",value):
        raise AuthError("INVALID_IDEMPOTENCY_KEY",422)


def versions(data,plan):
    if any(type(value) is not int or not 1<=value<=2**53-1 for value in (data,plan)):
        raise AuthError("INVALID_PLANNING_VERSION",422)


class PlanningStore:
    """Every method owns a clean, short transaction under a server-verified principal."""
    def __init__(self,connection,user,*,clock=lambda:datetime.now(timezone.utc)):
        self.connection,self.user,self.clock = connection,user,clock
        self.owner = (user.scope.tenant_id,user.scope.user_id)

    def one(self,query,params=()):
        with self.connection.cursor(row_factory=dict_row) as cursor:
            return cursor.execute(query,params).fetchone()

    def state(self):
        return self.one("SELECT data_version,plan_version FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",self.owner)

    def plan(self,plan_id):
        row = self.one("SELECT * FROM moneylens.plans WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,plan_id))
        if row is None or row["reviewed_inputs"] is None:
            raise AuthError("NOT_FOUND",404)
        return row

    def verify_facts(self,inputs,policy,now):
        planning_sources_ready(self.connection,self.user,now)
        bank_account_access(self.connection,self.user,[item.id for item in inputs.accounts],now=now)
        ids = [item.id for item in inputs.accounts]
        rows = self.connection.execute("""SELECT id,currency,account_type,included FROM moneylens.accounts
            WHERE tenant_id=%s AND owner_user_id=%s AND id=ANY(%s)""",(*self.owner,ids)).fetchall()
        found = {row[0]:row[1:] for row in rows}
        if len(found)!=len(ids) or any(found[item.id]!=(item.currency,item.account_type,True) for item in inputs.accounts):
            raise AuthError("PLANNING_SCOPE_CHANGED",409)
        snapshots = self.connection.execute("""SELECT id,account_id,amount_minor,currency,balance_kind,observed_at,pending_reflection,included_credit_minor
            FROM moneylens.analysis_balances WHERE tenant_id=%s AND owner_user_id=%s AND id=ANY(%s)""",
            (*self.owner,[item.id for item in inputs.balances])).fetchall()
        balances = {row[0]:row[1:] for row in snapshots}
        latest = dict(self.connection.execute("""SELECT chosen.account_id,snapshot.observed_at
            FROM unnest(%s::uuid[]) AS chosen(account_id) CROSS JOIN LATERAL (
                SELECT observed_at FROM moneylens.analysis_balances WHERE tenant_id=%s AND owner_user_id=%s
                AND account_id=chosen.account_id ORDER BY observed_at DESC,id DESC LIMIT 1) AS snapshot""",(ids,*self.owner)).fetchall())
        for balance in inputs.balances:
            row = balances.get(balance.id)
            expected = (balance.account_id,balance.amount_minor,balance.currency,balance.kind,balance.observed_at,balance.pending_reflection,balance.included_credit_minor)
            if row!=expected:
                raise AuthError("PLANNING_BALANCE_CHANGED",409)
            if latest.get(balance.account_id)!=balance.observed_at or now-utc(balance.observed_at)>timedelta(hours=policy.balance_maximum_age_hours):
                raise AuthError("PLANNING_BALANCE_STALE",409)
        if any(item.synced_at is None or now-utc(item.synced_at)>timedelta(hours=policy.balance_maximum_age_hours) for item in inputs.accounts if item.liquid):
            raise AuthError("PLANNING_SYNC_STALE",409)

    def record(self,action,resource,version):
        self.connection.execute("""INSERT INTO moneylens.audit_events
            (tenant_id,owner_user_id,id,action,resource_id,trace_id,metadata) VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (*self.owner,uuid4(),action,resource,uuid4(),Jsonb({"plan_version":version})))
        JobStore(self.connection,self.user.scope).emit(action,action+":"+str(resource),{"resource_id":str(resource),"plan_version":version})

    def save_inputs(self,plan_id,inputs):
        self.review_size(inputs)
        versions(inputs.data_version,inputs.plan_version)
        self.connection.execute("UPDATE moneylens.plans SET reviewed_inputs=%s,plan_version=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",
            (Jsonb(inputs.model_dump(mode="json")),inputs.plan_version,*self.owner,plan_id))
        self.connection.execute("UPDATE moneylens.user_state SET plan_version=%s WHERE tenant_id=%s AND owner_user_id=%s",
            (inputs.plan_version,*self.owner))

    @staticmethod
    def review_size(inputs):
        if len(json.dumps(inputs.model_dump(mode="json")).encode())>245760:
            raise AuthError("PLANNING_REVIEW_TOO_LARGE",422)

    def replay_creation(self,*,key,digest):
        """Replay an already authorized command before rebuilding clock-dependent facts."""
        command_key(key)
        with authorized_transaction(self.connection,self.user):
            previous = self.one("SELECT id,creation_fingerprint FROM moneylens.plans WHERE tenant_id=%s AND owner_user_id=%s AND creation_key=%s",(*self.owner,key))
            if previous is None:
                return None
            if previous["creation_fingerprint"]!=digest:
                raise AuthError("IDEMPOTENCY_CONFLICT",409)
            return self.view(self.plan(previous["id"]),utc(self.clock()))

    def create(self,inputs:PlanningInputsV1,policy:PlanningPolicyV1,*,key,command_digest=None):
        command_key(key)
        # Optional digest is computed by the trusted review service, never supplied
        # as browser authority. It excludes the server's changing calculation clock.
        if command_digest is not None and not re.fullmatch(r"[0-9a-f]{64}",command_digest):
            raise ValueError("Invalid server command digest")
        digest = command_digest or fingerprint({"inputs":inputs.model_dump(mode="json"),"policy":policy.model_dump(mode="json")})
        now = utc(self.clock())
        with authorized_transaction(self.connection,self.user,write=True):
            previous = self.one("SELECT id,creation_fingerprint FROM moneylens.plans WHERE tenant_id=%s AND owner_user_id=%s AND creation_key=%s",(*self.owner,key))
            if previous:
                if previous["creation_fingerprint"]!=digest:
                    raise AuthError("IDEMPOTENCY_CONFLICT",409)
                return self.view(self.plan(previous["id"]),now)
            state = self.state()
            if (inputs.data_version,inputs.plan_version)!=(state["data_version"],state["plan_version"]):
                raise AuthError("PLANNING_VERSION_CHANGED",409)
            if not timedelta(0)<=now-utc(inputs.as_of)<=timedelta(minutes=5):
                raise AuthError("PLANNING_QUOTE_TIME_INVALID",409)
            if self.one("SELECT id FROM moneylens.allocations WHERE tenant_id=%s AND owner_user_id=%s AND state='active' LIMIT 1",self.owner):
                raise AuthError("ACTIVE_ALLOCATIONS_REQUIRE_REVIEW",409)
            self.verify_facts(inputs,policy,now)
            stored = inputs.model_copy(update={"plan_version":state["plan_version"]+1})
            self.review_size(stored)
            outcome = calculate_planning(stored,policy)
            if outcome.status!="estimated":
                raise AuthError("PLANNING_INPUTS_BLOCKED",409)
            plan_id = uuid4()
            age = timedelta(hours=policy.balance_maximum_age_hours)
            expires = min([utc(stored.as_of)+timedelta(minutes=5)]+[utc(item.observed_at)+age for item in inputs.balances]
                +[utc(item.synced_at)+age for item in inputs.accounts if item.liquid])
            self.connection.execute("UPDATE moneylens.plans SET state='superseded' WHERE tenant_id=%s AND owner_user_id=%s AND state='active'",self.owner)
            self.connection.execute("""INSERT INTO moneylens.plans
                (tenant_id,owner_user_id,id,plan_version,data_version,starts_at,through_at,state,reviewed_inputs,planning_policy,
                permission_version,quote_expires_at,creation_key,creation_fingerprint)
                VALUES (%s,%s,%s,%s,%s,%s,%s,'active',%s,%s,%s,%s,%s,%s)""",
                (*self.owner,plan_id,stored.plan_version,stored.data_version,stored.as_of,outcome.prepared.period.protection_through,
                    Jsonb(stored.model_dump(mode="json")),Jsonb(policy.model_dump(mode="json")),self.user.permission_version,expires,key,digest))
            for account in inputs.accounts:
                self.connection.execute("INSERT INTO moneylens.plan_accounts (tenant_id,owner_user_id,id,plan_id,account_id) VALUES (%s,%s,%s,%s,%s)",
                    (*self.owner,uuid5(plan_id,str(account.id)),plan_id,account.id))
            self.save_inputs(plan_id,stored)
            self.record("planning.created",plan_id,stored.plan_version)
            return self.view(self.plan(plan_id),now)

    def usable(self,row,now,inputs,policy):
        current = self.state()
        usable = row["state"]=="active" and row["quote_expires_at"]>now and row["permission_version"]==self.user.permission_version and (
            row["data_version"],row["plan_version"])==(current["data_version"],current["plan_version"])
        if usable:
            try:
                self.verify_facts(inputs,policy,now)
            except AuthError:
                usable = False
        return usable

    def view(self,row,now):
        inputs,policy = PlanningInputsV1.model_validate(row["reviewed_inputs"]),PlanningPolicyV1.model_validate(row["planning_policy"])
        usable=self.usable(row,now,inputs,policy)
        return {"id":row["id"],"state":row["state"],"data_version":row["data_version"],"plan_version":row["plan_version"],
            "as_of":inputs.as_of,"source":inputs.source,"balance_snapshot_ids":[item.id for item in inputs.balances],
            "expires_at":row["quote_expires_at"],"current":usable,
            "calculation":calculate_planning(inputs,policy) if usable else None}

    def read(self,plan_id):
        with authorized_transaction(self.connection,self.user):
            return self.view(self.plan(plan_id),utc(self.clock()))

    def current(self):
        with authorized_transaction(self.connection,self.user):
            row = self.one("""SELECT * FROM moneylens.plans WHERE tenant_id=%s AND owner_user_id=%s
                AND state='active' AND reviewed_inputs IS NOT NULL""",self.owner)
            return self.view(row,utc(self.clock())) if row else None

    def read_receipt(self,plan_id,allocation_id):
        with authorized_transaction(self.connection,self.user):
            row = self.allocation(plan_id,allocation_id)
            if row is None:
                raise AuthError("NOT_FOUND",404)
            return self.receipt(row)

    def review(self,plan_id):
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            row = self.plan(plan_id)
            inputs=PlanningInputsV1.model_validate(row["reviewed_inputs"])
            bank_account_access(self.connection,self.user,[item.id for item in inputs.accounts],now=utc(self.clock()))
            return {"plan_id":row["id"],"current":self.view(row,utc(self.clock()))["current"],
                "inputs":inputs,
                "policy":PlanningPolicyV1.model_validate(row["planning_policy"])}

    def receipts(self,plan_id,codec,*,cursor=None,limit=20):
        if type(limit) is not int or not 1<=limit<=50:
            raise AuthError("INVALID_PAGE_SIZE",422)
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            self.plan(plan_id)
            state = self.state()
            scope = DataScope(self.user.scope,self.user.permission_version,state["data_version"],state["plan_version"],
                (),"EUR",{"plan_id":str(plan_id)})
            namespace = "planning.allocations.page.v1"
            condition,params = "",[*self.owner,plan_id]
            if cursor:
                position = codec.decode(cursor,scope,namespace=namespace)
                try:
                    if set(position)!={"accepted_at","id"}:
                        raise ValueError()
                    instant,identifier = datetime.fromisoformat(position["accepted_at"]),UUID(position["id"])
                    if instant.utcoffset() is None:
                        raise ValueError()
                except (ValueError,TypeError,KeyError,AttributeError):
                    raise AuthError("INVALID_CURSOR",400) from None
                condition = " AND (a.accepted_at,a.id)<(%s,%s)"
                params.extend((instant,identifier))
            with self.connection.cursor(row_factory=dict_row) as query:
                rows = query.execute("""SELECT a.*,r.account_id,r.consumed_minor,r.released_minor
                    FROM moneylens.allocations a JOIN moneylens.reserves r USING (tenant_id,owner_user_id)
                    WHERE r.id=a.reserve_id AND a.tenant_id=%s AND a.owner_user_id=%s AND a.plan_id=%s"""+condition+
                    " ORDER BY a.accepted_at DESC,a.id DESC LIMIT %s",(*params,limit+1)).fetchall()
            visible = rows[:limit]
            next_cursor = codec.encode(scope,{"accepted_at":visible[-1]["accepted_at"].isoformat(),"id":str(visible[-1]["id"])},
                namespace=namespace) if len(rows)>limit else None
            return {"rows":[self.receipt(row) for row in visible],"next_cursor":next_cursor,**state}

    def allocation(self,plan_id,allocation_id=None,*,key=None):
        condition,parameter = ("a.id=%s",allocation_id) if allocation_id is not None else ("a.idempotency_key=%s",key)
        return self.one("""SELECT a.*,r.account_id,r.consumed_minor,r.released_minor FROM moneylens.allocations a
            JOIN moneylens.reserves r USING (tenant_id,owner_user_id)
            WHERE r.id=a.reserve_id AND a.tenant_id=%s AND a.owner_user_id=%s AND a.plan_id=%s AND """+condition,
            (*self.owner,plan_id,parameter))

    def receipt(self,row):
        return {"id":row["id"],"plan_id":row["plan_id"],"reserve_id":row["reserve_id"],"account_id":row["account_id"],
            "amount_minor":row["amount_minor"],"currency":row["currency"],"state":row["state"],
            "accepted_plan_version":row["accepted_plan_version"],"acceptance_snapshot":row["acceptance_snapshot"],
            "accepted_at":row["accepted_at"],"released_at":row["released_at"],"bank_transfer_executed":False}

    def accept(self,plan_id,*,key,expected_data_version,expected_plan_version,account_id,amount_minor,desired_discretionary_minor):
        command_key(key)
        versions(expected_data_version,expected_plan_version)
        if any(type(value) is not int or value<0 or value>2**53-1 for value in (amount_minor,desired_discretionary_minor)) or amount_minor==0:
            raise AuthError("INVALID_ALLOCATION_AMOUNT",422)
        request = {"data_version":expected_data_version,"plan_version":expected_plan_version,"account_id":str(account_id),
            "amount_minor":amount_minor,"desired_discretionary_minor":desired_discretionary_minor}
        digest,now = fingerprint(request),utc(self.clock())
        with authorized_transaction(self.connection,self.user,write=True):
            previous = self.allocation(plan_id,key=key)
            if previous:
                if previous["request_fingerprint"]!=digest:
                    raise AuthError("IDEMPOTENCY_CONFLICT",409)
                return self.receipt(previous)
            row,state = self.plan(plan_id),self.state()
            if (expected_data_version,expected_plan_version)!=(state["data_version"],state["plan_version"]) or (
                row["data_version"],row["plan_version"])!=(expected_data_version,expected_plan_version):
                raise AuthError("PLANNING_VERSION_CHANGED",409)
            if row["state"]!="active" or row["quote_expires_at"]<=now or row["permission_version"]!=self.user.permission_version:
                raise AuthError("PLANNING_QUOTE_EXPIRED",409)
            inputs,policy = PlanningInputsV1.model_validate(row["reviewed_inputs"]),PlanningPolicyV1.model_validate(row["planning_policy"])
            self.verify_facts(inputs,policy,now)
            outcome = calculate_planning(inputs,policy)
            proposal = propose_allocation(outcome,desired_discretionary_minor=desired_discretionary_minor,chosen_savings_minor=amount_minor)
            if proposal.status!="estimated":
                raise AuthError("SAVINGS_EXCEED_CAPACITY",409)
            capacity = next((item.forecast.surplus_minor for item in outcome.baseline.accounts if item.account_id==account_id),None)
            if capacity is None or amount_minor>capacity:
                raise AuthError("ALLOCATION_ACCOUNT_CAPACITY",409)
            protection = next(item for item in inputs.protections if item.kind=="savings")
            self.adjust(protection,account_id,amount_minor)
            inputs.plan_version += 1
            reserve_id,allocation_id = uuid4(),uuid4()
            self.connection.execute("""INSERT INTO moneylens.reserves (tenant_id,owner_user_id,id,account_id,kind,amount_minor,currency)
                VALUES (%s,%s,%s,%s,'savings',%s,'EUR')""",(*self.owner,reserve_id,account_id,amount_minor))
            snapshot = {"data_version":expected_data_version,"plan_version":inputs.plan_version,
                "surplus_before_minor":outcome.amount_minor,"remaining_spending_at_acceptance_minor":proposal.remaining_spending_minor,
                "desired_discretionary_minor":desired_discretionary_minor,"as_of":inputs.as_of.isoformat()}
            self.connection.execute("""INSERT INTO moneylens.allocations
                (tenant_id,owner_user_id,id,plan_id,reserve_id,amount_minor,currency,idempotency_key,accepted_plan_version,request_fingerprint,acceptance_snapshot,accepted_at)
                VALUES (%s,%s,%s,%s,%s,%s,'EUR',%s,%s,%s,%s,%s)""",
                (*self.owner,allocation_id,plan_id,reserve_id,amount_minor,key,inputs.plan_version,digest,Jsonb(snapshot),now))
            self.save_inputs(plan_id,inputs)
            self.record("planning.allocated",allocation_id,inputs.plan_version)
            return self.receipt(self.allocation(plan_id,allocation_id))

    @staticmethod
    def adjust(protection,account_id,change):
        routes = {item.account_id:item.amount_minor for item in protection.routes}
        routes[account_id] = routes.get(account_id,0)+change
        total = protection.amount_minor+change
        if not 0<=total<=2**53-1 or routes[account_id]<0:
            raise AuthError("RESERVE_RECONCILIATION_REQUIRED",409)
        protection.amount_minor = total
        protection.routes = [ProtectionRouteV1(account_id=key,amount_minor=value) for key,value in sorted(routes.items(),key=lambda item:str(item[0])) if value]

    def release(self,plan_id,allocation_id,*,key,expected_data_version,expected_plan_version):
        command_key(key)
        versions(expected_data_version,expected_plan_version)
        digest = fingerprint({"allocation_id":str(allocation_id),"data_version":expected_data_version,"plan_version":expected_plan_version})
        now = utc(self.clock())
        with authorized_transaction(self.connection,self.user,write=True):
            allocation = self.allocation(plan_id,allocation_id)
            if allocation is None:
                raise AuthError("NOT_FOUND",404)
            if allocation["state"]=="released":
                if allocation["release_key"]!=key or allocation["release_fingerprint"]!=digest:
                    raise AuthError("IDEMPOTENCY_CONFLICT",409)
                return self.receipt(allocation)
            state,row = self.state(),self.plan(plan_id)
            if (state["data_version"],state["plan_version"])!=(expected_data_version,expected_plan_version) or row["plan_version"]!=expected_plan_version:
                raise AuthError("PLANNING_VERSION_CHANGED",409)
            if allocation["consumed_minor"] or allocation["released_minor"]:
                raise AuthError("RESERVE_RECONCILIATION_REQUIRED",409)
            conflict = self.one("SELECT id FROM moneylens.allocations WHERE tenant_id=%s AND owner_user_id=%s AND plan_id=%s AND release_key=%s",(*self.owner,plan_id,key))
            if conflict:
                raise AuthError("IDEMPOTENCY_CONFLICT",409)
            inputs = PlanningInputsV1.model_validate(row["reviewed_inputs"])
            self.adjust(next(item for item in inputs.protections if item.kind=="savings"),allocation["account_id"],-allocation["amount_minor"])
            inputs.plan_version += 1
            self.connection.execute("UPDATE moneylens.reserves SET released_minor=amount_minor WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",
                (*self.owner,allocation["reserve_id"]))
            self.connection.execute("UPDATE moneylens.allocations SET state='released',released_at=%s,release_key=%s,release_fingerprint=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",
                (now,key,digest,*self.owner,allocation_id))
            self.save_inputs(plan_id,inputs)
            self.record("planning.released",allocation_id,inputs.plan_version)
            return self.receipt(self.allocation(plan_id,allocation_id))
