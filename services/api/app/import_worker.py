"""Scoped byte verification outside transactions; fenced metadata effects only."""
from datetime import datetime,timezone
import time
from types import SimpleNamespace
from uuid import UUID

import psycopg

from .database import tenant_transaction
from .identity import AuthError,authorized_transaction
from .import_contracts import ImportManifestV1
from .import_objects import ImportObjectError
from .import_store import ImportStore
from .jobs import JobStore,LostLease


def run_import_once(database_url,scope,objects,*,settings,clock=lambda:datetime.now(timezone.utc)):
    if not settings.imports_enabled:
        raise ValueError("Source intake must be explicitly enabled")
    owner=(scope.tenant_id,scope.user_id)
    with psycopg.connect(database_url,autocommit=True,connect_timeout=5,
            options="-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000") as connection:
        with tenant_transaction(connection,scope):
            connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",owner)
            jobs=JobStore(connection,scope)
            claimed=jobs.claim(["import.verify_source"],lease_seconds=300)
            if claimed is None: return False
            member=connection.execute("SELECT permission_version,is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",owner).fetchone()
            if not member[1]:
                jobs.cancel(claimed.id)
                return True
            user=SimpleNamespace(scope=scope,permission_version=member[0],synthetic=True,session_id=None)
        identifier=None
        try:
            if claimed.schema_version!=1 or not isinstance(claimed.payload,dict) or set(claimed.payload)!={"import_id"}:
                raise ValueError("Invalid verification job")
            identifier=UUID(claimed.payload["import_id"])
            service=ImportStore(connection,user,settings=settings,clock=clock)
            with authorized_transaction(connection,user,repeatable_read=True):
                row=service.get(identifier)
                if row["state"]!="queued" or row["verification_job_id"]!=claimed.id:
                    raise ValueError("Superseded source verification")
                manifest=ImportManifestV1.model_validate(row["manifest"])
                service.check_files(identifier,manifest)
            # No pool lease or DB transaction is held while object bytes are read.
            deadline=time.monotonic()+120
            verified=[objects.verify(scope,identifier,file,deadline=deadline) for file in manifest.files]
            with authorized_transaction(connection,user,write=True):
                if not connection.execute("SELECT is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",owner).fetchone()[0]:
                    raise AuthError("IMPORT_SYNTHETIC_REQUIRED",409)
                JobStore(connection,scope).complete(claimed,lambda *_:service.finish_source(identifier,claimed.id,verified))
        except LostLease:
            # An old attempt must never cancel or publish over a newer attempt.
            pass
        except Exception as error:
            permanent=isinstance(error,(ValueError,KeyError,TypeError,AttributeError,AuthError)) or (
                isinstance(error,ImportObjectError) and error.permanent)
            code=error.code if isinstance(error,ImportObjectError) else "invalid_import_source" if permanent else "import_verification_failed"
            try:
                with authorized_transaction(connection,user,write=True):
                    jobs=JobStore(connection,scope)
                    jobs.fail(claimed,code,permanent=permanent)
                    if identifier and jobs.status(claimed.id)["state"]=="dead_letter":
                        connection.execute("""UPDATE moneylens.import_batches SET state='failed',updated_at=%s
                            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND verification_job_id=%s AND state='queued'""",
                            (clock(),*owner,identifier,claimed.id))
            except (AuthError,LostLease):
                # Revoked membership may cancel only this still-current lease.
                with tenant_transaction(connection,scope):
                    connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",owner)
                    current=connection.execute("""SELECT id FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s
                        AND id=%s AND state='running' AND lease_token=%s AND lease_until>statement_timestamp() FOR UPDATE""",
                        (*owner,claimed.id,claimed.lease_token)).fetchone()
                    if current: JobStore(connection,scope).cancel(claimed.id)
        return True
