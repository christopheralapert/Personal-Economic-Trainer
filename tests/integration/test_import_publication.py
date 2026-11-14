"""Real sealed source -> atomic active pointer -> existing ledger/planning reads."""
from contextlib import contextmanager
import csv
import hashlib
import io
from uuid import UUID

import httpx
import psycopg
import pytest

from app.database import TrustedScope,tenant_transaction
from app import import_publication_worker as worker
from app.import_publication_store import ImportPublicationStore
from app.import_worker import run_import_once
from app.import_validation_worker import run_validation_once
from app.jobs import JobStore
from app.native_ids import native_id
from identity_support import authenticated_app
from test_import_intake import storage,auth,user,financial_facts
from test_import_validation import files,tx,csv_bytes,force_due

QUERY="/v1/analysis/spending?start=2026-10-01&end_exclusive=2026-11-01"
LEDGER="/v1/ledger/transactions?start=2026-10-01&end_exclusive=2026-11-01"


def seed(database,client,app,config,headers,*,version="native-one",rows=None,with_balances=True,balance_updates=None):
    rows=rows if rows is not None else [tx("one"),tx("two"),tx("three")]
    source=files(rows,with_balances=with_balances)
    account=next(csv.DictReader(io.StringIO(source["accounts"].decode("utf-8"))))
    account["expected_net_minor"]=str(sum(int(row["amount_minor"]) for row in rows))
    source["accounts"]=csv_bytes("accounts",[account])
    if balance_updates:
        balance=next(csv.DictReader(io.StringIO(source["balances"].decode("utf-8"))))
        balance.update(balance_updates);source["balances"]=csv_bytes("balances",[balance])
    manifest=dict(mapping_version="moneylens.synthetic-csv.v1",source_version=version,source_customer_ref="synthetic-1",
        currency="EUR",timezone="Europe/Helsinki",claimed_from="2026-10-01",claimed_to_exclusive="2026-11-01",
        files=[dict(role=role,size_bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()) for role,raw in source.items()])
    started=client.post("/v1/imports",headers=headers,json={"key":version+"-source","manifest":manifest})
    assert started.status_code==202,started.text
    identifier=started.json()["import_id"];path=f"/v1/imports/{identifier}/publication";member=user(app,client)
    assert client.post(path,headers=headers,json={"key":version+"-early"}).status_code==409
    links=client.post(f"/v1/imports/{identifier}/upload-links",headers=headers,json={})
    assert links.status_code==200
    with httpx.Client(trust_env=False,timeout=10) as http:
        for link in links.json()["files"]:
            assert http.put(link["url"],headers=link["headers"],content=source[link["role"]]).status_code==200
    assert client.post(f"/v1/imports/{identifier}/submit",headers=headers,json={"key":version+"-verify"}).status_code==202
    assert run_import_once(database["runtime"],member.scope,app.state.import_objects,settings=config)
    assert client.post(f"/v1/imports/{identifier}/validation",headers=headers,json={"key":version+"-validate"}).status_code==202
    for _ in range(30):
        if not run_validation_once(database["runtime"],member.scope,app.state.import_objects,settings=config): break
    else: pytest.fail("Tiny source exceeded its validation chunk budget")
    validation=client.get(f"/v1/imports/{identifier}/validation")
    assert validation.status_code==200 and validation.json()["state"]=="validated",validation.text
    return identifier,path,member


def start(client,headers,path,key="publish"):
    response=client.post(path,headers=headers,json={"key":key})
    assert response.status_code==202,response.text
    return response.json()


def publish(database,client,config,member,path):
    assert worker.run_publication_once(database["runtime"],member.scope,settings=config)
    response=client.get(path);assert response.status_code==200,response.text
    return response.json()


@pytest.mark.parametrize("next_status",["pending","booked"])
def test_reversed_native_identity_cannot_be_reopened_by_higher_revision(database,owners,storage,next_status):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client)
        _,path,member=seed(database,client,app,config,headers,version="reversed-first",rows=[tx("one",status="reversed")])
        start(client,headers,path);first=publish(database,client,config,member,path)
        before=financial_facts(database,owners[0])
        _,next_path,member=seed(database,client,app,config,headers,version="reopened-next",rows=[tx("one",revision="2",status=next_status)])
        start(client,headers,next_path,key="reopen");failed=publish(database,client,config,member,next_path)
        assert failed["state"]=="failed" and failed["last_error_code"]=="import_source_status_regressed"
        assert client.get(path).json()["active"] and client.get(path).json()["id"]==first["id"]
        assert financial_facts(database,owners[0])==before


def test_thousands_of_rows_switch_atomically_without_bulk_copy_and_invalidate_old_cursors(database,owners,storage):
    rows=[tx(f"coffee-{index}") for index in range(2000)]
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);before=financial_facts(database,owners[0]);identifier,path,member=seed(database,client,app,config,headers,rows=rows)
        assert client.get(QUERY).json()["net_minor"]==0
        receipt=start(client,headers,path)
        assert client.get(QUERY).json()["net_minor"]==0  # requested is not active
        view=publish(database,client,config,member,path)
        assert view["state"]=="published" and view["active"] and view["transaction_count"]==2000
        assert view["published_data_version"]==before[1][0]+1
        with psycopg.connect(database["admin"]) as connection:
            assert connection.execute("SELECT accepted_rows,rejected_rows FROM moneylens.import_batches WHERE id=%s",(identifier,)).fetchone()==(2002,0)
        result=client.get(QUERY).json()
        assert result["net_minor"]==250000 and result["expense_count"]==2000
        assert "source-labelled" in " ".join(result["limitations"])
        page=client.get(LEDGER+"&limit=1").json();cursor=page["next_cursor"]
        assert cursor and page["scope"]["dataset_coverage"]=="unverified"
        context=client.get("/v1/planning/context")
        assert context.status_code==200,context.text
        account_id=native_id(UUID(view["feed_id"]),"account","daily")
        imported=next(account for account in context.json()["accounts"] if account["id"]==str(account_id))
        assert imported["balance"]["amount_minor"]==100000 and imported["balance"]["pending_reflection"]=="included"
        assert client.get(f"/v1/imports/{identifier}").status_code==409  # frozen intake outcome does not pretend to describe publication
        assert start(client,headers,path)==receipt
        assert not worker.run_publication_once(database["runtime"],member.scope,settings=config)
        # A larger immutable snapshot retains old visibility until its own activation.
        second,second_path,member=seed(database,client,app,config,headers,version="native-two",rows=rows+[tx("added")])
        assert client.get(QUERY).json()["expense_count"]==2000
        start(client,headers,second_path,key="publish-two")
        assert client.get(QUERY).json()["expense_count"]==2000
        current=publish(database,client,config,member,second_path)
        assert current["state"]=="published" and current["published_data_version"]==before[1][0]+2
        assert client.get(QUERY).json()["net_minor"]==250125
        assert client.get(LEDGER,params={"start":"2026-10-01","end_exclusive":"2026-11-01","cursor":cursor}).status_code==409
        assert client.get(path).json()["state"]=="superseded"
        assert start(client,headers,path,key="new-key-old-snapshot")["state"]=="superseded"
        assert not worker.run_publication_once(database["runtime"],member.scope,settings=config)
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            with tenant_transaction(connection,member.scope):
                assert connection.execute("SELECT count(*) FROM moneylens.analysis_transactions").fetchone()==(2001,)
                assert connection.execute("SELECT count(*) FROM moneylens.transactions").fetchone()==(0,)
                assert connection.execute("SELECT count(*) FROM moneylens.analysis_balances").fetchone()==(1,)
                assert connection.execute("SELECT moneylens.native_id(%s,'account','daily')",(UUID(view["feed_id"]),)).fetchone()==(account_id,)


def test_pointer_accounts_version_audit_and_job_completion_rollback_together(database,owners,storage,monkeypatch):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);before=financial_facts(database,owners[0]);identifier,path,member=seed(database,client,app,config,headers)
        receipt=start(client,headers,path);original=JobStore.emit
        def failing_emit(self,kind,*args,**kwargs):
            if kind=="import.published": raise RuntimeError("injected after pointer/version update")
            return original(self,kind,*args,**kwargs)
        monkeypatch.setattr(JobStore,"emit",failing_emit)
        failed=publish(database,client,config,member,path)
        assert failed["state"]=="queued" and not failed["active"] and failed["published_at"] is None
        assert financial_facts(database,owners[0])==before
        assert client.get(QUERY).json()["expense_count"]==0
        with psycopg.connect(database["admin"]) as connection:
            assert connection.execute("SELECT accepted_rows,rejected_rows FROM moneylens.import_batches WHERE id=%s",(identifier,)).fetchone()==(0,0)
        monkeypatch.setattr(JobStore,"emit",original);force_due(database,receipt["job_id"])
        ready=publish(database,client,config,member,path)
        assert ready["active"] and ready["published_data_version"]==before[1][0]+1
        with psycopg.connect(database["admin"]) as connection:
            assert connection.execute("SELECT count(*) FROM moneylens.audit_events WHERE tenant_id=%s AND owner_user_id=%s AND action='import.published'",owners[0][:2]).fetchone()==(1,)
            assert connection.execute("SELECT count(*) FROM moneylens.outbox_events WHERE tenant_id=%s AND owner_user_id=%s AND type='import.published'",owners[0][:2]).fetchone()==(1,)


@pytest.mark.parametrize("interruption",["cancel","revoke","reclaim"])
def test_after_prepare_cancellation_revocation_or_stale_lease_cannot_activate(database,owners,storage,monkeypatch,interruption):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);before=financial_facts(database,owners[0]);identifier,path,member=seed(database,client,app,config,headers)
        receipt=start(client,headers,path);original=worker.authorized_transaction;interrupted=[]
        @contextmanager
        def fenced(connection,principal,**options):
            with original(connection,principal,**options): yield connection
            # Read checks finished; the reader lock has been released before final activation.
            if options.get("repeatable_read") and not interrupted:
                interrupted.append(True)
                if interruption=="cancel":
                    assert client.post(path+"/cancel",headers=headers,json={"key":"cancel-prepared"}).status_code==200
                elif interruption=="revoke":
                    with psycopg.connect(database["admin"],autocommit=True) as admin:
                        admin.execute("UPDATE moneylens.users SET permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
                else:
                    force_due(database,receipt["job_id"])
                    with psycopg.connect(database["runtime"],autocommit=True) as other:
                        with tenant_transaction(other,member.scope): assert JobStore(other,member.scope).claim(["import.publish"],lease_seconds=300)
        monkeypatch.setattr(worker,"authorized_transaction",fenced)
        assert worker.run_publication_once(database["runtime"],member.scope,settings=config)
        assert financial_facts(database,owners[0])==before
        monkeypatch.setattr(worker,"authorized_transaction",original)
        if interruption=="revoke":
            assert client.get(path).status_code==401
            headers=auth(client);member=user(app,client)
        if interruption=="reclaim": force_due(database,receipt["job_id"])
        else:
            assert client.get(path).json()["state"]=="cancelled"
            assert start(client,headers,path)==receipt
            start(client,headers,path,key="explicit-publication-resume")
        ready=publish(database,client,config,member,path)
        assert ready["active"] and ready["published_data_version"]==before[1][0]+1


def test_same_feed_race_requires_explicit_retry_and_source_history_cannot_disappear(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);first,path,member=seed(database,client,app,config,headers,version="race-one",rows=[tx("one")])
        second,next_path,member=seed(database,client,app,config,headers,version="race-two",rows=[tx("one"),tx("two")])
        start(client,headers,path,key="race-first");start(client,headers,next_path,key="race-second")
        assert publish(database,client,config,member,path)["active"]
        stale=publish(database,client,config,member,next_path)
        assert stale["state"]=="failed" and stale["last_error_code"]=="import_source_version_changed"
        assert client.get(QUERY).json()["expense_count"]==1
        start(client,headers,next_path,key="race-explicit-retry")
        assert publish(database,client,config,member,next_path)["active"]
        third,old_path,member=seed(database,client,app,config,headers,version="older-history",rows=[tx("one")])
        start(client,headers,old_path,key="must-not-remove-history")
        removed=publish(database,client,config,member,old_path)
        assert removed["state"]=="failed" and removed["last_error_code"]=="import_source_history_removed"
        assert client.get(QUERY).json()["expense_count"]==2


def test_pending_to_booked_uses_one_stable_identity_and_revision_conflicts_fail_closed(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client)
        first,path,member=seed(database,client,app,config,headers,version="pending-one",rows=[tx("one",status="pending",amount_minor="-100")])
        start(client,headers,path,key="publish-pending");publish(database,client,config,member,path)
        pending=client.get(LEDGER+"&status=pending").json()["rows"]
        assert len(pending)==1 and pending[0]["amount_minor"]==-100
        second,next_path,member=seed(database,client,app,config,headers,version="booked-two",rows=[tx("one",revision="2")])
        start(client,headers,next_path,key="publish-booked");publish(database,client,config,member,next_path)
        booked=client.get(LEDGER).json()["rows"]
        assert len(booked)==1 and booked[0]["id"]==pending[0]["id"] and booked[0]["amount_minor"]==-125
        assert client.get(LEDGER+"&status=pending").json()["rows"]==[]
        bad,conflict_path,member=seed(database,client,app,config,headers,version="conflicting-revision",rows=[tx("one",revision="2",amount_minor="-150")])
        start(client,headers,conflict_path,key="reject-conflict")
        rejected=publish(database,client,config,member,conflict_path)
        assert rejected["last_error_code"]=="import_source_revision_conflict" and not rejected["active"]
        assert client.get(QUERY).json()["net_minor"]==125


def test_missing_balances_are_not_inferred_and_old_balances_cannot_replace_newer_ones(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);identifier,path,member=seed(database,client,app,config,headers,with_balances=False)
        receipt=start(client,headers,path);view=publish(database,client,config,member,path)
        native_account=str(native_id(UUID(view["feed_id"]),"account","daily"))
        context=client.get("/v1/planning/context").json()
        assert next(account for account in context["accounts"] if account["id"]==native_account)["balance"] is None
        second,next_path,member=seed(database,client,app,config,headers,version="with-balance")
        start(client,headers,next_path,key="publish-balance");publish(database,client,config,member,next_path)
        third,old_path,member=seed(database,client,app,config,headers,version="stale-balance",balance_updates={"observed_at":"2026-11-03T10:00:00Z"})
        start(client,headers,old_path,key="reject-stale-balance")
        rejected=publish(database,client,config,member,old_path)
        assert rejected["last_error_code"]=="import_source_balance_regressed"
        context=client.get("/v1/planning/context").json()
        assert "2026-11-04" in next(account for account in context["accounts"] if account["id"]==native_account)["balance"]["observed_at"]


def test_sealed_sources_invoker_views_and_commands_keep_owner_boundaries(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);identifier,path,member=seed(database,client,app,config,headers)
        receipt=start(client,headers,path);view=publish(database,client,config,member,path)
        assert client.post(path,headers=headers,json={"key":"forged","feed_id":str(owners[1][1])}).status_code==422
        assert client.post(path+"/cancel",headers=headers,json={"key":"cannot-cancel-published"}).status_code==409
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            statements=[("DELETE FROM moneylens.import_stage_rows WHERE run_id=%s",(view["run_id"],)),
                ("UPDATE moneylens.import_validation_runs SET state='queued' WHERE id=%s",(view["run_id"],)),
                ("UPDATE moneylens.import_batches SET manifest='{}' WHERE id=%s",(identifier,))]
            for statement,params in statements:
                with pytest.raises(psycopg.errors.CheckViolation):
                    with tenant_transaction(connection,member.scope): connection.execute(statement,params)
            for owner in owners[1:]:
                with tenant_transaction(connection,TrustedScope(*owner[:2])):
                    for table in ("native_feeds","import_publications","import_publication_commands","analysis_transactions","analysis_balances"):
                        assert connection.execute("SELECT count(*) FROM moneylens."+table).fetchone()==(0,)
            with connection.transaction():
                connection.execute("SET LOCAL ROLE moneylens_runtime")
                assert connection.execute("SELECT count(*) FROM moneylens.analysis_transactions").fetchone()==(0,)
        with psycopg.connect(database["admin"]) as connection:
            views=connection.execute("SELECT reloptions FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='moneylens' AND c.relname IN ('analysis_transactions','analysis_balances')").fetchall()
            assert len(views)==2 and all("security_invoker=true" in row[0] for row in views)
        foreign=auth(client,"mika")
        assert client.get(path).status_code==404
        assert client.post(path,headers=foreign,json={"key":"foreign-publish"}).status_code==404
        assert client.post(path+"/cancel",headers=foreign,json={"key":"foreign-cancel"}).status_code==404
        headers=auth(client)
        with psycopg.connect(database["admin"],autocommit=True) as connection:
            connection.execute("UPDATE moneylens.users SET is_synthetic=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
        denied=client.get(QUERY)
        assert denied.status_code==409 and denied.json()["error"]["code"]=="IMPORT_ACCOUNT_ACCESS_REQUIRED"
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            with tenant_transaction(connection,member.scope):
                assert connection.execute("SELECT count(*) FROM moneylens.analysis_transactions").fetchone()==(0,)
                assert connection.execute("SELECT count(*) FROM moneylens.analysis_balances").fetchone()==(0,)
