"""Native source -> resumed SQL staging; source integrity never grants publication."""
from contextlib import contextmanager
import csv
import hashlib
import io
from uuid import UUID

import httpx
import psycopg
import pytest

from app import import_csv as native
from app.database import TrustedScope,tenant_transaction
from app.import_objects import object_key
from app.import_validation_store import ImportValidationStore
from app.import_validation_worker import run_validation_once
from app.import_worker import run_import_once
from app.jobs import JobStore
from identity_support import authenticated_app
from test_import_intake import storage,auth,user,financial_facts

CUSTOMER="synthetic-1"
OBSERVED="2026-11-04T10:00:00Z"


def tx(identifier="one",**updates):
    row=dict(source_customer_ref=CUSTOMER,account_ref="daily",source_id=identifier,revision="1",amount_minor="-125",
        currency="EUR",booked_on="2026-10-15",value_on="",observed_at=OBSERVED,status="booked",merchant="Cafe",
        category="coffee",basket="everyday",economic_flow="expense",related_account_ref="",related_source_id="")
    row.update(updates);return row


def csv_bytes(role,rows):
    stream=io.StringIO(newline="");writer=csv.writer(stream,lineterminator="\n")
    writer.writerow(native.COLUMNS[role])
    for row in rows: writer.writerow([row[column] for column in native.COLUMNS[role]])
    return stream.getvalue().encode("utf-8")


def files(rows=None,*,expected_count=None,with_balances=True):
    rows=rows if rows is not None else [tx("one",merchant="Cafe \u00e4\nCounter"),tx("two"),tx("three")]
    count=len(rows) if expected_count is None else expected_count
    account=dict(source_customer_ref=CUSTOMER,account_ref="daily",name="Authored synthetic account",currency="EUR",
        account_type="current",coverage_from="2026-10-01",coverage_to_exclusive="2026-11-01",expected_transactions=str(count),expected_net_minor=str(-125*count))
    result={"accounts":csv_bytes("accounts",[account]),"transactions":csv_bytes("transactions",rows)}
    if with_balances:
        balance=dict(source_customer_ref=CUSTOMER,account_ref="daily",source_id="balance-1",amount_minor="100000",currency="EUR",
            balance_kind="available",pending_reflection="included",included_credit_minor="0",observed_at=OBSERVED)
        result["balances"]=csv_bytes("balances",[balance])
    return result


def seed(database,client,app,config,headers,source):
    manifest=dict(mapping_version="moneylens.synthetic-csv.v1",source_version="native-fixture-v1",source_customer_ref=CUSTOMER,
        currency="EUR",timezone="Europe/Helsinki",claimed_from="2026-10-01",claimed_to_exclusive="2026-11-01",
        files=[dict(role=role,size_bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()) for role,raw in source.items()])
    response=client.post("/v1/imports",headers=headers,json={"key":"source-start","manifest":manifest})
    assert response.status_code==202,response.text
    identifier=response.json()["import_id"];path=f"/v1/imports/{identifier}/validation"
    assert client.post(path,headers=headers,json={"key":"premature"}).status_code==409
    response=client.post(f"/v1/imports/{identifier}/upload-links",headers=headers,json={})
    assert response.status_code==200
    with httpx.Client(trust_env=False,timeout=10) as http:
        for link in response.json()["files"]:
            assert http.put(link["url"],headers=link["headers"],content=source[link["role"]]).status_code==200
    assert client.post(f"/v1/imports/{identifier}/submit",headers=headers,json={"key":"verify-source"}).status_code==202
    member=user(app,client)
    assert run_import_once(database["runtime"],member.scope,app.state.import_objects,settings=config)
    response=client.post(path,headers=headers,json={"key":"validation-start"})
    assert response.status_code==202,response.text
    return identifier,path,response.json(),member


def drain(database,client,app,config,member,path):
    for _ in range(30):
        if not run_validation_once(database["runtime"],member.scope,app.state.import_objects,settings=config): break
    else: pytest.fail("Validation failed to finish within the tiny fixture's chunk budget")
    response=client.get(path);assert response.status_code==200,response.text
    return response.json()


def force_due(database,job_id):
    with psycopg.connect(database["admin"],autocommit=True) as connection:
        connection.execute("UPDATE moneylens.jobs SET available_at=clock_timestamp(),lease_until=clock_timestamp()-interval '1 second' WHERE id=%s",(job_id,))


def test_real_range_resume_and_control_totals_leave_canonical_finances_unchanged(database,owners,storage,monkeypatch):
    monkeypatch.setattr(native,"CHUNK_ROWS",2)
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);before=financial_facts(database,owners[0]);source=files()
        identifier,path,receipt,member=seed(database,client,app,config,headers,source)
        assert client.post(path,headers=headers,json={"key":"validation-start"}).json()==receipt
        ranges=[];objects=app.state.import_objects;original_get=objects.client.get_object
        def recording_get(**kwargs):
            if "Range" in kwargs: ranges.append((kwargs["Range"],kwargs.get("IfMatch")))
            return original_get(**kwargs)
        monkeypatch.setattr(objects.client,"get_object",recording_get)
        assert run_validation_once(database["runtime"],member.scope,objects,settings=config)  # accounts checkpoint
        assert run_validation_once(database["runtime"],member.scope,objects,settings=config)  # first two transactions
        partial=client.get(path).json()
        assert partial["state"]=="queued" and partial["processed_rows"]==3 and partial["accepted_rows"]==3
        assert financial_facts(database,owners[0])==before
        view=drain(database,client,app,config,member,path)
        assert view["state"]=="validated" and view["accepted_rows"]==5 and view["rejected_rows"]==0
        assert all(file["complete"] and file["offset_bytes"]==file["size_bytes"] for file in view["files"])
        assert view["job"]["state"]=="completed" and view["publication"]=="separate_workflow"
        assert any(start!="bytes=0-" and etag for start,etag in ranges)
        assert client.post(path,headers=headers,json={"key":"validation-start"}).json()==receipt
        assert client.get(f"/v1/imports/{identifier}").json()["state"]=="source_ready"
        with psycopg.connect(database["admin"]) as connection:
            assert connection.execute("SELECT count(*),sum(amount_minor) FROM moneylens.import_stage_rows WHERE run_id=%s AND role='transactions'",(view["id"],)).fetchone()==(3,-375)
            payload=connection.execute("SELECT payload FROM moneylens.import_stage_rows WHERE run_id=%s AND role='transactions' AND ordinal=1",(view["id"],)).fetchone()[0]
            assert payload["merchant"]=="Cafe \u00e4\nCounter" and payload["amount_minor"]==-125
        assert financial_facts(database,owners[0])==before


def test_rejections_preserve_private_provenance_and_foreign_owners_see_nothing(database,owners,storage):
    rows=[tx("money",amount_minor="12.50",merchant="private-row-marker"),tx("owner",source_customer_ref="other"),
        tx("currency",currency="USD"),tx("day",booked_on="2026-11-01"),tx("time",observed_at="2026-11-04T10:00:00"),
        tx("missing",account_ref="other-account"),tx("same"),tx("same"),tx("different")]
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);source=files(rows);identifier,path,receipt,member=seed(database,client,app,config,headers,source)
        view=drain(database,client,app,config,member,path)
        assert view["state"]=="invalid" and view["last_error_code"]=="import_rejected_rows"
        assert view["rejected_rows"]==7 and view["accepted_rows"]==4
        after=0;rejected=[]
        while True:
            response=client.get(path+"/rejections",params={"after":after,"limit":2})
            assert response.status_code==200 and response.headers["cache-control"]=="private, no-store"
            assert "private-row-marker" not in response.text
            page=response.json();rejected.extend(page["rows"])
            if page["next_after"] is None: break
            after=page["next_after"]
        assert len(rejected)==7 and len({row["position"] for row in rejected})==7
        assert {row["reasons"][0] for row in rejected}=={"invalid_integer","source_customer_mismatch","currency_mismatch",
            "booking_outside_coverage","invalid_aware_instant","unknown_account_reference","duplicate_source_reference"}
        for row in rejected:
            raw=source[row["role"]][row["byte_start"]:row["byte_end"]]
            assert hashlib.sha256(raw).hexdigest()==row["raw_sha256"]
        assert client.get(path+"/rejections?limit=101").status_code==422
        assert client.post(path,headers=headers,json={"key":"validation-start","owner_user_id":str(owners[1][1])}).status_code==422
        foreign=auth(client,"mika")
        for suffix in ("","/rejections"): assert client.get(path+suffix).status_code==404
        assert client.post(path,headers=foreign,json={"key":"foreign-start"}).status_code==404
        assert client.post(path+"/cancel",headers=foreign,json={"key":"foreign-cancel"}).status_code==404
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            for owner in owners[1:]:
                with tenant_transaction(connection,TrustedScope(*owner[:2])):
                    for table in ("import_validation_runs","import_stage_rows","import_rejected_rows","import_validation_commands"):
                        assert connection.execute("SELECT count(*) FROM moneylens."+table).fetchone()==(0,)
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with tenant_transaction(connection,member.scope): connection.execute("UPDATE moneylens.import_stage_rows SET payload='{}'")


def test_bad_header_and_changed_object_fail_before_any_canonical_publication(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);source=files();source["accounts"]=b"owner_user_id,currency\nforged,EUR\n"
        identifier,path,receipt,member=seed(database,client,app,config,headers,source)
        view=drain(database,client,app,config,member,path)
        assert view["state"]=="invalid" and view["last_error_code"]=="import_csv_header_mismatch"
        assert view["processed_rows"]==0 and view["job"]["state"]=="dead_letter"
        assert client.post(path,headers=headers,json={"key":"new-key-invalid"}).status_code==409


def test_cancelled_chunk_has_no_effect_and_explicit_resume_keeps_prior_checkpoints(database,owners,storage,monkeypatch):
    monkeypatch.setattr(native,"CHUNK_ROWS",2)
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);identifier,path,receipt,member=seed(database,client,app,config,headers,files())
        objects=app.state.import_objects
        assert run_validation_once(database["runtime"],member.scope,objects,settings=config)
        cancellations=[]
        class CancellingReader:
            @contextmanager
            def read_range(self,*args,**kwargs):
                with objects.read_range(*args,**kwargs) as body:
                    response=client.post(path+"/cancel",headers=headers,json={"key":"cancel-validation"})
                    assert response.status_code==200;cancellations.append(response.json())
                    yield body
        assert run_validation_once(database["runtime"],member.scope,CancellingReader(),settings=config)
        view=client.get(path).json()
        assert view["state"]=="cancelled" and view["processed_rows"]==1
        assert client.post(path+"/cancel",headers=headers,json={"key":"cancel-validation"}).json()==cancellations[0]
        assert client.post(path,headers=headers,json={"key":"validation-start"}).json()==receipt
        resumed=client.post(path,headers=headers,json={"key":"explicit-resume"})
        assert resumed.status_code==202 and resumed.json()["run_id"]==receipt["run_id"]
        view=drain(database,client,app,config,member,path)
        assert view["state"]=="validated" and view["generation"]==2 and view["accepted_rows"]==5


def test_lost_lease_and_revoked_membership_cannot_advance_staging(database,owners,storage,monkeypatch):
    monkeypatch.setattr(native,"CHUNK_ROWS",2)
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);identifier,path,receipt,member=seed(database,client,app,config,headers,files())
        objects=app.state.import_objects
        assert run_validation_once(database["runtime"],member.scope,objects,settings=config)
        current=client.get(path).json()["job"]["id"]
        class ReclaimingReader:
            @contextmanager
            def read_range(self,*args,**kwargs):
                with objects.read_range(*args,**kwargs) as body:
                    force_due(database,current)
                    with psycopg.connect(database["runtime"],autocommit=True) as connection:
                        with tenant_transaction(connection,member.scope):
                            assert JobStore(connection,member.scope).claim(["import.validate_chunk"],lease_seconds=120)
                    yield body
        assert run_validation_once(database["runtime"],member.scope,ReclaimingReader(),settings=config)
        assert client.get(path).json()["processed_rows"]==1
        force_due(database,current)
        assert run_validation_once(database["runtime"],member.scope,objects,settings=config)
        assert client.get(path).json()["processed_rows"]==3
        class RevokingReader:
            @contextmanager
            def read_range(self,*args,**kwargs):
                with objects.read_range(*args,**kwargs) as body:
                    with psycopg.connect(database["admin"],autocommit=True) as connection:
                        connection.execute("UPDATE moneylens.users SET permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
                    yield body
        assert run_validation_once(database["runtime"],member.scope,RevokingReader(),settings=config)
        assert client.get(path).status_code==401
        headers=auth(client);view=client.get(path).json()
        assert view["state"]=="cancelled" and view["processed_rows"]==3
        assert client.post(path,headers=headers,json={"key":"resume-current-permission"}).status_code==202
        view=drain(database,client,app,config,user(app,client),path)
        assert view["state"]=="validated" and view["processed_rows"]==5


def test_chunk_insert_checkpoint_next_job_and_completion_rollback_together(database,owners,storage,monkeypatch):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);identifier,path,receipt,member=seed(database,client,app,config,headers,files())
        original=ImportValidationStore.enqueue
        def fail_next(*args,**kwargs): raise RuntimeError("injected failure after staged COPY")
        monkeypatch.setattr(ImportValidationStore,"enqueue",fail_next)
        assert run_validation_once(database["runtime"],member.scope,app.state.import_objects,settings=config)
        view=client.get(path).json()
        assert view["processed_rows"]==0 and view["job"]["state"]=="queued"
        with psycopg.connect(database["admin"]) as connection:
            assert connection.execute("SELECT count(*) FROM moneylens.import_stage_rows WHERE run_id=%s",(receipt["run_id"],)).fetchone()==(0,)
        monkeypatch.setattr(ImportValidationStore,"enqueue",original);force_due(database,view["job"]["id"])
        view=drain(database,client,app,config,member,path)
        assert view["state"]=="validated" and view["accepted_rows"]==5


def test_declared_control_total_mismatch_and_source_mutation_are_distinct_failures(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);identifier,path,receipt,member=seed(database,client,app,config,headers,files(expected_count=99,with_balances=False))
        view=drain(database,client,app,config,member,path)
        assert view["state"]=="invalid" and view["last_error_code"]=="import_control_totals_mismatch"
        assert view["rejected_rows"]==0 and view["accepted_rows"]==4 and view["job"]["state"]=="completed"
        # Another owner/source has an independent validation and object prefix.
        headers=auth(client,"mika");identifier,path,receipt,member=seed(database,client,app,config,headers,files())
        storage[1].put_object(Bucket=storage[0]["object_store_bucket"],
            Key=object_key(member.scope,UUID(identifier),"transactions"),Body=b"changed source")
        view=drain(database,client,app,config,member,path)
        assert view["state"]=="invalid" and view["last_error_code"]=="import_source_changed"
        assert view["accepted_rows"]==1 and view["publication"]=="separate_workflow"
