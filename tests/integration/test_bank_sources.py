"""Source metadata and truthful finite history coverage through real HTTP/SQL."""
from datetime import timedelta
import json
import psycopg

from app.bank_fetch import run_fetch_once
from app.bank_publish_worker import run_publish_once
from identity_support import authenticated_app
from test_bank_routes import NOW, finish, headers, start
from test_bank_publication import connect, synchronize
from test_bank_fetch import enqueue

PERIOD="start=2026-10-01&end_exclusive=2026-11-01"


def bank_account(client):
    accounts=client.get("/v1/accounts/sources").json()
    return next(account for account in accounts if account["source"] is not None)


def test_unverified_accounts_never_imply_whole_finance_or_zero_history(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.get("/v1/accounts/sources").status_code==401
        headers(client)
        response=client.get("/v1/analysis/spending?"+PERIOD)
        assert response.status_code==200,response.text
        result=response.json()
        assert result["net_minor"]==0 and result["scope"]["dataset_coverage"]=="unverified"
        assert result["scope"]["unverified_account_ids"]==[str(owners[0][2])]
        assert result["scope"]["sources"]==[] and result["scope"]["whole_finances_confirmed"] is False
        assert result["scope"]["scope_kind"]=="included_accounts"
        assert any("Zero observed records" in item for item in result["limitations"])
        assert client.get("/v1/accounts/sources").json()[0]["source"] is None
        assert "source" not in client.get("/v1/accounts").json()[0]


def test_owned_source_times_coverage_and_scope_are_explicit_in_every_reader(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        account=bank_account(client)
        source=account["source"]
        assert source["account_id"]==account["id"] and source["connection_id"]==first["connection"]["id"]
        assert source["mode"]=="synthetic" and source["institution_id"]=="s-bank-demo"
        assert source["granted"] and source["sync_health"]=="fresh"
        assert source["observed_at"]==NOW.isoformat().replace("+00:00","Z")
        assert (source["history_from"],source["history_to_exclusive"])==("2026-08-01","2026-11-05")
        assert "amount_minor" not in json.dumps(source)
        whole=client.get("/v1/analysis/spending?"+PERIOD).json()["scope"]
        assert whole["dataset_coverage"]=="partial" and whole["unverified_account_ids"]==[str(owners[0][2])]
        response=client.get("/v1/analysis/spending?"+PERIOD+"&account_id="+account["id"])
        assert response.status_code==200,response.text
        selected=response.json()["scope"]
        assert selected["dataset_coverage"]=="covered_synthetic_snapshot" and selected["scope_kind"]=="selected_accounts"
        assert selected["whole_finances_confirmed"] is False and selected["unverified_account_ids"]==[]
        assert selected["sources"]==[source]
        context=client.get("/v1/planning/context").json()
        assert next(item for item in context["accounts"] if item["id"]==account["id"])["source"]==source
        headers(client,"mika")
        assert all(item["source"] is None for item in client.get("/v1/accounts/sources").json())
        assert client.get("/v1/analysis/spending?"+PERIOD+"&account_id="+account["id"]).status_code==404


def test_new_staging_observation_does_not_relabel_the_published_account_history(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        previous=bank_account(client)
        now=NOW+timedelta(seconds=31)
        app.state.bank_clock=lambda:now
        enqueue(client,auth,first,"newer")
        secret=config.session_secret.get_secret_value()
        run_fetch_once(database["runtime"],user.scope,secret,clock=lambda:now)
        staged=bank_account(client)
        assert staged["source"]["sync_health"]=="staged"
        assert staged["source"]["observed_at"]==previous["source"]["observed_at"]
        assert staged["source"]["source_version"]==previous["source"]["source_version"]
        query="/v1/analysis/spending?"+PERIOD+"&account_id="+previous["id"]
        assert client.get(query).json()["scope"]["dataset_coverage"]=="partial"
        run_publish_once(database["runtime"],user.scope,secret,clock=lambda:now)
        published=bank_account(client)
        assert published["source"]["observed_at"]==now.isoformat().replace("+00:00","Z")
        assert published["source"]["sync_health"]=="fresh"
        assert client.get(query).json()["scope"]["dataset_coverage"]=="covered_synthetic_snapshot"


def test_missing_old_history_and_unobserved_remainder_of_today_are_partial(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        account=bank_account(client)
        root="/v1/analysis/spending?account_id="+account["id"]
        for dates in ("&start=2026-05-01&end_exclusive=2026-06-01","&start=2026-11-04&end_exclusive=2026-11-05"):
            response=client.get(root+dates)
            assert response.status_code==200,response.text
            assert response.json()["scope"]["dataset_coverage"]=="partial"
        assert client.get(root+"&start=2026-05-01&end_exclusive=2026-06-01").json()["net_minor"]==0


def test_unhealthy_source_and_revoked_access_have_separate_inspectable_metadata(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        url=f"/v1/bank-connections/{first['connection']['id']}"
        client.post(url+"/scenario",headers=auth,json={"fault":"unavailable"})
        now=NOW+timedelta(seconds=31)
        app.state.bank_clock=lambda:now
        enqueue(client,auth,first,"failure")
        run_fetch_once(database["runtime"],user.scope,config.session_secret.get_secret_value(),clock=lambda:now)
        account=bank_account(client)
        assert account["source"]["granted"] and account["source"]["sync_health"]=="error"
        assert account["source"]["last_error_code"]=="bank_unavailable"
        assert account["source"]["observed_at"]==NOW.isoformat().replace("+00:00","Z")
        query="/v1/analysis/spending?"+PERIOD+"&account_id="+account["id"]
        assert client.get(query).json()["scope"]["dataset_coverage"]=="partial"
        client.post(url+"/disconnect",headers=auth)
        revoked=bank_account(client)["source"]
        assert revoked["consent_state"]=="revoked" and not revoked["granted"]
        assert revoked["sync_health"]=="error" # Health is not a consent enum.
        assert client.get(query).status_code==409


def test_reconnection_returns_one_current_canonical_source_per_account(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        previous=bank_account(client)
        client.post(f"/v1/bank-connections/{first['connection']['id']}/disconnect",headers=auth)
        replacement=start(client,auth,"s-bank-demo","replacement"); finish(client,auth,replacement)
        synchronize(database,client,app,config,auth,replacement,user,key="replacement",now=NOW+timedelta(seconds=31))
        current=bank_account(client)
        assert current["id"]==previous["id"] and current["source"]["connection_id"]==replacement["connection"]["id"]
        assert current["source"]["granted"]
        scope=client.get("/v1/analysis/spending?"+PERIOD+"&account_id="+current["id"]).json()["scope"]
        assert len(scope["sources"])==1 and scope["sources"][0]["connection_id"]==replacement["connection"]["id"]


def test_natural_expiry_and_source_age_are_read_only_effective_metadata(database,owners):
    with authenticated_app(database,owners,balance_maximum_age_hours=1) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","first")
        synchronize(database,client,app,config,auth,first,user)
        app.state.bank_clock=lambda:NOW+timedelta(minutes=61)
        source=bank_account(client)["source"]
        assert source["consent_state"]=="expired" and not source["granted"]
        assert source["sync_health"]=="stale" and source["observed_at"]==NOW.isoformat().replace("+00:00","Z")
        with psycopg.connect(database["admin"]) as connection:
            assert connection.execute("SELECT consent_state,sync_health FROM moneylens.connections WHERE id=%s",(first["connection"]["id"],)).fetchone()==("active","fresh")
