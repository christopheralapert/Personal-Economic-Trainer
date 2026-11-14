"""Owned discovery, typed metadata sums and publication-bound exploration."""
from uuid import UUID

import psycopg

from app.database import TrustedScope,tenant_transaction
from identity_support import authenticated_app
from test_import_intake import storage,auth,command
from test_import_publication import seed,start,publish


def test_source_catalog_has_bounded_owned_keyset_pages_and_rejects_foreign_anchors(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);identifiers=[]
        for index in range(3):
            response=client.post("/v1/imports",headers=headers,json=command(key=f"catalog-{index}",source=f"catalog-{index}"))
            assert response.status_code==202;identifiers.append(response.json()["import_id"])
        capability=client.get("/v1/imports/capabilities").json()
        assert capability["enabled"] and capability["maximum_manifest_bytes"]==8192 and "bucket" not in capability
        page=client.get("/v1/imports?limit=1");assert page.status_code==200,page.text
        assert page.headers["cache-control"]=="private, no-store"
        seen=[]
        while True:
            body=page.json();assert len(body["rows"])==1
            row=body["rows"][0];seen.append(row["id"])
            assert type(row["total_bytes"]) is int and row["total_bytes"]>0 and row["intake_state"]=="awaiting_uploads"
            assert "object_key" not in row and "url" not in row
            if body["next_before_id"] is None: break
            page=client.get("/v1/imports",params={"limit":1,"before_id":body["next_before_id"]})
        assert len(set(seen))==3 and set(seen)==set(identifiers)
        assert client.get("/v1/imports?limit=51").status_code==422
        foreign=auth(client,"mika")
        assert client.get("/v1/imports").json()["rows"]==[]
        assert client.get("/v1/imports",params={"before_id":identifiers[0]}).status_code==404
        with psycopg.connect(database["runtime"],autocommit=True) as connection:
            with tenant_transaction(connection,TrustedScope(*owners[2][:2])):
                assert connection.execute("SELECT count(*) FROM moneylens.import_batches").fetchone()==(0,)


def test_configuration_or_current_profile_disables_new_intake_without_hiding_own_history(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);assert client.post("/v1/imports",headers=headers,json=command()).status_code==202
        config.imports_enabled=False
        assert not client.get("/v1/imports/capabilities").json()["enabled"]
        assert len(client.get("/v1/imports").json()["rows"])==1
        config.imports_enabled=True
        with psycopg.connect(database["admin"],autocommit=True) as connection:
            connection.execute("UPDATE moneylens.users SET is_synthetic=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
        assert not client.get("/v1/imports/capabilities").json()["enabled"]
        assert len(client.get("/v1/imports").json()["rows"])==1


def test_published_source_exploration_binds_accounts_current_pointer_filters_and_cursors(database,owners,storage):
    with authenticated_app(database,owners,**storage[0]) as (client,app,config):
        headers=auth(client);identifier,path,member=seed(database,client,app,config,headers)
        start(client,headers,path);first=publish(database,client,config,member,path)
        accounts=client.get(path+"/accounts");assert accounts.status_code==200,accounts.text
        account=accounts.json()["accounts"][0]
        query={"start":"2026-10-01","end_exclusive":"2026-11-01","account_id":account["id"],"limit":1}
        response=client.get(path+"/transactions",params=query);assert response.status_code==200,response.text
        page=response.json();assert len(page["rows"])==1 and page["rows"][0]["amount_minor"]==-125
        assert page["next_cursor"] and len(client.get(path+"/transactions",params={**query,"cursor":page["next_cursor"]}).json()["rows"])==1
        assert client.get(path+"/transactions",params={**query,"merchant":"not in source"}).json()["rows"]==[]
        assert client.get(path+"/transactions",params={**query,"account_id":str(owners[0][2])}).status_code==404
        assert client.get("/v1/imports").json()["rows"][0]["publication_state"]=="published"
        next_id,next_path,member=seed(database,client,app,config,headers,version="catalog-next")
        start(client,headers,next_path,key="catalog-next-publish");publish(database,client,config,member,next_path)
        assert client.get(path+"/transactions",params=query).status_code==409
        assert client.get(path+"/accounts").status_code==409
        history=client.get("/v1/imports").json()["rows"]
        assert next(item for item in history if item["id"]==identifier)["publication_state"]=="superseded"
        assert next(item for item in history if item["id"]==next_id)["active"]
        foreign=auth(client,"mika")
        assert client.get(next_path+"/accounts").status_code==404
        assert client.get(next_path+"/transactions",params=query).status_code==404
