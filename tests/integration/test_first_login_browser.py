"""Opt-in real browser -> signed test issuer -> isolated SQL, no real Auth0/AIS."""
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
import psycopg
import pytest
import uvicorn

from app.main import create_app
from app.settings import Settings
from app.oidc import OIDC
from app.auth_routes import cookie_name
from app.live_banking_provider import LiveProviderError
from scripts.provision_oidc_member import provision_member
from test_live_banking import OfflineAIS

ROOT=Path(__file__).resolve().parents[2]


def test_phone_login_with_signed_issuer_and_isolated_memberships(database,monkeypatch):
    origin=os.environ.get('MONEYLENS_FIRST_LOGIN_BROWSER_ORIGIN')
    if not origin:pytest.skip('Set MONEYLENS_FIRST_LOGIN_BROWSER_ORIGIN to the built loopback frontend')
    assert urlsplit(origin).scheme=='http' and urlsplit(origin).hostname=='127.0.0.1'
    issuer='https://identity.example'
    with psycopg.connect(database['admin'],autocommit=True) as connection:
        for subject in ('auth0|test-browser-invited','auth0|test-browser-returning'):
            provision_member(connection,issuer=issuer,user_id=subject,expected_issuer=issuer)
    private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    public={**jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key(),as_dict=True),'kid':'browser-test-issuer'}
    config=Settings(environment='test',allow_demo=False,auth_enabled=True,app_origin=origin,database_url=database['runtime'],auth_database_url=database['auth'],
        session_secret='isolated-first-login-session-secret-32-characters',model_enabled=False,live_banking_enabled=True,
        enable_banking_environment='sandbox',enable_banking_app_id=str(uuid4()),enable_banking_private_key_pem=private.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode(),
        live_banking_cipher_key=Fernet.generate_key().decode(),oidc_issuer=issuer,oidc_client_id='moneylens',oidc_client_secret='test-only',
        oidc_authorization_url=issuer+'/authorize',oidc_token_url=issuer+'/token',oidc_jwks_url=issuer+'/keys')
    app=create_app(config)
    def respond(request):
        if str(request.url)==config.oidc_jwks_url:return httpx.Response(200,json={'keys':[public]})
        assert str(request.url)==config.oidc_token_url
        form=parse_qs(request.content.decode());mode,state=form['code'][0].split(':',1)
        subject={'unknown':'auth0|test-browser-unknown','invited':'auth0|test-browser-invited','returning':'auth0|test-browser-returning'}[mode]
        assert form['code_verifier']==[app.state.oidc.verifier(state)]
        now=int(time.time());token=jwt.encode(dict(sub=subject,iss=issuer,aud='moneylens',iat=now,exp=now+600,auth_time=now,nonce=app.state.oidc.nonce(state)),private,algorithm='RS256',headers={'kid':'browser-test-issuer'})
        return httpx.Response(200,json={'id_token':token,'access_token':'test-server-only'})
    monkeypatch.setattr('app.main.OIDC',lambda settings:OIDC(settings,httpx.Client(transport=httpx.MockTransport(respond))))
    provider=OfflineAIS();provider.application=lambda callback:'sandbox'
    denied=[False];original_start=provider.start
    def start(**kwargs):
        if denied[0]:raise LiveProviderError('BANK_PROVIDER_ACCESS_DENIED',503)
        return original_start(**kwargs)
    provider.start=start;app.state.live_bank_client=lambda:provider
    listener=socket.socket();listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
    server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=port,log_level='warning',access_log=False))
    thread=threading.Thread(target=server.run,kwargs={'sockets':[listener]},daemon=True);thread.start()
    try:
        for _ in range(100):
            if server.started:break
            time.sleep(.05)
        assert server.started
        base=f'http://127.0.0.1:{port}'
        # Seed the returning member through the actual owned consent endpoints,
        # with the existing offline AIS adapter. No financial import is made.
        token=app.state.identity.login(issuer,'auth0|test-browser-returning')
        with httpx.Client(base_url=base) as client:
            client.cookies.set(cookie_name(config),token)
            session=client.get('/v1/auth/session').json()
            headers={'Origin':origin,'X-CSRF-Token':session['csrf_token'],'X-MoneyLens-Session-ID':session['session_id']}
            assert client.post('/v1/live-banking/connect',headers=headers,json={'name':'LHV','country':'EE'}).status_code==200
            assert client.get('/v1/live-banking/callback',params={'state':provider.state,'code':'offline'},follow_redirects=False).status_code==303
        denied[0]=True
        env=dict(os.environ,MONEYLENS_FIRST_LOGIN_TEST_API=base,MONEYLENS_FIRST_LOGIN_BROWSER_ORIGIN=origin)
        result=subprocess.run(['node','node_modules/@playwright/test/cli.js','test','--config','tests/config/playwright.first-login.config.ts','--reporter=list'],cwd=ROOT,env=env)
        assert result.returncode==0,'First-login browser checks failed; inspect ignored test artifacts'
        with psycopg.connect(database['admin']) as connection:
            assert connection.execute("SELECT count(*) FROM moneylens_identity.sessions s JOIN moneylens.users u ON (u.tenant_id,u.id)=(s.tenant_id,s.user_id) WHERE u.subject_id='auth0|test-browser-unknown'").fetchone()[0]==0
    finally:
        server.should_exit=True;thread.join(timeout=10);listener.close()
