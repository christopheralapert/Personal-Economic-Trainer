"""Fenced durable coaching snapshots, exact dismissals and bounded refresh jobs."""
from datetime import date,datetime,timedelta,timezone
import json
from uuid import UUID,uuid4,uuid5
from zoneinfo import ZoneInfo

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from .analysis_inputs import AnalysisWindowV1
from .bank_access import bank_account_access
from .bank_sources import history_coverage,source_evidence
from .coaching import coaching_allows,coaching_state
from .coaching_store import CoachingStore
from .identity import AuthError,authorized_transaction
from .insight_queries import planning_preview,spending_preview
from .insight_records import (DismissInsightV1,InsightCommandReceiptV1,InsightPageV1,InsightPositionV1,InsightSummaryV1,InsightViewV1,
    PlanningStoredEvidenceV1,RefreshInsightsV1,SpendingStoredEvidenceV1)
from .jobs import JobStore
from .planning_inputs import PlanningInputsV1
from .planning_policy import PlanningPolicyV1,local_boundary,utc
from .planning_store import PlanningStore,fingerprint
from .scoped_keys import DataScope

NAMESPACE=UUID("70faf2c7-bca5-4d28-af51-60746b49b246")
MAX_VERSION=2**53-1


class InsightStore:
    def __init__(self,connection,user,*,clock=lambda:datetime.now(timezone.utc),maximum_age_hours=24):
        self.connection,self.user,self.clock=connection,user,clock
        self.owner=(user.scope.tenant_id,user.scope.user_id)
        self.maximum_age_hours=maximum_age_hours

    def one(self,query,params=()):
        with self.connection.cursor(row_factory=dict_row) as cursor: return cursor.execute(query,params).fetchone()

    def state(self):
        return self.one("SELECT data_version,plan_version FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",self.owner)

    def collection_version(self):
        row=self.one("SELECT version FROM moneylens.insight_collections WHERE tenant_id=%s AND owner_user_id=%s",self.owner)
        return row["version"] if row else 1

    def advance(self):
        version=self.collection_version()
        if version>=MAX_VERSION: raise AuthError("INSIGHT_VERSION_EXHAUSTED",409)
        identifier=uuid5(NAMESPACE,":".join(map(str,self.owner)))
        self.connection.execute("""INSERT INTO moneylens.insight_collections (tenant_id,owner_user_id,id,version) VALUES (%s,%s,%s,%s)
            ON CONFLICT (tenant_id,owner_user_id) DO UPDATE SET version=EXCLUDED.version""",(*self.owner,identifier,version+1))
        return identifier,version+1

    def enqueue(self,key,*,automatic=False):
        """Requires the caller's current exclusive owner fence."""
        jobs=JobStore(self.connection,self.user.scope)
        previous=self.one("SELECT id FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s AND type='coaching.refresh' AND idempotency_key=%s",(*self.owner,key))
        if previous: return jobs.status(previous["id"])
        preferences=CoachingStore(self.connection,self.user).snapshot()
        if not preferences.coaching_enabled:
            if not automatic: raise AuthError("COACHING_NOT_ENABLED",409)
            if not self.one("SELECT id FROM moneylens.insights WHERE tenant_id=%s AND owner_user_id=%s AND status='active' LIMIT 1",self.owner): return None
        count=self.connection.execute("""SELECT count(*) FROM (SELECT 1 FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s
            AND type='coaching.refresh' AND created_at>statement_timestamp()-interval '1 hour' LIMIT 20) recent""",self.owner).fetchone()[0]
        if count>=20:
            if automatic: return None
            raise AuthError("INSIGHT_REFRESH_THROTTLED",429)
        identifier=jobs.enqueue("coaching.refresh",key,{"operation":"refresh_current"},max_attempts=3)
        return jobs.status(identifier)

    def request_refresh(self,body):
        try: body=RefreshInsightsV1.model_validate(body.model_dump(mode="python"),strict=True)
        except (ValueError,AttributeError): raise AuthError("INVALID_INSIGHT_COMMAND",422) from None
        with authorized_transaction(self.connection,self.user,write=True): return self.enqueue("manual:"+body.key)

    def refresh(self):
        """Compute and apply current facts inside a leased, exclusive owner fence."""
        now=utc(self.clock());state=self.state();preferences=CoachingStore(self.connection,self.user).snapshot();desired=[]
        if coaching_state(preferences,now).generation_active:
            if preferences.bill_insights or preferences.headroom_insights:
                preview=planning_preview(self.connection,self.user,now)
                if preview.evidence:
                    evidence=PlanningStoredEvidenceV1(policy=preview.policy,planning=preview.evidence,omitted_candidate_count=preview.omitted_candidate_count)
                    desired.extend((candidate,evidence,preview.evidence.quote_expires_at) for candidate in preview.candidates
                        if coaching_allows(preferences,candidate.kind,now))
            if preferences.spending_insights:
                today=now.astimezone(ZoneInfo("Europe/Helsinki")).date()
                body=AnalysisWindowV1(start=today-timedelta(days=30),end_exclusive=today,expected_data_version=state["data_version"])
                try: preview=spending_preview(self.connection,self.user,body,now,self.maximum_age_hours)
                except AuthError as error:
                    if error.status!=409: raise
                else:
                    evidence=SpendingStoredEvidenceV1(policy=preview.policy,comparison=preview.comparison)
                    expires=min([local_boundary(today+timedelta(days=1),ZoneInfo("Europe/Helsinki"))]+
                        [source.observed_at+timedelta(hours=self.maximum_age_hours) for source in preview.comparison.current.scope.sources if source.observed_at])
                    desired.extend((candidate,evidence,expires) for candidate in preview.candidates)
        ids=[candidate.id for candidate,_,_ in desired]
        with self.connection.cursor(row_factory=dict_row) as query:
            existing=query.execute("SELECT * FROM moneylens.insights WHERE tenant_id=%s AND owner_user_id=%s AND (status='active' OR id=ANY(%s::uuid[]))",
                (*self.owner,ids)).fetchall()
        by_id={row["id"]:row for row in existing};new_count=sum(identifier not in by_id for identifier in ids)
        if new_count:
            retained=self.connection.execute("SELECT count(*) FROM (SELECT 1 FROM moneylens.insights WHERE tenant_id=%s AND owner_user_id=%s LIMIT 1000) history",self.owner).fetchone()[0]
            if retained+new_count>1000: raise AuthError("INSIGHT_HISTORY_LIMIT_REACHED",409)
        changed=0
        superseded=[row for row in existing if row["status"]=="active" and row["id"] not in ids]
        if any(row["version"]>=MAX_VERSION for row in superseded): raise AuthError("INSIGHT_VERSION_EXHAUSTED",409)
        if superseded:
            self.connection.execute("UPDATE moneylens.insights SET status='superseded',version=version+1,updated_at=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=ANY(%s::uuid[])",
                (now,*self.owner,[row["id"] for row in superseded]))
            changed+=len(superseded)
        for candidate,evidence,expires in desired:
            previous=by_id.get(candidate.id)
            status="dismissed" if previous and previous["dismissed_at"] else "active"
            encoded=candidate.model_dump(mode="json");source=evidence.model_dump(mode="json")
            context={**state,"preferences_version":preferences.version,"permission_version":self.user.permission_version}
            digest=fingerprint({"candidate":encoded,"evidence":source,"expires_at":expires.isoformat(),**context})
            if previous and previous["fingerprint"]==digest and previous["status"]==status: continue
            if previous and previous["version"]>=MAX_VERSION: raise AuthError("INSIGHT_VERSION_EXHAUSTED",409)
            self.connection.execute("""INSERT INTO moneylens.insights (tenant_id,owner_user_id,id,kind,status,version,data_version,plan_version,
                preferences_version,permission_version,candidate,evidence,fingerprint,generated_at,expires_at,created_at,updated_at,dismissed_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (tenant_id,owner_user_id,id) DO UPDATE SET status=EXCLUDED.status,version=EXCLUDED.version,
                    data_version=EXCLUDED.data_version,plan_version=EXCLUDED.plan_version,preferences_version=EXCLUDED.preferences_version,
                    permission_version=EXCLUDED.permission_version,candidate=EXCLUDED.candidate,evidence=EXCLUDED.evidence,
                    fingerprint=EXCLUDED.fingerprint,generated_at=EXCLUDED.generated_at,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at""",
                (*self.owner,candidate.id,candidate.kind,status,previous["version"]+1 if previous else 1,state["data_version"],state["plan_version"],
                    preferences.version,self.user.permission_version,Jsonb(encoded),Jsonb(source),digest,now,expires,previous["created_at"] if previous else now,
                    now,previous["dismissed_at"] if previous else None))
            changed+=1
        if changed:
            identifier,version=self.advance()
            self.event("refreshed",identifier,{"collection_version":version,"changed_count":changed})
        return changed

    def event(self,action,identifier,metadata):
        self.connection.execute("""INSERT INTO moneylens.audit_events (tenant_id,owner_user_id,id,action,resource_id,trace_id,metadata)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",(*self.owner,uuid4(),"insights."+action,identifier,uuid4(),Jsonb(metadata)))
        JobStore(self.connection,self.user.scope).emit("insights."+action,"insights."+action+":"+str(uuid4()),{"resource_id":str(identifier),**metadata})

    def current_checks(self,rows,preferences,now,*,detailed=True):
        state=self.state()
        def eligible(row):
            return row["status"]=="active" and row["dismissed_at"] is None and row["expires_at"]>now and (
                row["data_version"],row["plan_version"],row["preferences_version"],row["permission_version"])==(
                state["data_version"],state["plan_version"],preferences.version,self.user.permission_version) and coaching_allows(preferences,row["kind"],now)
        possible=[row for row in rows if eligible(row)]
        planning_ok=False;planning_id=None
        if any(row["evidence"]["kind"]=="planning" for row in possible):
            store=PlanningStore(self.connection,self.user)
            plan=store.one("SELECT * FROM moneylens.plans WHERE tenant_id=%s AND owner_user_id=%s AND state='active' AND reviewed_inputs IS NOT NULL",self.owner)
            if plan:
                planning_id=str(plan["id"])
                planning_ok=store.usable(plan,now,PlanningInputsV1.model_validate(plan["reviewed_inputs"]),PlanningPolicyV1.model_validate(plan["planning_policy"]))
        ids=sorted({UUID(identifier) for row in possible if row["evidence"]["kind"]=="spending" for identifier in row["evidence"]["comparison"]["current"]["scope"]["account_ids"]},key=str)
        spending_ok=True;sources={}
        if ids:
            try:
                bank_account_access(self.connection,self.user,ids,now=now)
                sources=source_evidence(self.connection,self.user,ids,now=now,maximum_age_hours=self.maximum_age_hours)
            except AuthError: spending_ok=False
        result=[]
        for row in rows:
            reasons=[]
            if row["status"]!="active" or row["dismissed_at"] is not None: reasons.append("INSIGHT_NOT_ACTIVE")
            if row["expires_at"]<=now: reasons.append("INSIGHT_EVIDENCE_EXPIRED")
            if (row["data_version"],row["plan_version"],row["preferences_version"],row["permission_version"])!=(
                state["data_version"],state["plan_version"],preferences.version,self.user.permission_version): reasons.append("INSIGHT_CONTEXT_CHANGED")
            if not coaching_allows(preferences,row["kind"],now): reasons.append("COACHING_DISABLED_PAUSED_OR_KIND_DISABLED")
            if eligible(row) and row["evidence"]["kind"]=="planning" and (not planning_ok or row["evidence"]["planning"]["plan_id"]!=planning_id): reasons.append("CURRENT_PLAN_REVIEW_REQUIRED")
            if eligible(row) and row["evidence"]["kind"]=="spending" and not spending_ok: reasons.append("SPENDING_ACCESS_REVIEW_REQUIRED")
            if eligible(row) and row["evidence"]["kind"]=="spending" and spending_ok:
                comparison=row["evidence"]["comparison"];accounts=[UUID(value) for value in comparison["current"]["scope"]["account_ids"]]
                if any(history_coverage(accounts,sources,start=date.fromisoformat(comparison[window]["scope"]["start"]),
                    end_exclusive=date.fromisoformat(comparison[window]["scope"]["end_exclusive"]))!="covered_synthetic_snapshot" for window in ("current","baseline")):
                    reasons.append("SPENDING_SOURCE_REVIEW_REQUIRED")
            schema=InsightViewV1 if detailed else InsightSummaryV1
            fields={name:row[name] for name in schema.model_fields if name in row}
            extra={} if detailed else {"evidence_kind":row["evidence"]["kind"]}
            result.append(schema(**fields,current=not reasons,current_blockers=reasons,**extra))
        return result

    def read(self,identifier):
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            row=self.one("SELECT * FROM moneylens.insights WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,identifier))
            if row is None: raise AuthError("NOT_FOUND",404)
            return self.current_checks([row],CoachingStore(self.connection,self.user).snapshot(),utc(self.clock()))[0]

    def page(self,codec,*,status="active",cursor=None,limit=50):
        if type(limit) is not int or not 1<=limit<=100: raise AuthError("INVALID_INSIGHT_PAGE",422)
        with authorized_transaction(self.connection,self.user,repeatable_read=True):
            state=self.state();preferences=CoachingStore(self.connection,self.user).snapshot();version=self.collection_version();now=utc(self.clock())
            scope=DataScope(self.user.scope,self.user.permission_version,state["data_version"],state["plan_version"],(),"ALL",
                {"collection_version":version,"preferences_version":preferences.version,"status":status})
            namespace="insights.page.v1";condition="";params=[*self.owner,status]
            if cursor:
                position=codec.decode(cursor,scope,namespace=namespace)
                try: after=InsightPositionV1.model_validate_json(json.dumps(position),strict=True)
                except (ValueError,ValidationError): raise AuthError("INVALID_CURSOR",400) from None
                condition=" AND (updated_at,id)<(%s,%s)";params.extend([after.updated_at,after.id])
            with self.connection.cursor(row_factory=dict_row) as query:
                # List only summaries and the tiny source keys needed for one
                # batched eligibility check, never all historical comparisons.
                rows=query.execute("""SELECT id,kind,status,version,data_version,plan_version,preferences_version,permission_version,candidate,
                    generated_at,expires_at,created_at,updated_at,dismissed_at,
                    jsonb_build_object('kind',evidence->'kind','planning',jsonb_build_object('plan_id',evidence#>'{planning,plan_id}'),
                        'comparison',jsonb_build_object('current',jsonb_build_object('scope',jsonb_build_object(
                            'account_ids',evidence#>'{comparison,current,scope,account_ids}','start',evidence#>'{comparison,current,scope,start}',
                            'end_exclusive',evidence#>'{comparison,current,scope,end_exclusive}')),
                            'baseline',jsonb_build_object('scope',jsonb_build_object('start',evidence#>'{comparison,baseline,scope,start}',
                                'end_exclusive',evidence#>'{comparison,baseline,scope,end_exclusive}')))) AS evidence
                    FROM moneylens.insights WHERE tenant_id=%s AND owner_user_id=%s AND status=%s"""+condition+
                    " ORDER BY updated_at DESC,id DESC LIMIT %s",[*params,limit+1]).fetchall()
            selected=rows[:limit]
            next_cursor=codec.encode(scope,{"updated_at":selected[-1]["updated_at"].isoformat(),"id":str(selected[-1]["id"])},namespace=namespace) if len(rows)>limit else None
            return InsightPageV1(rows=self.current_checks(selected,preferences,now,detailed=False),next_cursor=next_cursor,collection_version=version,
                preferences_version=preferences.version,as_of=now,**state)

    def dismiss(self,identifier,body):
        try: body=DismissInsightV1.model_validate(body.model_dump(mode="python"),strict=True)
        except (ValueError,AttributeError): raise AuthError("INVALID_INSIGHT_COMMAND",422) from None
        digest=fingerprint({"insight_id":str(identifier),"body":body.model_dump(mode="json",exclude={"key"})});now=utc(self.clock())
        with authorized_transaction(self.connection,self.user,write=True):
            previous=self.one("SELECT request_fingerprint,receipt FROM moneylens.insight_commands WHERE tenant_id=%s AND owner_user_id=%s AND command_key=%s",(*self.owner,body.key))
            if previous:
                if previous["request_fingerprint"]!=digest: raise AuthError("IDEMPOTENCY_CONFLICT",409)
                return InsightCommandReceiptV1.model_validate(previous["receipt"])
            row=self.one("SELECT * FROM moneylens.insights WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,identifier))
            if row is None: raise AuthError("NOT_FOUND",404)
            if row["version"]!=body.expected_insight_version: raise AuthError("INSIGHT_VERSION_CHANGED",409)
            if row["version"]>=MAX_VERSION: raise AuthError("INSIGHT_VERSION_EXHAUSTED",409)
            if row["dismissed_at"] is not None: raise AuthError("INSIGHT_ALREADY_DISMISSED",409)
            count=self.connection.execute("""SELECT count(*) FROM (SELECT 1 FROM moneylens.insight_commands WHERE tenant_id=%s AND owner_user_id=%s
                AND applied_at>%s LIMIT 100) recent""",(*self.owner,now-timedelta(hours=1))).fetchone()[0]
            if count>=100: raise AuthError("INSIGHT_COMMAND_THROTTLED",429)
            self.connection.execute("UPDATE moneylens.insights SET status='dismissed',dismissed_at=%s,updated_at=%s,version=version+1 WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(now,now,*self.owner,identifier))
            _,collection=self.advance()
            receipt=InsightCommandReceiptV1(id=uuid4(),insight_id=identifier,insight_version=row["version"]+1,collection_version=collection,applied_at=now)
            self.connection.execute("INSERT INTO moneylens.insight_commands (tenant_id,owner_user_id,id,insight_id,command_key,request_fingerprint,applied_at,receipt) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                (*self.owner,receipt.id,identifier,body.key,digest,now,Jsonb(receipt.model_dump(mode="json"))))
            self.event("dismissed",identifier,{"insight_version":receipt.insight_version,"collection_version":collection})
            return receipt
