"""Isolated admin provisioning and signed test-issuer callback, never Auth0."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4
import os
from pathlib import Path
import subprocess
import sys
import time

from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
import psycopg
import pytest

from scripts.provision_oidc_member import provision_member, ProvisioningError
from app.auth_routes import cookie_name
from app.identity import AuthError
from app.oidc import OIDC
from identity_support import authenticated_app, ORIGIN

ISSUER="https://identity.example"
OPTIONS=dict(allow_demo=False,live_banking_enabled=False,model_enabled=False,oidc_issuer=ISSUER,oidc_client_id="moneylens",oidc_client_secret="test-only-secret",
    oidc_authorization_url=ISSUER+"/authorize",oidc_token_url=ISSUER+"/token",oidc_jwks_url=ISSUER+"/keys")


def provision(connection, subject="auth0|test-invited"):
    return provision_member(connection,issuer=ISSUER,user_id=subject,expected_issuer=ISSUER)


def test_administrator_cli_uses_only_supplied_test_environment_and_is_repeatable(database):
    subject='auth0|cli-'+uuid4().hex
    env={key:value for key,value in os.environ.items() if not key.startswith('MONEYLENS_')}
    env.update(MONEYLENS_MIGRATION_DATABASE_URL=database['admin'],MONEYLENS_OIDC_ISSUER=ISSUER)
    command=[sys.executable,'scripts/provision_oidc_member.py','--issuer',ISSUER,'--user-id',subject]
    first=subprocess.run(command,cwd=Path(__file__).resolve().parents[2],env=env,capture_output=True,text=True)
    again=subprocess.run(command,cwd=Path(__file__).resolve().parents[2],env=env,capture_output=True,text=True)
    assert first.returncode==again.returncode==0
    assert first.stdout.strip()=='Money Coach access created.'
    assert again.stdout.strip()=='Money Coach access is already set up. No changes made.'
    assert subject not in first.stdout+first.stderr+again.stdout+again.stderr
    assert database['admin'] not in first.stdout+first.stderr


def signed_callback(client, app, config, subject, *, prompt=False):
    private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    public={**jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key(),as_dict=True),"kid":"invitation-test"}
    response=client.get("/v1/auth/login",params={"prompt":"login"} if prompt else {},follow_redirects=False)
    assert response.status_code==303
    query=parse_qs(urlsplit(response.headers["location"]).query);state=query["state"][0]
    if prompt:assert query['prompt']==['login'] and query['max_age']==['0']
    def respond(request):
        if str(request.url)==config.oidc_jwks_url:return httpx.Response(200,json={"keys":[public]})
        assert str(request.url)==config.oidc_token_url
        assert parse_qs(request.content.decode())["code_verifier"]==[app.state.oidc.verifier(state)]
        now=int(time.time())
        token=jwt.encode(dict(sub=subject,iss=ISSUER,aud="moneylens",iat=now,exp=now+600,auth_time=now,
            nonce=app.state.oidc.nonce(state)),private,algorithm="RS256",headers={"kid":"invitation-test"})
        return httpx.Response(200,json={"id_token":token,"access_token":"test-backend-only"})
    app.state.oidc.close();app.state.oidc=OIDC(config,httpx.Client(transport=httpx.MockTransport(respond)))
    params={"code":"test-code","state":state,"iss":ISSUER}
    response=client.get("/v1/auth/callback",params=params,follow_redirects=False)
    assert client.get("/v1/auth/callback",params=params,follow_redirects=False).status_code==400
    return response


def test_provision_is_atomic_idempotent_and_serializes_same_identity(database):
    subject="auth0|"+uuid4().hex
    def create():
        with psycopg.connect(database["admin"],autocommit=True) as connection:return provision(connection,subject)
    with ThreadPoolExecutor(max_workers=2) as executor:assert sorted(executor.map(lambda _:create(),range(2)))==['already_ready','created']
    with psycopg.connect(database['admin']) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.users WHERE subject_issuer=%s AND subject_id=%s",(ISSUER,subject)).fetchone()[0]==1
        assert connection.execute("SELECT count(*) FROM moneylens.user_state s JOIN moneylens.users u ON (u.tenant_id,u.id)=(s.tenant_id,s.owner_user_id) WHERE u.subject_issuer=%s AND u.subject_id=%s",(ISSUER,subject)).fetchone()[0]==1


def test_provision_rollback_on_incomplete_insert_and_no_runtime_privileges(database):
    with psycopg.connect(database['admin'],autocommit=True) as connection:
        before=connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone()[0]
        connection.execute("CREATE FUNCTION public.reject_invitation_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$")
        connection.execute("CREATE TRIGGER reject_invitation_test BEFORE INSERT ON moneylens.user_state FOR EACH ROW EXECUTE FUNCTION public.reject_invitation_test()")
        try:
            with pytest.raises(psycopg.Error):provision(connection)
            assert connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone()[0]==before
            assert connection.execute("SELECT count(*) FROM moneylens.users WHERE subject_issuer=%s AND subject_id=%s",(ISSUER,"auth0|test-invited")).fetchone()[0]==0
        finally:
            connection.execute("DROP TRIGGER reject_invitation_test ON moneylens.user_state")
            connection.execute("DROP FUNCTION public.reject_invitation_test()")
    for role in ('runtime','auth'):
        with psycopg.connect(database[role],autocommit=True) as connection:
            with pytest.raises(ProvisioningError,match="administrator"):provision(connection)


@pytest.mark.parametrize('case',['disabled','synthetic','ambiguous','active_and_disabled','incomplete'])
def test_admin_stops_on_conflicting_or_disabled_mapping(database,owners,case):
    with psycopg.connect(database['admin'],autocommit=True) as connection:
        connection.execute("UPDATE moneylens.users SET subject_issuer=%s,subject_id=%s,active=%s,is_synthetic=%s WHERE tenant_id=%s AND id=%s",
            (ISSUER,'auth0|blocked',case!='disabled',case=='synthetic',*owners[0][:2]))
        if case in ('ambiguous','active_and_disabled'):
            connection.execute("UPDATE moneylens.users SET subject_issuer=%s,subject_id=%s,active=%s WHERE tenant_id=%s AND id=%s",(ISSUER,'auth0|blocked',case=='ambiguous',*owners[2][:2]))
        if case=='incomplete':connection.execute("DELETE FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
        before=connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone()[0]
        with pytest.raises(ProvisioningError):provision(connection,'auth0|blocked')
        assert connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone()[0]==before
        with pytest.raises(ProvisioningError):provision_member(connection,issuer=ISSUER+'/',user_id='auth0|wrong',expected_issuer=ISSUER)


@pytest.mark.parametrize('case',['missing','disabled','ambiguous','active_and_disabled'])
def test_verified_identity_without_eligible_membership_gets_access_page_and_no_session(database,owners,case):
    with authenticated_app(database,owners,**OPTIONS) as (client,app,config):
        previous=app.state.identity.login('integration',str(owners[2][1]))
        client.cookies.set(cookie_name(config),previous)
        with psycopg.connect(database['admin'],autocommit=True) as connection:
            if case!='missing':
                connection.execute("UPDATE moneylens.users SET subject_issuer=%s,subject_id=%s,active=%s,is_synthetic=false WHERE tenant_id=%s AND id=%s",(ISSUER,'auth0|not-ready',case!='disabled',*owners[0][:2]))
            if case in ('ambiguous','active_and_disabled'):
                connection.execute("UPDATE moneylens.users SET subject_issuer=%s,subject_id=%s,active=%s,is_synthetic=false WHERE tenant_id=%s AND id=%s",(ISSUER,'auth0|not-ready',case=='ambiguous',*owners[2][:2]))
            before=connection.execute("SELECT count(*) FROM moneylens_identity.sessions").fetchone()[0]
        response=signed_callback(client,app,config,'auth0|not-ready',prompt=True)
        assert response.status_code==303 and response.headers['location']==ORIGIN+'/access'
        assert 'test-backend-only' not in str(response.headers) and 'not-ready' not in str(response.headers)
        assert client.get('/v1/auth/session').status_code==401
        with pytest.raises(AuthError):app.state.identity.resolve(previous)
        with psycopg.connect(database['admin']) as connection:assert connection.execute("SELECT count(*) FROM moneylens_identity.sessions").fetchone()[0]==before


def test_invited_member_reaches_empty_dashboard_after_real_signed_callback(database,owners):
    with psycopg.connect(database['admin'],autocommit=True) as connection:assert provision(connection)=="created"
    with authenticated_app(database,owners,**OPTIONS) as (client,app,config):
        response=signed_callback(client,app,config,'auth0|test-invited')
        assert response.status_code==303 and response.headers['location']==ORIGIN+'/'
        assert client.get('/v1/auth/session').json()['synthetic'] is False
        dashboard=client.get('/v1/dashboard').json()
        assert dashboard['accounts']==[] and dashboard['connected_bank_count']==0
        assert client.get('/v1/live-banking/capabilities').json()['enabled'] is False
