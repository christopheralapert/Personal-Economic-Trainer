"""One leased, resumable native CSV chunk per scoped worker iteration."""
from datetime import datetime,timezone
import time
from types import SimpleNamespace
from uuid import UUID

import psycopg

from .database import tenant_transaction
from .identity import AuthError,authorized_transaction
from .import_csv import MAX_MINOR,CsvSourceError,parse_chunk
from .import_objects import ImportObjectError
from .import_validation_store import ImportValidationStore
from .jobs import JobStore,LostLease


def run_validation_once(database_url,scope,objects,*,settings,clock=lambda:datetime.now(timezone.utc)):
    if not settings.imports_enabled: raise ValueError("Source intake must be explicitly enabled")
    owner=(scope.tenant_id,scope.user_id)
    with psycopg.connect(database_url,autocommit=True,connect_timeout=5,
            options="-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000") as connection:
        with tenant_transaction(connection,scope):
            connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",owner)
            jobs=JobStore(connection,scope);claimed=jobs.claim(["import.validate_chunk"],lease_seconds=120)
            if claimed is None: return False
            member=connection.execute("SELECT permission_version,is_synthetic FROM moneylens.users WHERE tenant_id=%s AND id=%s",owner).fetchone()
            if not member[1]:
                jobs.cancel(claimed.id)
                return True
            user=SimpleNamespace(scope=scope,permission_version=member[0],synthetic=True,session_id=None)
        run_id=None;generation=sequence=None
        try:
            payload=claimed.payload
            if claimed.schema_version!=1 or not isinstance(payload,dict) or set(payload)!={"run_id","generation","sequence"}:
                raise ValueError("Invalid validation job")
            run_id=UUID(payload["run_id"]);generation=payload["generation"];sequence=payload["sequence"]
            if type(generation) is not int or not 1<=generation<=MAX_MINOR or type(sequence) is not int or not 0<=sequence<=MAX_MINOR:
                raise ValueError("Invalid validation generation")
            service=ImportValidationStore(connection,user,settings=settings,clock=clock)
            with authorized_transaction(connection,user,repeatable_read=True):
                run,manifest,files,role=service.prepare(run_id,claimed.id,generation,sequence)
                point=run["checkpoints"][role]
                file=next(file for file in manifest.files if file.role==role)
            # Storage reads and CSV parsing never hold an open database transaction.
            with objects.read_range(scope,run["import_id"],file,offset=point["offset"],etag=files[role]["etag"]) as body:
                chunk=parse_chunk(body,role=role,offset=point["offset"],ordinal=point["rows"],size_bytes=file.size_bytes,
                    manifest=manifest,as_of=run["created_at"],deadline=time.monotonic()+25)
            with authorized_transaction(connection,user,write=True):
                JobStore(connection,scope).complete(claimed,lambda *_:service.apply_chunk(run_id,claimed.id,generation,sequence,role,chunk))
        except LostLease:
            pass
        except Exception as error:
            permanent=isinstance(error,(ValueError,KeyError,TypeError,AttributeError,AuthError)) or (
                isinstance(error,ImportObjectError) and error.permanent)
            code=error.code if isinstance(error,(CsvSourceError,ImportObjectError)) else (
                "import_validation_timeout" if isinstance(error,TimeoutError) else "import_invalid_checkpoint" if permanent else "import_validation_failed")
            try:
                with authorized_transaction(connection,user,write=True):
                    jobs=JobStore(connection,scope);jobs.fail(claimed,code,permanent=permanent)
                    if run_id and type(generation) is int and 1<=generation<=MAX_MINOR and type(sequence) is int and 0<=sequence<=MAX_MINOR and jobs.status(claimed.id)["state"]=="dead_letter":
                        state="invalid" if permanent else "failed"
                        now=clock()
                        updated=connection.execute("""UPDATE moneylens.import_validation_runs SET state=%s,last_error_code=%s,
                            updated_at=%s,finished_at=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s AND job_id=%s
                            AND generation=%s AND sequence=%s AND state='queued' RETURNING import_id""",
                            (state,code,now,now,*owner,run_id,claimed.id,generation,sequence)).fetchone()
                        if updated:
                            service.imports.audit("import.validation_"+state,updated[0],now)
                            jobs.emit("import.validation_"+state,f"validation-error:{run_id}:{generation}",
                                {"import_id":str(updated[0]),"run_id":str(run_id),"state":state,"code":code})
            except (AuthError,LostLease):
                with tenant_transaction(connection,scope):
                    connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR UPDATE",owner)
                    current=connection.execute("""SELECT id FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s AND id=%s
                        AND state='running' AND lease_token=%s AND lease_until>statement_timestamp() FOR UPDATE""",(*owner,claimed.id,claimed.lease_token)).fetchone()
                    if current: JobStore(connection,scope).cancel(claimed.id)
        return True
