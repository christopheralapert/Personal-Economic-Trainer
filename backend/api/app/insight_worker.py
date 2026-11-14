"""Operator-scoped coaching scheduler/worker; database effects only, no delivery."""
from datetime import datetime,timezone
from types import SimpleNamespace

import psycopg
from pydantic import ValidationError

from .coaching_store import CoachingStore
from .database import tenant_transaction
from .identity import AuthError,authorized_transaction
from .insight_store import InsightStore
from .jobs import JobStore,LostLease
from .planning_policy import utc


def run_insights_once(database_url,scope,*,clock=lambda:datetime.now(timezone.utc),maximum_age_hours=24):
    if type(maximum_age_hours) is not int or not 1<=maximum_age_hours<=168: raise ValueError("Use a bounded source age policy")
    with psycopg.connect(database_url,autocommit=True,connect_timeout=5,
        options="-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000") as connection:
        with tenant_transaction(connection,scope):
            owner=(scope.tenant_id,scope.user_id)
            state=connection.execute("SELECT data_version,plan_version FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",owner).fetchone()
            membership=connection.execute("SELECT active,permission_version,is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",owner).fetchone()
            if state is None or membership is None: return False
            if not membership[0]:
                JobStore(connection,scope).claim(["coaching.refresh"])
                return False
            user=SimpleNamespace(scope=scope,permission_version=membership[1],synthetic=membership[2],session_id=None)
            preferences=CoachingStore(connection,user).snapshot();now=utc(clock())
            key=f"scheduled:{state[0]}:{state[1]}:{preferences.version}:{user.permission_version}:{int(now.timestamp())//300}"
            repository=InsightStore(connection,user,clock=clock,maximum_age_hours=maximum_age_hours)
            repository.enqueue(key,automatic=True)
            claimed=JobStore(connection,scope).claim(["coaching.refresh"])
            if claimed is None: return False
        try:
            if claimed.schema_version!=1 or claimed.payload!={"operation":"refresh_current"}: raise ValueError("Invalid coaching job")
            with authorized_transaction(connection,user,write=True):
                JobStore(connection,scope).complete(claimed,lambda *_:InsightStore(connection,user,clock=clock,maximum_age_hours=maximum_age_hours).refresh())
        except Exception as error:
            permanent=isinstance(error,(ValueError,ValidationError,AuthError))
            code="invalid_coaching_job" if isinstance(error,(ValueError,ValidationError)) else "coaching_context_unavailable" if isinstance(error,AuthError) else "coaching_refresh_failed"
            try:
                with authorized_transaction(connection,user,write=True): JobStore(connection,scope).fail(claimed,code,permanent=permanent)
            except (AuthError,LostLease):
                with tenant_transaction(connection,scope):
                    connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",owner).fetchone()
                    current=connection.execute("SELECT id FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND state='running' AND lease_token=%s FOR UPDATE",(*owner,claimed.id,claimed.lease_token)).fetchone()
                    if current: JobStore(connection,scope).cancel(claimed.id)
        return True
