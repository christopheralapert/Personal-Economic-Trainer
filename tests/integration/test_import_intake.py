"""Critical private intake boundaries with disposable PostgreSQL/S3 resources."""
import hashlib
import os
from uuid import UUID,uuid4

import boto3
from botocore.config import Config
import httpx
import psycopg
import pytest

from app.database import TrustedScope,tenant_transaction
from app.import_objects import object_key
from app.import_worker import run_import_once
from app.jobs import JobStore
from identity_support import authenticated_app,login,ORIGIN

# Authored fixture bytes, independent of the unapproved candidate dataset.
FILES={"accounts":b"source_id,currency\naccount-1,EUR\n",
    "transactions":b"source_id,account_source_id,amount_minor\ntx-1,account-1,-125\n"}


@pytest.fixture
def storage():
    endpoint=os.environ.get("MONEYLENS_TEST_S3_ENDPOINT")
    if not endpoint: pytest.skip("Set MONEYLENS_TEST_S3_ENDPOINT for private intake verification")
    options=dict(imports_enabled=True,object_store_endpoint=endpoint,
        object_store_bucket="ml-import-test-"+uuid4().hex,
        object_store_access_key=os.environ["MONEYLENS_TEST_S3_ACCESS_KEY"],
        object_store_secret_key=os.environ["MONEYLENS_TEST_S3_SECRET_KEY"])
    client=boto3.client("s3",endpoint_url=endpoint,aws_access_key_id=options["object_store_access_key"],
        aws_secret_access_key=options["object_store_secret_key"],region_name="us-east-1",
        config=Config(signature_version="s3v4",s3={"addressing_style":"path"}))
    bucket=options["object_store_bucket"]
    client.create_bucket(Bucket=bucket)
    try: yield options,client
    finally:
        # Only the uniquely named bucket created by this fixture is removed.
        for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket):
            for item in page.get("Contents",[]): client.delete_object(Bucket=bucket,Key=item["Key"])
        client.delete_bucket(Bucket=bucket)
        client.close()


def auth(client,profile="aino"):
    body=login(client,profile).json()
    return {"Origin":ORIGIN,"X-CSRF-Token":body["csrf_token"],"X-MoneyLens-Session-ID":body["session_id"]}


def command(key="start",source="authored-v1"):
    return {"key":key,"manifest":{"mapping_version":"moneylens.synthetic-csv.v1",
        "source_version":source,"source_customer_ref":"synthetic-1","currency":"EUR","timezone":"Europe/Helsinki",
        "claimed_from":"2026-10-01","claimed_to_exclusive":"2026-11-01",
        "files":[{"role":role,"size_bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()} for role,data in FILES.items()]}}


def start(client,headers,**kwargs):
    response=client.post("/v1/imports",headers=headers,json=command(**kwargs))
    assert response.status_code==202,response.text
    return response.json()


def links(client,headers,receipt):
    response=client.post(f"/v1/imports/{receipt['import_id']}/upload-links",headers=headers,json={})
    assert response.status_code==200
    assert response.headers["cache-control"]=="private, no-store"
    return response.json()["files"]


def upload(items):
    with httpx.Client(trust_env=False,timeout=10) as http:
        for item in items:
            response=http.put(item["url"],headers=item["headers"],content=FILES[item["role"]])
            assert response.status_code==200


def submit(client,headers,receipt,key="submit"):
    response=client.post(f"/v1/imports/{receipt['import_id']}/submit",headers=headers,json={"key":key})
    assert response.status_code==202,response.text
    return response.json()


def user(app,client):
    return app.state.identity.resolve(client.cookies.get("moneylens_session"))


def financial_facts(database,owner):
    with psycopg.connect(database["admin"]) as connection:
        counts=[connection.execute("SELECT count(*) FROM moneylens."+table+" WHERE tenant_id=%s AND owner_user_id=%s",owner[:2]).fetchone()[0]
            for table in ("accounts","transactions","balance_snapshots","allocations")]
        return counts,connection.execute("SELECT data_version FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",owner[:2]).fetchone()


def test_write_only_upload_verified_once_without_financial_publication(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);original=financial_facts(database,owners[0])
        receipt=start(client,headers);identifier=receipt["import_id"]
        assert start(client,headers)==receipt
        assert start(client,headers,key="second-key")["import_id"]==identifier
        assert client.post("/v1/imports",headers=headers,json=command(source="different")).status_code==409
        items=links(client,headers,receipt)
        with httpx.Client(trust_env=False,timeout=10) as http:
            item=items[0];data=FILES[item["role"]]
            # The signed checksum and length must be enforced by the real store.
            assert http.put(item["url"],headers=item["headers"],content=b"x"*len(data)).status_code>=400
            assert http.put(item["url"],headers=item["headers"],content=data+b"x").status_code>=400
        upload(items)
        with httpx.Client(trust_env=False,timeout=10) as http:
            assert http.put(items[0]["url"],headers=items[0]["headers"],content=FILES[items[0]["role"]]).status_code in (409,412)
            assert http.get(items[0]["url"].split("?")[0]).status_code>=400
        pending=submit(client,headers,receipt)
        assert submit(client,headers,receipt)==pending
        assert run_import_once(database["runtime"],user(app,client).scope,app.state.import_objects,settings=config)
        view=client.get(f"/v1/imports/{identifier}").json()
        assert view["state"]=="source_ready" and view["source_integrity_verified"] and not view["published"]
        assert view["job"]["state"]=="completed" and all(file["verified_at"] for file in view["files"])
        assert "url" not in str(view) and "etag" not in str(view)
        assert submit(client,headers,receipt)==pending  # historical receipt stays immutable
        assert not run_import_once(database["runtime"],user(app,client).scope,app.state.import_objects,settings=config)
        assert financial_facts(database,owners[0])==original


def test_closed_commands_and_owner_isolation(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);receipt=start(client,headers);path=f"/v1/imports/{receipt['import_id']}"
        assert client.post("/v1/imports",json=command()).status_code==403
        assert client.post("/v1/imports",headers=headers,content=b" "*8193).status_code==413
        for invalid in (dict(command(),owner_user_id=str(owners[1][1])),
                dict(command(),manifest=dict(command()["manifest"],mapping_version="candidate.raw.v1")),
                dict(command(),manifest=dict(command()["manifest"],files=[dict(command()["manifest"]["files"][0],size_bytes=True),command()["manifest"]["files"][1]]))):
            assert client.post("/v1/imports",headers=headers,json=invalid).status_code==422
        assert client.post(path+"/upload-links",headers=headers,json={"key":"arbitrary/key"}).status_code==422
        foreign=auth(client,"mika")
        assert client.get(path).status_code==404
        for action,body in (("upload-links",{}),("submit",{"key":"foreign-submit"}),("cancel",{"key":"foreign-cancel"})):
            assert client.post(path+"/"+action,headers=foreign,json=body).status_code==404
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            for owner in owners[1:]:
                with tenant_transaction(connection,TrustedScope(*owner[:2])):
                    for table in ("import_batches","import_files","import_commands"):
                        assert connection.execute("SELECT count(*) FROM moneylens."+table).fetchone()==(0,)
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with tenant_transaction(connection,TrustedScope(*owners[0][:2])):
                    connection.execute("UPDATE moneylens.import_commands SET receipt='{}'")


def test_cancel_during_object_read_fences_completion_and_replay(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);receipt=start(client,headers);upload(links(client,headers,receipt));submit(client,headers,receipt)
        path=f"/v1/imports/{receipt['import_id']}";cancelled=[];objects=app.state.import_objects
        class CancellingReader:
            def verify(self,*args,**kwargs):
                result=objects.verify(*args,**kwargs)
                if not cancelled:
                    response=client.post(path+"/cancel",headers=headers,json={"key":"cancel"})
                    assert response.status_code==200
                    cancelled.append(response.json())
                return result
        assert run_import_once(database["runtime"],user(app,client).scope,CancellingReader(),settings=config)
        view=client.get(path).json()
        assert view["state"]=="cancelled" and view["job"]["state"]=="cancelled"
        assert not view["source_integrity_verified"] and all(file["verified_at"] is None for file in view["files"])
        assert client.post(path+"/cancel",headers=headers,json={"key":"cancel"}).json()==cancelled[0]
        assert start(client,headers)==receipt


def test_bad_bytes_dead_letter_missing_upload_bounded_retries(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);receipt=start(client,headers);upload(links(client,headers,receipt));member=user(app,client)
        # Trusted test-admin corruption proves the worker checks actual bytes again.
        data=FILES["transactions"]
        storage[1].put_object(Bucket=storage[0]["object_store_bucket"],
            Key=object_key(member.scope,UUID(receipt["import_id"]),"transactions"),Body=b"x"*len(data))
        submit(client,headers,receipt)
        assert run_import_once(database["runtime"],member.scope,app.state.import_objects,settings=config)
        view=client.get(f"/v1/imports/{receipt['import_id']}").json()
        assert view["state"]=="failed" and view["job"]["state"]=="dead_letter"
        assert view["job"]["last_error_code"]=="import_checksum_mismatch"
        assert all(file["verified_at"] is None for file in view["files"])
        missing=start(client,headers,key="missing-start",source="missing-v1")
        submitted=submit(client,headers,missing,key="missing-submit")
        for attempt in range(3):
            with psycopg.connect(database["admin"],autocommit=True) as connection:
                connection.execute("UPDATE moneylens.jobs SET available_at=clock_timestamp() WHERE id=%s",(submitted["job_id"],))
            assert run_import_once(database["runtime"],member.scope,app.state.import_objects,settings=config)
            current=client.get(f"/v1/imports/{missing['import_id']}").json()
            assert current["job"]["attempts"]==attempt+1
            assert current["job"]["last_error_code"]=="import_upload_missing"
        assert current["state"]=="failed" and current["job"]["state"]=="dead_letter"


def test_membership_revocation_during_read_cannot_verify_source(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);receipt=start(client,headers);upload(links(client,headers,receipt));submitted=submit(client,headers,receipt)
        member=user(app,client);objects=app.state.import_objects
        class RevokingReader:
            def verify(self,*args,**kwargs):
                result=objects.verify(*args,**kwargs)
                with psycopg.connect(database["admin"],autocommit=True) as connection:
                    connection.execute("UPDATE moneylens.users SET permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
                return result
        assert run_import_once(database["runtime"],member.scope,RevokingReader(),settings=config)
        with psycopg.connect(database["admin"]) as connection:
            assert connection.execute("SELECT state FROM moneylens.jobs WHERE id=%s",(submitted["job_id"],)).fetchone()==("cancelled",)
            assert connection.execute("SELECT count(*) FROM moneylens.import_files WHERE import_id=%s AND verified_at IS NOT NULL",(receipt["import_id"],)).fetchone()==(0,)
        assert client.get(f"/v1/imports/{receipt['import_id']}").status_code==401


def test_reclaimed_lease_blocks_old_attempt_then_resumes(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);receipt=start(client,headers);upload(links(client,headers,receipt));submitted=submit(client,headers,receipt)
        member=user(app,client);objects=app.state.import_objects;claimed=[]
        class ReclaimingReader:
            def verify(self,*args,**kwargs):
                result=objects.verify(*args,**kwargs)
                if not claimed:
                    with psycopg.connect(database["admin"],autocommit=True) as connection:
                        connection.execute("UPDATE moneylens.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s",(submitted["job_id"],))
                    with psycopg.connect(database["runtime"],autocommit=True) as connection:
                        with tenant_transaction(connection,member.scope):
                            claimed.append(JobStore(connection,member.scope).claim(["import.verify_source"],lease_seconds=300))
                return result
        assert run_import_once(database["runtime"],member.scope,ReclaimingReader(),settings=config)
        view=client.get(f"/v1/imports/{receipt['import_id']}").json()
        assert view["job"]["state"]=="running" and view["state"]=="queued"
        assert all(file["verified_at"] is None for file in view["files"])
        with psycopg.connect(database["admin"],autocommit=True) as connection:
            connection.execute("UPDATE moneylens.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s",(submitted["job_id"],))
        assert run_import_once(database["runtime"],member.scope,objects,settings=config)
        view=client.get(f"/v1/imports/{receipt['import_id']}").json()
        assert view["state"]=="source_ready" and view["job"]["attempts"]==3
