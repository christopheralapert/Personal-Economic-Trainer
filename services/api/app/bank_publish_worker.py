"""Operator-scoped, leased and membership-fenced canonical bank publication."""
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID

import psycopg
from pydantic import ValidationError

from .bank_adapter import BankError
from .bank_publication import BankPublication
from .database import tenant_transaction
from .identity import AuthError, authorized_transaction
from .jobs import JobStore, LostLease


def run_publish_once(database_url,scope,secret,*,clock=lambda:datetime.now(timezone.utc)):
    with psycopg.connect(database_url,autocommit=True,connect_timeout=5,
            options="-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000") as connection:
        with tenant_transaction(connection,scope):
            connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",
                (scope.tenant_id,scope.user_id)).fetchone()
            jobs=JobStore(connection,scope)
            claimed=jobs.claim(["bank.publish"])
            if claimed is None:
                return False
            owner=connection.execute("SELECT permission_version,is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",
                (scope.tenant_id,scope.user_id)).fetchone()
            if not owner[1]:
                jobs.cancel(claimed.id)
                return True
            user=SimpleNamespace(scope=scope,permission_version=owner[0],synthetic=True,session_id=None)
        payload=claimed.payload
        try:
            if claimed.schema_version!=1 or not isinstance(payload,dict) or set(payload)!={"connection_id","fetch_job_id","generation"}:
                raise BankError("invalid_publication_job")
            identifier,fetch_job_id=UUID(payload["connection_id"]),UUID(payload["fetch_job_id"])
            if type(payload["generation"]) is not int or payload["generation"]<1:
                raise BankError("invalid_publication_job")
            with authorized_transaction(connection,user,write=True):
                service=BankPublication(connection,user,secret,clock=clock)
                JobStore(connection,scope).complete(claimed,lambda *_:service.effect(identifier,
                    fetch_job_id=fetch_job_id,generation=payload["generation"]))
        except Exception as error:
            code=error.code if isinstance(error,BankError) else "invalid_source_stage" if isinstance(
                error,(ValidationError,ValueError,KeyError,TypeError)) else "publication_failed"
            permanent=isinstance(error,(BankError,ValidationError,ValueError,KeyError,TypeError))
            try:
                with authorized_transaction(connection,user,write=True):
                    jobs=JobStore(connection,scope)
                    jobs.fail(claimed,code,permanent=permanent)
                    if isinstance(payload,dict) and "connection_id" in payload and "generation" in payload:
                        # Invalid UUIDs never reach SQL or become raw errors.
                        try:
                            target=UUID(payload["connection_id"])
                            source=UUID(payload.get("fetch_job_id",""))
                        except (ValueError,TypeError,AttributeError):
                            return True
                        if type(payload["generation"]) is int:
                            connection.execute("""UPDATE moneylens.connections SET sync_health='error',last_error_code=%s
                                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND consent_generation=%s
                                    AND refresh_job_id=%s AND sync_health IN ('staged','error')""",
                                (code,scope.tenant_id,scope.user_id,target,payload["generation"],source))
            except (AuthError,LostLease):
                # Never cancel a newer token while cleaning up an old worker.
                with tenant_transaction(connection,scope):
                    connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",
                        (scope.tenant_id,scope.user_id)).fetchone()
                    current=connection.execute("""SELECT id FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s
                        AND id=%s AND state='running' AND lease_token=%s FOR UPDATE""",
                        (scope.tenant_id,scope.user_id,claimed.id,claimed.lease_token)).fetchone()
                    if current:
                        JobStore(connection,scope).cancel(claimed.id)
        return True
