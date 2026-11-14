"""Real HTTP + restricted PostgreSQL consent authority; no provider/model traffic."""
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID

import psycopg
import pytest

from app.bank_adapter import BankError
from app.bank_store import BankStore
from app.identity import authorized_transaction
from identity_support import ORIGIN, authenticated_app, login
from test_planning_routes import seed_plan

NOW = datetime(2026,11,4,10,tzinfo=timezone.utc)


def headers(client,profile="aino"):
    body = login(client,profile).json()
    return {"Origin":ORIGIN,"X-CSRF-Token":body["csrf_token"],"X-MoneyLens-Session-ID":body["session_id"]}


def start(client,auth,bank="s-bank-demo",key="connect-1"):
    response = client.post("/v1/bank-connections",headers=auth,json={"key":key,"institution_id":bank})
    assert response.status_code==200,response.text
    return response.json()


def callback(started,*,approved=True,key="complete-1"):
    return {"key":key,"state_token":started["state_token"],"approved":approved,
        "account_references":[item["reference"] for item in started["authorization"]["available_accounts"]] if approved else []}


def finish(client,auth,started,**updates):
    return client.post(f"/v1/bank-connections/{started['connection']['id']}/complete",headers=auth,json={**callback(started),**updates})


def database_facts(database,owner):
    with psycopg.connect(database["admin"]) as connection:
        return (connection.execute("SELECT data_version FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",owner[:2]).fetchone()[0],
            connection.execute("SELECT count(*) FROM moneylens.audit_events WHERE tenant_id=%s AND owner_user_id=%s",owner[:2]).fetchone()[0],
            connection.execute("SELECT count(*) FROM moneylens.outbox_events WHERE tenant_id=%s AND owner_user_id=%s",owner[:2]).fetchone()[0])


def test_two_banks_durable_exact_grants_idempotent_callback_and_disconnect(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=lambda:NOW
        auth=headers(client)
        capabilities=client.get("/v1/banks").json()
        assert {item["id"] for item in capabilities}=={"s-bank-demo","north-demo"}
        assert all(item["mode"]=="synthetic" and not item["payments_supported"] for item in capabilities)
        original=database_facts(database,owners[0])
        first=start(client,auth)
        assert first["connection"]["consent_state"]=="authorizing"
        assert first["connection"]["account_references"]==[]
        app.state.bank_clock=lambda:NOW+timedelta(minutes=1)
        assert start(client,auth)==first  # original authorization deadline, no renewal
        assert database_facts(database,owners[0])==(original[0],original[1]+2,original[2]+2)
        approved=finish(client,auth,first)
        assert approved.status_code==200,approved.text
        row=approved.json()
        assert row["consent_state"]=="active" and row["generation"]==2
        assert row["account_references"]==callback(first)["account_references"]
        assert row["sync_health"]=="never_synced" and row["last_success_at"] is None
        persisted=database_facts(database,owners[0])
        assert persisted==(original[0]+1,original[1]+3,original[2]+3)
        assert finish(client,auth,first).json()==row
        assert database_facts(database,owners[0])==persisted
        assert finish(client,auth,first,key="other").status_code==409
        assert start(client,auth)["state_token"] is None
        second=start(client,auth,"north-demo","connect-2")
        assert finish(client,auth,second).status_code==200
        assert len(client.get("/v1/bank-connections").json())==2
        url=f"/v1/bank-connections/{row['id']}"
        response=client.post(url+"/disconnect",headers=auth)
        assert response.status_code==200,response.text
        revoked=response.json()
        assert revoked["consent_state"]=="revoked" and revoked["generation"]==3
        assert revoked["account_references"]==row["account_references"] # retained material scope
        facts=database_facts(database,owners[0])
        assert client.post(url+"/disconnect",headers=auth).json()==revoked
        assert finish(client,auth,first).json()==revoked # late retry cannot reactivate
        assert database_facts(database,owners[0])==facts
        replacement=start(client,auth,key="reconnect")
        assert replacement["connection"]["id"]!=row["id"]
        assert client.get(url).headers["cache-control"]=="private, no-store"


@pytest.mark.parametrize("case",["token","account","duplicate","denied-with-accounts"])
def test_invalid_callback_rolls_back_without_grant_or_events(database,owners,case):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=lambda:NOW
        auth=headers(client); first=start(client,auth)
        payload=callback(first)
        if case=="token": payload["state_token"]="x"*43
        if case=="account": payload["account_references"]=["foreign-account"]
        if case=="duplicate": payload["account_references"]*=2
        if case=="denied-with-accounts": payload["approved"]=False
        prior=database_facts(database,owners[0])
        response=client.post(f"/v1/bank-connections/{first['connection']['id']}/complete",headers=auth,json=payload)
        assert response.status_code in (403,422),response.text
        assert database_facts(database,owners[0])==prior
        assert client.get(f"/v1/bank-connections/{first['connection']['id']}").json()["consent_state"]=="authorizing"
        assert finish(client,auth,first).status_code==200


def test_denial_and_authorization_timeout_never_grant_accounts(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=lambda:NOW
        auth=headers(client); first=start(client,auth)
        response=finish(client,auth,first,approved=False,account_references=[])
        assert response.status_code==200,response.text
        assert response.json()["consent_state"]=="denied" and response.json()["account_references"]==[]
        assert database_facts(database,owners[0])[0]==1
        second=start(client,auth,key="second")
        app.state.bank_clock=lambda:NOW+timedelta(minutes=11)
        assert finish(client,auth,second).status_code==409
        third=start(client,auth,key="third")
        assert third["connection"]["id"]!=second["connection"]["id"]
        old=client.get(f"/v1/bank-connections/{second['connection']['id']}").json()
        assert old["consent_state"]=="expired" and old["account_references"]==[]


def test_owner_session_csrf_and_demo_boundaries(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=lambda:NOW
        assert client.get("/v1/banks").status_code==401
        assert client.get("/v1/bank-connections").status_code==401
        auth=headers(client); first=start(client,auth)
        assert client.post("/v1/bank-connections",json={"key":"x","institution_id":"north-demo"}).status_code==403
        assert client.post("/v1/bank-connections",headers={**auth,"Origin":"https://elsewhere.invalid"},json={"key":"x","institution_id":"north-demo"}).status_code==403
        other=headers(client,"mika")
        url=f"/v1/bank-connections/{first['connection']['id']}"
        assert client.get(url).status_code==404
        assert finish(client,other,first).status_code==404
        assert client.post(url+"/disconnect",headers=other).status_code==404
        assert client.get("/v1/bank-connections").json()==[]
        renewed=headers(client)
        assert finish(client,renewed,first).status_code==403
        assert client.post("/v1/bank-connections",headers=renewed,json={"key":"connect-1","institution_id":"s-bank-demo"}).status_code==409
        assert client.post(url+"/disconnect",headers=renewed).status_code==200
        assert client.get(url,headers={"X-MoneyLens-Session-ID":auth["X-MoneyLens-Session-ID"]}).status_code==409


def test_simulator_controls_change_generation_and_expiry_independently_from_health(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=lambda:NOW
        auth=headers(client); first=start(client,auth); finish(client,auth,first)
        url=f"/v1/bank-connections/{first['connection']['id']}"
        changed=client.post(url+"/scenario",headers=auth,json={"fault":"unavailable"})
        assert changed.status_code==200,changed.text
        assert changed.json()["consent_state"]=="active" and changed.json()["generation"]==3
        assert changed.json()["sync_health"]=="never_synced"
        prior=database_facts(database,owners[0])
        assert client.post(url+"/scenario",headers=auth,json={"fault":"unavailable"}).json()==changed.json()
        assert database_facts(database,owners[0])==prior
        app.state.bank_clock=lambda:NOW+timedelta(hours=1)
        assert client.get(url).json()["consent_state"]=="expired"
        assert client.post(url+"/scenario",headers=auth,json={"fault":"healthy"}).status_code==409
        assert client.post(url+"/disconnect",headers=auth).status_code==200


def test_recreated_store_rechecks_durable_grants_and_generation(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=lambda:NOW
        auth=headers(client); first=start(client,auth); finish(client,auth,first)
        user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        identifier=UUID(first["connection"]["id"])
        with app.state.pools.finance.connection() as connection:
            repository=BankStore(connection,user,config.session_secret.get_secret_value(),clock=lambda:NOW)
            with authorized_transaction(connection,user):
                row=repository.row(identifier)
                old_session=repository.session(row)
                assert repository.adapter(row).list_accounts(old_session)
        client.post(f"/v1/bank-connections/{identifier}/disconnect",headers=auth)
        with app.state.pools.finance.connection() as connection:
            recreated=BankStore(connection,user,config.session_secret.get_secret_value(),clock=lambda:NOW)
            with authorized_transaction(connection,user):
                row=recreated.row(identifier)
                with pytest.raises(BankError,match="consent_scope_changed"):
                    recreated.adapter(row).list_accounts(old_session)
                with pytest.raises(BankError,match="consent_not_active"):
                    recreated.adapter(row).list_accounts(recreated.session(row))


def test_unfetched_material_bank_blocks_current_whole_finance_guidance(database,owners):
    plan=seed_plan(database,owners[0])
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=app.state.planning_clock=lambda:NOW
        auth=headers(client)
        first=start(client,auth); finish(client,auth,first)
        result=client.get(f"/v1/plans/{plan['id']}").json()
        assert not result["current"] and result["analysis"]["result"]["amount_minor"] is None
        # Gate also applies if a quote was obtained before activation; a newer
        # data version alone is not a sufficient source-completeness check.
        with app.state.pools.finance.connection() as connection:
            user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
            from app.bank_access import planning_sources_ready
            from app.identity import AuthError
            with authorized_transaction(connection,user):
                with pytest.raises(AuthError,match="BANK_SOURCE_NOT_READY"):
                    planning_sources_ready(connection,user,NOW)


def test_bounded_strict_callback_and_secret_redaction(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=lambda:NOW
        auth=headers(client); first=start(client,auth)
        url=f"/v1/bank-connections/{first['connection']['id']}/complete"
        for changes in ({"approved":1},{"owner_user_id":str(owners[1][1])},{"account_references":["x"]*51}):
            response=client.post(url,headers=auth,json={**callback(first),**changes})
            assert response.status_code==422 and first["state_token"] not in response.text
        assert client.post(url,headers=auth,content=b" "*8193).status_code==413
        with psycopg.connect(database["admin"]) as connection:
            row=connection.execute("SELECT callback_hash FROM moneylens.connections WHERE id=%s",(first["connection"]["id"],)).fetchone()
            assert len(row[0])==64 and first["state_token"]!=row[0]
        assert config.session_secret.get_secret_value() not in client.get("/v1/bank-connections").text


def test_duplicate_starts_and_callback_disconnect_race_use_one_owner_fence(database,owners):
    from app.identity import AuthError
    with authenticated_app(database,owners) as (client,app,config):
        app.state.bank_clock=lambda:NOW
        auth=headers(client)
        user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        secret=config.session_secret.get_secret_value()
        barrier=Barrier(2)
        def invoke(operation):
            with psycopg.connect(database["runtime"],autocommit=True) as connection:
                repository=BankStore(connection,user,secret,clock=lambda:NOW)
                barrier.wait(timeout=5)
                return operation(repository)
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures=[executor.submit(invoke,lambda repo:repo.start("s-bank-demo",key="same-start")) for _ in range(2)]
            started=[item.result(timeout=10) for item in futures]
        assert started[0]==started[1]
        assert len(client.get("/v1/bank-connections").json())==1
        identifier=started[0]["connection"]["id"]
        body=callback({"state_token":started[0]["state_token"],"authorization":started[0]["authorization"].model_dump(mode="json")})
        def complete(repository):
            try:
                return repository.complete(identifier,**body)["consent_state"]
            except AuthError as exc:
                assert exc.code=="BANK_AUTH_EXPIRED"
                return "closed"
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures=[executor.submit(invoke,complete),executor.submit(invoke,lambda repo:repo.disconnect(identifier)["consent_state"])]
            results=[item.result(timeout=10) for item in futures]
        assert results[0] in ("active","closed") and results[1]=="revoked"
        final=client.get(f"/v1/bank-connections/{identifier}").json()
        assert final["consent_state"]=="revoked" and final["generation"] in (2,3)


def test_non_synthetic_members_cannot_use_simulator_commands(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.users SET is_synthetic=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
        for path in ("/v1/banks","/v1/bank-connections"):
            assert client.get(path).status_code==403
        response=client.post("/v1/bank-connections",headers=auth,json={"key":"x","institution_id":"s-bank-demo"})
        assert response.status_code==403


def test_simulator_routes_are_absent_without_demo_configuration():
    from app.main import create_app
    from app.settings import Settings
    app=create_app(Settings(environment="test",allow_demo=False,auth_enabled=True,
        database_url="postgresql://contracts.invalid/db",auth_database_url="postgresql://identity.invalid/db",
        session_secret="schema-only-not-a-runtime-secret-123",
        oidc_issuer="https://identity.invalid",oidc_client_id="synthetic-test",oidc_client_secret="fake-only",
        oidc_authorization_url="https://identity.invalid/authorize",oidc_token_url="https://identity.invalid/token",
        oidc_jwks_url="https://identity.invalid/keys"))
    assert not any(path.startswith(("/v1/banks","/v1/bank-connections")) for path in app.openapi()["paths"])
