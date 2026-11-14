"""Verified test-OIDC callbacks and real isolated PostgreSQL workspace creation."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import base64
import secrets
import threading
import time
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
import httpx
import jwt
import psycopg
import pytest

from app.auth_routes import cookie_name
from app.database import TrustedScope, tenant_transaction
from app.oidc import OIDC
from identity_support import authenticated_app, ORIGIN
from scripts.provision_oidc_member import provision_member

ISSUER = "https://self-signup.example/"
OPTIONS = dict(allow_demo=False, oidc_self_signup_enabled=True,
    oidc_issuer=ISSUER, oidc_client_id="self-signup-test", oidc_client_secret="test-client-secret",
    oidc_authorization_url=ISSUER+"authorize", oidc_token_url=ISSUER+"token", oidc_jwks_url=ISSUER+"keys")


class TestProvider:
    """Offline provider transport: real RSA tokens, one-use codes, PKCE and nonce."""
    __test__ = False

    def __init__(self, config):
        self.config = config
        self.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.public = {**jwt.algorithms.RSAAlgorithm.to_jwk(self.private.public_key(), as_dict=True),
            "kid": "self-signup-test", "alg": "RS256", "use": "sig"}
        self.codes = {}
        self.lock = threading.Lock()
        self.oidc = OIDC(config, httpx.Client(transport=httpx.MockTransport(self.respond)))

    def begin(self, client, subject, *, changes=None, wrong_signature=False):
        response = client.get("/v1/auth/login", follow_redirects=False)
        assert response.status_code == 303
        query = parse_qs(urlsplit(response.headers["location"]).query)
        assert query["client_id"] == [self.config.oidc_client_id]
        assert query["code_challenge_method"] == ["S256"]
        assert query["redirect_uri"] == [self.oidc.redirect_uri]
        state = query["state"][0]
        now = int(time.time())
        claims = dict(iss=ISSUER, sub=subject, aud=self.config.oidc_client_id, iat=now,
            exp=now+600, auth_time=now, nonce=query["nonce"][0], email="same@example.invalid")
        claims.update(changes or {})
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048) if wrong_signature else self.private
        token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "self-signup-test"})
        code = secrets.token_urlsafe(32)
        with self.lock:
            self.codes[code] = (state, token, query["code_challenge"][0])
        return dict(code=code, state=state, iss=ISSUER)

    def respond(self, request):
        if str(request.url) == self.config.oidc_jwks_url:
            return httpx.Response(200, json={"keys": [self.public]})
        assert request.method == "POST" and str(request.url) == self.config.oidc_token_url
        expected = base64.b64encode((self.config.oidc_client_id+":test-client-secret").encode()).decode()
        assert request.headers["Authorization"] == "Basic "+expected
        form = parse_qs(request.content.decode())
        with self.lock:
            state, token, challenge = self.codes.pop(form["code"][0])
        assert form["grant_type"] == ["authorization_code"]
        assert form["code_verifier"] == [self.oidc.verifier(state)]
        assert form["redirect_uri"] == [self.oidc.redirect_uri]
        assert parse_qs(urlsplit(self.oidc.authorization_url(state)).query)["code_challenge"] == [challenge]
        return httpx.Response(200, json={"id_token": token, "access_token": "server-only-test-token"})

    def login(self, client, subject, **kwargs):
        return client.get("/v1/auth/callback", params=self.begin(client, subject, **kwargs), follow_redirects=False)


@contextmanager
def signup_app(database, owners, **overrides):
    with authenticated_app(database, owners, **{**OPTIONS, **overrides}) as (client, app, config):
        provider = TestProvider(config)
        app.state.oidc.close()
        app.state.oidc = provider.oidc
        yield client, app, config, provider


def mapping(connection, subject):
    return connection.execute("""SELECT tenant_id,id,active,is_synthetic,permission_version
        FROM moneylens.users WHERE subject_issuer=%s AND subject_id=%s""", (ISSUER, subject)).fetchall()


def test_new_verified_member_gets_one_empty_workspace_and_returns_to_it(database, owners):
    subject = "auth0|"+uuid4().hex
    with signup_app(database, owners) as (client, app, config, provider):
        first = provider.login(client, subject)
        assert first.status_code == 303 and first.headers["location"] == ORIGIN+"/"
        assert "server-only-test-token" not in str(first.headers)
        session = client.get("/v1/auth/session").json()
        previous = client.cookies.get(cookie_name(config))
        assert session["synthetic"] is False
        assert session["display_name"] == "Money Coach member"
        assert client.get("/v1/accounts").json() == []
        dashboard = client.get("/v1/dashboard")
        assert dashboard.status_code == 200
        assert dashboard.json()["accounts"] == []
        assert provider.login(client, subject).status_code == 303
        again = client.get("/v1/auth/session").json()
        assert again["owner"] == session["owner"] and again["session_id"] != session["session_id"]
        assert client.get("/v1/auth/session", headers={"Cookie": cookie_name(config)+"="+previous}).status_code == 401
        with psycopg.connect(database["admin"]) as connection:
            rows = mapping(connection, subject)
            assert len(rows) == 1 and rows[0][2:] == (True, False, 1)
            assert connection.execute("SELECT count(*) FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s", rows[0][:2]).fetchone() == (1,)


def test_concurrent_first_callbacks_and_administrator_invitation_share_one_workspace(database, owners):
    subject = "auth0|"+uuid4().hex
    with signup_app(database, owners) as (client, app, config, provider):
        browsers = [TestClient(app, base_url=ORIGIN) for _ in range(4)]
        try:
            requests = [provider.begin(browser, subject) for browser in browsers]
            barrier = threading.Barrier(5)

            def callback(index):
                barrier.wait(timeout=10)
                response = browsers[index].get("/v1/auth/callback", params=requests[index], follow_redirects=False)
                assert response.status_code == 303 and response.headers["location"] == ORIGIN+"/"
                return browsers[index].get("/v1/auth/session").json()["owner"]

            def invitation():
                barrier.wait(timeout=10)
                with psycopg.connect(database["admin"]) as connection:
                    return provision_member(connection, issuer=ISSUER, user_id=subject, expected_issuer=ISSUER)

            with ThreadPoolExecutor(max_workers=5) as executor:
                callbacks = [executor.submit(callback, index) for index in range(4)]
                admin = executor.submit(invitation)
                result = [future.result(timeout=20) for future in callbacks]
                assert admin.result(timeout=20) in ("created", "already_ready")
            assert all(owner == result[0] for owner in result)
            with psycopg.connect(database["admin"]) as connection:
                rows = mapping(connection, subject)
                assert len(rows) == 1
                assert connection.execute("SELECT count(*) FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s", rows[0][:2]).fetchone() == (1,)
        finally:
            for browser in browsers:
                browser.close()


@pytest.mark.parametrize("case", ["disabled", "synthetic", "ambiguous", "active_and_disabled", "incomplete"])
def test_signup_cannot_repair_or_bypass_unavailable_membership(database, owners, case):
    subject = "auth0|"+uuid4().hex
    with signup_app(database, owners) as (client, app, config, provider):
        previous = app.state.identity.login("integration", str(owners[2][1]))
        client.cookies.set(cookie_name(config), previous)
        with psycopg.connect(database["admin"], autocommit=True) as connection:
            connection.execute("""UPDATE moneylens.users SET subject_issuer=%s,subject_id=%s,active=%s,is_synthetic=%s
                WHERE tenant_id=%s AND id=%s""", (ISSUER, subject, case != "disabled", case == "synthetic", *owners[0][:2]))
            if case in ("ambiguous", "active_and_disabled"):
                connection.execute("UPDATE moneylens.users SET subject_issuer=%s,subject_id=%s,active=%s WHERE tenant_id=%s AND id=%s",
                    (ISSUER, subject, case == "ambiguous", *owners[2][:2]))
            if case == "incomplete":
                connection.execute("DELETE FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s", owners[0][:2])
            before = connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone()
            original = mapping(connection, subject)
        response = provider.login(client, subject)
        assert response.status_code == 303 and response.headers["location"] == ORIGIN+"/access"
        assert client.get("/v1/auth/session").status_code == 401
        assert client.get("/v1/accounts").status_code == 401
        assert client.get("/v1/auth/session", headers={"Cookie": cookie_name(config)+"="+previous}).status_code == 401
        with psycopg.connect(database["admin"]) as connection:
            assert mapping(connection, subject) == original
            assert connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone() == before


def test_disabled_new_member_stays_blocked_on_later_signin(database, owners):
    subject = "auth0|"+uuid4().hex
    with signup_app(database, owners) as (client, app, config, provider):
        assert provider.login(client, subject).headers["location"] == ORIGIN+"/"
        token = client.cookies.get(cookie_name(config))
        with psycopg.connect(database["admin"], autocommit=True) as connection:
            connection.execute("UPDATE moneylens.users SET active=false WHERE subject_issuer=%s AND subject_id=%s", (ISSUER, subject))
        assert client.get("/v1/accounts").status_code == 401
        assert provider.login(client, subject).headers["location"] == ORIGIN+"/access"
        assert client.get("/v1/auth/session", headers={"Cookie": cookie_name(config)+"="+token}).status_code == 401
        with psycopg.connect(database["admin"]) as connection:
            assert len(mapping(connection, subject)) == 1 and mapping(connection, subject)[0][2] is False


def test_two_new_members_with_same_email_only_see_their_own_records(database, owners):
    with signup_app(database, owners) as (client, app, config, provider):
        other = TestClient(app, base_url=ORIGIN)
        try:
            sessions = []
            for browser in (client, other):
                assert provider.login(browser, "auth0|"+uuid4().hex).headers["location"] == ORIGIN+"/"
                sessions.append(browser.get("/v1/auth/session").json())
                assert browser.get("/v1/accounts").json() == []
            assert sessions[0]["owner"]["tenant_id"] != sessions[1]["owner"]["tenant_id"]
            scopes = [TrustedScope(UUID(s["owner"]["tenant_id"]), UUID(s["owner"]["user_id"])) for s in sessions]
            accounts = [uuid4(), uuid4()]
            for scope, account in zip(scopes, accounts):
                with app.state.pools.finance.connection() as connection, tenant_transaction(connection, scope):
                    connection.execute("""INSERT INTO moneylens.accounts (tenant_id,owner_user_id,id,name,currency,account_type)
                        VALUES (%s,%s,%s,'Private synthetic account','EUR','current')""", (scope.tenant_id, scope.user_id, account))
                    connection.execute("""INSERT INTO moneylens.transactions
                        (tenant_id,owner_user_id,id,account_id,source_id,amount_minor,currency,booked_on,
                         status,merchant,category,basket,economic_flow)
                        VALUES (%s,%s,%s,%s,'private-test-row',-500,'EUR','2026-10-01',
                         'booked','Synthetic private transaction','groceries','everyday','expense')""",
                        (scope.tenant_id, scope.user_id, uuid4(), account))
            for index, browser in enumerate((client, other)):
                assert [a["id"] for a in browser.get("/v1/accounts").json()] == [str(accounts[index])]
                assert [a["id"] for a in browser.get("/v1/dashboard").json()["accounts"]] == [str(accounts[index])]
                with app.state.pools.finance.connection() as connection, tenant_transaction(connection, scopes[index]):
                    # RLS still applies when application owner predicates are absent.
                    assert connection.execute("SELECT id FROM moneylens.accounts").fetchall() == [(accounts[index],)]
                    assert connection.execute("SELECT account_id FROM moneylens.transactions").fetchall() == [(accounts[index],)]
                    assert len(connection.execute("SELECT id FROM moneylens.user_state").fetchall()) == 1
                headers = {"Origin": ORIGIN, "X-CSRF-Token": sessions[index]["csrf_token"]}
                assert browser.post(f"/v1/accounts/{accounts[1-index]}/inclusion", headers=headers,
                    json={"included": False, "expected_data_version": 1}).status_code == 404
                assert browser.get("/v1/accounts", headers={"X-MoneyLens-Session-ID": sessions[1-index]["session_id"]}).status_code == 409
            assert client.post("/v1/settings/ai-payment-descriptions", headers={"Origin": ORIGIN,
                "X-CSRF-Token": sessions[0]["csrf_token"]}, json={"enabled": True}).status_code == 200
            assert client.get("/v1/dashboard").json()["allow_ai_payment_descriptions"] is True
            assert other.get("/v1/dashboard").json()["allow_ai_payment_descriptions"] is False
        finally:
            other.close()


@pytest.mark.parametrize("changes,wrong_signature", [
    ({"iss": ISSUER.rstrip("/")}, False), ({"aud": "other-client"}, False),
    ({"nonce": "forged"}, False), ({"sub": ""}, False), ({}, True),
])
def test_invalid_provider_identity_never_creates_workspace(database, owners, changes, wrong_signature):
    subject = "auth0|"+uuid4().hex
    with signup_app(database, owners) as (client, app, config, provider):
        with psycopg.connect(database["admin"]) as connection:
            before = connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone()
        response = provider.login(client, subject, changes=changes, wrong_signature=wrong_signature)
        assert response.status_code == 401
        assert client.get("/v1/auth/session").status_code == 401
        with psycopg.connect(database["admin"]) as connection:
            assert mapping(connection, subject) == []
            assert connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone() == before


def test_browser_binding_replay_and_supplied_owner_do_not_create_other_workspaces(database, owners):
    subject = "auth0|"+uuid4().hex
    with signup_app(database, owners) as (client, app, config, provider):
        params = provider.begin(client, subject)
        assert client.get("/v1/auth/callback", params=params, headers={"Cookie": ""}).status_code == 400
        with psycopg.connect(database["admin"]) as connection:
            assert mapping(connection, subject) == []
        params.update(tenant_id=str(owners[0][0]), user_id=str(owners[0][1]), sub="attacker")
        assert client.get("/v1/auth/callback", params=params, follow_redirects=False).headers["location"] == ORIGIN+"/"
        owner = client.get("/v1/auth/session").json()["owner"]
        assert owner["tenant_id"] != str(owners[0][0])
        assert client.get("/v1/auth/callback", params=params, follow_redirects=False).status_code == 400
        with psycopg.connect(database["admin"]) as connection:
            assert len(mapping(connection, subject)) == 1
            assert mapping(connection, "attacker") == []


def test_same_subject_under_another_issuer_is_not_reused(database, owners):
    subject = "auth0|"+uuid4().hex
    with signup_app(database, owners) as (client, app, config, provider):
        with psycopg.connect(database["admin"], autocommit=True) as connection:
            connection.execute("UPDATE moneylens.users SET subject_issuer=%s,subject_id=%s WHERE tenant_id=%s AND id=%s",
                (ISSUER.rstrip("/"), subject, *owners[2][:2]))
        assert provider.login(client, subject).headers["location"] == ORIGIN+"/"
        assert client.get("/v1/auth/session").json()["owner"]["tenant_id"] != str(owners[2][0])


def test_signup_is_opt_in_and_existing_invitation_still_works(database, owners):
    subject = "auth0|"+uuid4().hex
    with signup_app(database, owners, oidc_self_signup_enabled=False) as (client, app, config, provider):
        assert provider.login(client, subject).headers["location"] == ORIGIN+"/access"
        with psycopg.connect(database["admin"], autocommit=True) as connection:
            assert mapping(connection, subject) == []
            provision_member(connection, issuer=ISSUER, user_id=subject, expected_issuer=ISSUER)
        assert provider.login(client, subject).headers["location"] == ORIGIN+"/"


@pytest.mark.parametrize("failure_table", ["user_state", "sessions"])
def test_partial_signup_and_session_failure_roll_back_whole_workspace(database, owners, failure_table):
    subject = "auth0|"+uuid4().hex
    schema = "moneylens_identity" if failure_table == "sessions" else "moneylens"
    with signup_app(database, owners) as (client, app, config, provider):
        params = provider.begin(client, subject)
        with psycopg.connect(database["admin"], autocommit=True) as connection:
            before = connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone()
            connection.execute("CREATE FUNCTION public.reject_signup_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$")
            connection.execute(f"CREATE TRIGGER reject_signup_test BEFORE INSERT ON {schema}.{failure_table} FOR EACH ROW EXECUTE FUNCTION public.reject_signup_test()")
            try:
                response = client.get("/v1/auth/callback", params=params, follow_redirects=False)
                assert response.status_code == 500
                assert response.json()["error"]["code"] == "INTERNAL_ERROR"
                assert "test rollback" not in response.text
                assert client.get("/v1/auth/session").status_code == 401
                assert mapping(connection, subject) == []
                assert connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone() == before
            finally:
                connection.execute(f"DROP TRIGGER reject_signup_test ON {schema}.{failure_table}")
                connection.execute("DROP FUNCTION public.reject_signup_test()")
        assert provider.login(client, subject).headers["location"] == ORIGIN+"/"


def test_creation_function_does_not_grant_table_access_or_runtime_signup(database, owners):
    with psycopg.connect(database["admin"]) as connection:
        properties = connection.execute("""SELECT p.prosecdef,p.proconfig,
            has_function_privilege('moneylens_auth',p.oid,'EXECUTE'),
            has_function_privilege('moneylens_runtime',p.oid,'EXECUTE')
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='moneylens_identity' AND p.proname='ensure_workspace'""").fetchone()
        assert properties == (True, ["search_path=pg_catalog, pg_temp"], True, False)
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        connection.execute("SET ROLE moneylens_runtime")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            connection.execute("SELECT * FROM moneylens_identity.ensure_workspace(%s,%s)", (ISSUER, "no-access"))
    with psycopg.connect(database["auth"], autocommit=True) as connection:
        connection.execute("SET ROLE moneylens_auth")
        for query in ("SELECT * FROM moneylens.accounts", "INSERT INTO moneylens.tenants (id,name) VALUES (gen_random_uuid(),'denied')",
            "UPDATE moneylens.users SET active=true", "SELECT * FROM moneylens.user_state"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                connection.execute(query)
