"""Check sealed snapshots with reader locks; activate under a short owner write fence."""
from datetime import datetime,timezone
from types import SimpleNamespace
from uuid import UUID

import psycopg

from .database import tenant_transaction
from .identity import AuthError,authorized_transaction
from .import_csv import MAX_MINOR
from .import_publication_store import ImportPublicationStore,PublicationError
from .jobs import JobStore,LostLease


def run_publication_once(database_url,scope,*,settings,clock=lambda:datetime.now(timezone.utc)):
    if not settings.imports_enabled: raise ValueError("Source intake must be explicitly enabled")
    owner=(scope.tenant_id,scope.user_id)
    with psycopg.connect(database_url,autocommit=True,connect_timeout=5,
            options="-c statement_timeout=60000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000") as connection:
        with tenant_transaction(connection,scope):
            connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",owner)
            jobs=JobStore(connection,scope);claimed=jobs.claim(["import.publish"],lease_seconds=300)
            if claimed is None: return False
            member=connection.execute("SELECT permission_version,is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",owner).fetchone()
            if not member[1]:
                jobs.cancel(claimed.id)
                return True
            user=SimpleNamespace(scope=scope,permission_version=member[0],synthetic=True,session_id=None)
        identifier=generation=None
        try:
            payload=claimed.payload
            if claimed.schema_version!=1 or not isinstance(payload,dict) or set(payload)!={"publication_id","generation"}:
                raise ValueError("Invalid publication job")
            identifier=UUID(payload["publication_id"]);generation=payload["generation"]
            if type(generation) is not int or not 1<=generation<=MAX_MINOR: raise ValueError("Invalid publication generation")
            service=ImportPublicationStore(connection,user,settings=settings,clock=clock)
            # Expensive immutable source comparisons allow concurrent reader snapshots.
            # Validated rows/runs and manifest identities are sealed by database triggers.
            with authorized_transaction(connection,user,repeatable_read=True):
                prepared=service.prepare(identifier,claimed.id,generation)
            with authorized_transaction(connection,user,write=True):
                JobStore(connection,scope).complete(claimed,lambda *_:service.activate(prepared))
        except LostLease:
            pass
        except Exception as error:
            permanent=isinstance(error,(ValueError,KeyError,TypeError,AttributeError,AuthError))
            code=error.code if isinstance(error,PublicationError) else "invalid_import_publication" if permanent else "import_publication_failed"
            try:
                with authorized_transaction(connection,user,write=True):
                    jobs=JobStore(connection,scope);jobs.fail(claimed,code,permanent=permanent)
                    if identifier and type(generation) is int and 1<=generation<=MAX_MINOR and jobs.status(claimed.id)["state"]=="dead_letter":
                        updated=connection.execute("""UPDATE moneylens.import_publications SET state='failed',updated_at=%s,last_error_code=%s
                            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND job_id=%s AND generation=%s AND state='queued' RETURNING import_id""",
                            (clock(),code,*owner,identifier,claimed.id,generation)).fetchone()
                        if updated:
                            service.imports.audit("import.publication_failed",updated[0],clock())
                            jobs.emit("import.publication_failed",f"publication-error:{identifier}:{generation}",
                                {"import_id":str(updated[0]),"publication_id":str(identifier),"code":code})
            except (AuthError,LostLease):
                with tenant_transaction(connection,scope):
                    connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",owner)
                    current=connection.execute("""SELECT id FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s AND id=%s
                        AND state='running' AND lease_token=%s AND lease_until>statement_timestamp() FOR UPDATE""",(*owner,claimed.id,claimed.lease_token)).fetchone()
                    if current: JobStore(connection,scope).cancel(claimed.id)
        return True
