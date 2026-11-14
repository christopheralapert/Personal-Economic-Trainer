from urllib.parse import parse_qs,urlsplit
import time

from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
import psycopg
import pytest

from app.auth_routes import cookie_name
from app.database import TrustedScope, tenant_transaction
from app.identity import DEMO_ISSUER, digest
from app.jobs import JobStore
from app.oidc import OIDC

from identity_support import ORIGIN,authenticated_app,login


def test_expected_session_header_rejects_cookie_switch_without_changing_authority(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        first = login(client).json()
        expected = {"X-MoneyLens-Session-ID":first["session_id"]}
        assert client.get("/v1/accounts",headers=expected).status_code==200
        second = login(client,"mika").json()
        response = client.get("/v1/accounts",headers=expected)
        assert response.status_code==409 and response.json()["error"]["code"]=="SESSION_CHANGED"
        assert "set-cookie" not in response.headers
        assert client.get("/v1/auth/session").json()["session_id"]==second["session_id"]
        assert client.get("/v1/accounts",headers={"X-MoneyLens-Session-ID":second["session_id"]}).status_code==200
        for value in ("x"*37,"not-a-session",first["session_id"]):
            assert client.get("/v1/accounts",headers={"X-MoneyLens-Session-ID":value}).status_code==409
        # The matching hint cannot authenticate without the opaque cookie.
        client.cookies.clear()
        assert client.get("/v1/accounts",headers={"X-MoneyLens-Session-ID":second["session_id"]}).status_code==401


def test_session_uses_opaque_cookie_and_hash_only_storage(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.get("/v1/accounts").status_code == 401
        response = login(client)
        token = client.cookies.get(cookie_name(config))
        assert len(token)>=40 and token not in response.text
        assert response.json()["owner"]["user_id"] == str(owners[0][1])
        assert response.json()["synthetic"] is True
        assert "HttpOnly" in response.headers["set-cookie"] and "SameSite=lax" in response.headers["set-cookie"]
        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers["referrer-policy"] == "no-referrer"
        with app.state.pools.identity() as connection:
            assert connection.execute("SELECT token_hash FROM moneylens_identity.sessions WHERE token_hash=%s",(digest(token),)).fetchone() == (digest(token),)
        assert token not in repr(app.state.identity.resolve(token))
        assert client.get("/v1/auth/session").json()["csrf_token"] == response.json()["csrf_token"]


def test_same_tenant_profiles_are_separated_and_switch_revokes_old_token(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        old = client.cookies.get(cookie_name(config))
        assert [row["id"] for row in client.get("/v1/accounts",params={"user_id":str(owners[1][1])}).json()] == [str(owners[0][2])]
        login(client,"mika")
        assert [row["id"] for row in client.get("/v1/accounts").json()] == [str(owners[1][2])]
        assert client.get("/v1/accounts",headers={"Cookie":f"{cookie_name(config)}={old}"}).status_code == 401


def test_csrf_origin_and_logout_replay(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.post("/v1/auth/demo",json={"profile":"aino"}).status_code == 403
        assert client.post("/v1/auth/demo",json={"profile":"aino"},headers={"Origin":"https://evil.example"}).status_code == 403
        response = login(client)
        token = client.cookies.get(cookie_name(config))
        csrf = response.json()["csrf_token"]
        for headers in ({"Origin":ORIGIN},{"Origin":"https://evil.example","X-CSRF-Token":csrf},{"Origin":ORIGIN,"X-CSRF-Token":"forged"}):
            assert client.post("/v1/auth/logout",headers=headers).status_code == 403
        assert client.get("/v1/auth/session").status_code == 200
        response = client.post("/v1/auth/logout",headers={"Origin":ORIGIN,"X-CSRF-Token":csrf})
        assert response.status_code == 204 and response.content == b""
        assert client.get("/v1/accounts",headers={"Cookie":f"{cookie_name(config)}={token}"}).status_code == 401


@pytest.mark.parametrize("change", ["expired","idle","disabled","generation"])
def test_expiry_and_membership_changes_stop_existing_session(database,owners,change):
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        token = client.cookies.get(cookie_name(config))
        with psycopg.connect(database["admin"],autocommit=True) as connection:
            if change == "expired":
                connection.execute("""UPDATE moneylens_identity.sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 second'
                    WHERE token_hash=%s""",(digest(token),))
            elif change == "idle":
                connection.execute("UPDATE moneylens_identity.sessions SET last_seen_at=now()-interval '2 hours' WHERE token_hash=%s",(digest(token),))
            elif change == "disabled":
                connection.execute("UPDATE moneylens.users SET active=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
            else:
                connection.execute("UPDATE moneylens.users SET permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
        assert client.get("/v1/accounts").status_code == 401


def test_identity_and_finance_database_roles_cannot_cross_boundaries(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        with app.state.pools.identity() as connection:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with connection.transaction():
                    connection.execute("SELECT * FROM moneylens.accounts")
        with app.state.pools.finance.connection() as connection:
            with tenant_transaction(connection,TrustedScope(owners[0][0],owners[0][1])):
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    with connection.transaction():
                        connection.execute("SELECT * FROM moneylens_identity.sessions")
        login(client)
        assert client.get("/v1/accounts").status_code == 200


def test_job_status_and_cancellation_are_authorized(database,owners):
    with psycopg.connect(database["runtime"],autocommit=True) as connection:
        with tenant_transaction(connection,TrustedScope(owners[1][0],owners[1][1])):
            job = JobStore(connection,TrustedScope(owners[1][0],owners[1][1])).enqueue("test.private","private",{})
    with authenticated_app(database,owners) as (client,app,config):
        first = login(client)
        assert client.get(f"/v1/jobs/{job}").status_code == 404
        assert client.post(f"/v1/jobs/{job}/cancel",headers={"Origin":ORIGIN,"X-CSRF-Token":first.json()["csrf_token"]}).status_code == 404
        second = login(client,"mika")
        assert client.get(f"/v1/jobs/{job}").json()["state"] == "queued"
        assert client.post(f"/v1/jobs/{job}/cancel",headers={"Origin":ORIGIN,"X-CSRF-Token":second.json()["csrf_token"]}).json() == {"cancelled":True}


def test_synthetic_entry_cannot_map_a_real_identity(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        with psycopg.connect(database["admin"],autocommit=True) as connection:
            connection.execute("UPDATE moneylens.users SET is_synthetic=false WHERE tenant_id=%s AND id=%s",owners[0][:2])
        assert client.post("/v1/auth/demo",json={"profile":"aino"},headers={"Origin":ORIGIN}).status_code == 403
        assert client.post("/v1/auth/demo",json={"profile":"aino","user_id":str(owners[2][1])},headers={"Origin":ORIGIN}).status_code == 422


def test_pooled_connection_context_is_reset_and_timeouts_remain(database,owners):
    with authenticated_app(database,owners,pool_max_size=1) as (client,app,config):
        login(client)
        assert client.get("/v1/accounts").status_code == 200
        with app.state.pools.finance.connection() as connection:
            assert connection.execute("SELECT current_user=session_user,nullif(current_setting('app.user_id',true),'')").fetchone() == (True,None)
            assert connection.execute("SHOW statement_timeout").fetchone()[0] == "5s"
        assert client.get("/health/ready").json()["database"] == "connected"


def test_full_oidc_callback_binds_browser_single_use_state_and_server_membership(database,owners):
    options = {"oidc_issuer":"https://identity.example","oidc_client_id":"moneylens","oidc_client_secret":"test-only-secret",
        "oidc_authorization_url":"https://identity.example/authorize","oidc_token_url":"https://identity.example/token",
        "oidc_jwks_url":"https://identity.example/keys"}
    with authenticated_app(database,owners,**options) as (client,app,config):
        private = rsa.generate_private_key(public_exponent=65537,key_size=2048)
        public = {**jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key(),as_dict=True),"kid":"integration-key"}
        with psycopg.connect(database["admin"],autocommit=True) as connection:
            connection.execute("UPDATE moneylens.users SET subject_issuer=%s,subject_id='verified-subject' WHERE tenant_id=%s AND id=%s",(options["oidc_issuer"],*owners[2][:2]))
        response = client.get("/v1/auth/login",follow_redirects=False)
        assert response.status_code == 303
        state = parse_qs(urlsplit(response.headers["location"]).query)["state"][0]
        def respond(request):
            if str(request.url) == options["oidc_jwks_url"]:
                return httpx.Response(200,json={"keys":[public]})
            assert str(request.url) == options["oidc_token_url"]
            form = parse_qs(request.content.decode())
            assert form["code_verifier"] == [app.state.oidc.verifier(state)]
            now = int(time.time())
            encoded = jwt.encode({"sub":"verified-subject","iss":options["oidc_issuer"],"aud":"moneylens",
                "iat":now,"exp":now+600,"auth_time":now,"nonce":app.state.oidc.nonce(state)},private,algorithm="RS256",headers={"kid":"integration-key"})
            return httpx.Response(200,json={"id_token":encoded,"access_token":"must-never-reach-the-browser"})
        app.state.oidc.close()
        app.state.oidc = OIDC(config,httpx.Client(transport=httpx.MockTransport(respond)))
        path = "/v1/auth/callback"
        params = {"code":"bound-code","state":state,"iss":options["oidc_issuer"]}
        assert client.get(path,params=params,headers={"Cookie":""},follow_redirects=False).status_code == 400
        assert client.get(path,params=[("code","a"),("code","b"),("state",state)],follow_redirects=False).status_code == 400
        response = client.get(path,params=params,follow_redirects=False)
        assert response.status_code == 303 and response.headers["location"] == ORIGIN+"/"
        assert "must-never-reach-the-browser" not in str(response.headers)
        assert [row["id"] for row in client.get("/v1/accounts").json()] == [str(owners[2][2])]
        assert client.get("/v1/auth/session").json()["synthetic"] is False
        assert client.get(path,params=params,follow_redirects=False).status_code == 400


def test_https_cookie_and_disabled_demo_entry(database,owners):
    options = {"allow_demo":False,"app_origin":"https://app.example",
        "oidc_issuer":"https://identity.example","oidc_client_id":"moneylens","oidc_client_secret":"test-only-secret",
        "oidc_authorization_url":"https://identity.example/authorize","oidc_token_url":"https://identity.example/token",
        "oidc_jwks_url":"https://identity.example/keys"}
    with authenticated_app(database,owners,**options) as (client,app,config):
        assert client.post("/v1/auth/demo",json={"profile":"aino"},headers={"Origin":"https://app.example"}).status_code == 404
        token = app.state.identity.login("integration",str(owners[2][1]))
        client.cookies.set(cookie_name(config),token)
        response = client.post("/v1/auth/logout",headers={"Origin":"https://app.example","X-CSRF-Token":app.state.identity.csrf(token)})
        assert "__Host-moneylens_session=" in response.headers["set-cookie"]
        assert "Secure" in response.headers["set-cookie"] and "Domain=" not in response.headers["set-cookie"]
