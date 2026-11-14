"""Scoped polling runner. Only explicitly registered synthetic handlers are enabled."""
import argparse
import logging
import os
from pathlib import Path
import signal
import sys
import threading
from uuid import UUID

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/api"))

from app.database import TrustedScope, tenant_transaction
from app.jobs import JobStore, LostLease
from app.bank_fetch import run_fetch_once
from app.bank_publish_worker import run_publish_once
from app.insight_worker import run_insights_once
from app.import_worker import run_import_once
from app.import_validation_worker import run_validation_once
from app.import_publication_worker import run_publication_once
from app.import_objects import ImportObjects
from app.settings import get_settings

LOGGER = logging.getLogger("moneylens.worker")
SUBSCRIPTIONS = {"demo.requested": ("demo.echo",)}


class PermanentJobError(ValueError):
    pass


def synthetic_echo(jobs, job):
    envelope = job.payload
    if job.schema_version != 1 or envelope.get("schema_version") != 1:
        raise PermanentJobError("unsupported_schema")
    if envelope.get("event_type") != "demo.requested" or envelope.get("data") != {"synthetic": True}:
        raise PermanentJobError("invalid_synthetic_payload")
    jobs.emit("demo.completed", "completed:" + str(job.id), {"synthetic": True, "job_id": str(job.id)})


HANDLERS = {"demo.echo": synthetic_echo}


def run_once(database_url, scope):
    with psycopg.connect(database_url, autocommit=True, connect_timeout=5,
                         options="-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000") as connection:
        with tenant_transaction(connection, scope):
            store = JobStore(connection, scope)
            dispatched = store.dispatch_one(SUBSCRIPTIONS)
            claimed = store.claim(list(HANDLERS))
        if claimed is None:
            return dispatched is not None
        try:
            with tenant_transaction(connection, scope):
                JobStore(connection, scope).complete(claimed, HANDLERS[claimed.type])
        except LostLease:
            LOGGER.info("job_attempt_superseded")
        except Exception as error:
            permanent = isinstance(error, PermanentJobError)
            code = str(error) if permanent else "handler_failed"
            try:
                with tenant_transaction(connection, scope):
                    JobStore(connection, scope).fail(claimed, code, permanent=permanent)
            except LostLease:
                LOGGER.info("job_attempt_superseded")
            # Never log payloads, credentials, URLs, or raw exception strings.
            LOGGER.warning("job_attempt_failed")
        return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", type=UUID, required=True, help="Operator-verified tenant UUID")
    parser.add_argument("--user", type=UUID, required=True, help="Operator-verified owner UUID")
    parser.add_argument("--once", action="store_true", help="Run one bounded polling iteration")
    parser.add_argument("--enqueue-demo", action="store_true", help="Idempotently seed a synthetic event for an existing authorized user")
    parser.add_argument("--bank-fetch", action="store_true", help="Fetch only synthetic bank sources into bounded staging; no financial publication")
    parser.add_argument("--bank-publish", action="store_true", help="Publish reconciled synthetic source stages under their consent and job lease")
    parser.add_argument("--bank-sync", action="store_true", help="Process synthetic fetch and publication jobs for this verified owner")
    parser.add_argument("--coaching", action="store_true", help="Schedule and apply scoped coaching snapshots; no external notifications")
    parser.add_argument("--imports", action="store_true", help="Process explicitly queued native intake, validation and snapshot publication")
    args = parser.parse_args(argv)
    if sum((args.bank_fetch,args.bank_publish,args.bank_sync,args.enqueue_demo,args.coaching,args.imports))>1:
        parser.error("Choose one worker mode or demo event seeding")
    load_dotenv(ROOT / ".env", override=False)
    url = os.environ.get("MONEYLENS_DATABASE_URL")
    if not url:
        parser.error("Set MONEYLENS_DATABASE_URL to a restricted runtime login")
    scope = TrustedScope(args.tenant, args.user)
    bank_secret=os.environ.get("MONEYLENS_SESSION_SECRET")
    if (args.bank_fetch or args.bank_publish or args.bank_sync) and (not bank_secret or len(bank_secret)<32):
        parser.error("Synthetic synchronization requires the configured session secret")
    logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")
    stop = threading.Event()
    for termination in (signal.SIGINT, signal.SIGTERM):
        signal.signal(termination, lambda *_: stop.set())
    if args.enqueue_demo:
        try:
            with psycopg.connect(url, autocommit=True, connect_timeout=5) as connection:
                with tenant_transaction(connection, scope):
                    JobStore(connection, scope).emit("demo.requested", "worker-smoke.v1", {"synthetic": True})
        except Exception:
            LOGGER.error("worker_seed_failed")
            return 1
    objects=None
    if args.imports:
        import_settings=get_settings()
        if not import_settings.imports_enabled:
            parser.error("Set MONEYLENS_IMPORTS_ENABLED and configure private object storage first")
        objects=ImportObjects(import_settings)
    try:
        while not stop.is_set():
            try:
                if args.imports:
                    busy=(run_import_once(url,scope,objects,settings=import_settings) or
                        run_validation_once(url,scope,objects,settings=import_settings) or
                        run_publication_once(url,scope,settings=import_settings))
                elif args.coaching:
                    busy=run_insights_once(url,scope,maximum_age_hours=int(os.environ.get("MONEYLENS_BALANCE_MAXIMUM_AGE_HOURS","24")))
                elif args.bank_sync:
                    busy=run_publish_once(url,scope,bank_secret) or run_fetch_once(url,scope,bank_secret)
                elif args.bank_publish:
                    busy=run_publish_once(url,scope,bank_secret)
                elif args.bank_fetch:
                    busy=run_fetch_once(url,scope,bank_secret)
                else:
                    busy=run_once(url,scope)
            except Exception:
                LOGGER.error("worker_poll_failed")
                if args.once:
                    return 1
                stop.wait(5)
                continue
            if args.once:
                return 0
            stop.wait(0.05 if busy else 1)
        return 0
    finally:
        if objects is not None: objects.close()



if __name__ == "__main__":
    raise SystemExit(main())
