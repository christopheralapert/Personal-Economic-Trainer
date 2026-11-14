"""Opt-in browser -> production BFF -> signed test OIDC -> isolated PostgreSQL."""
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from urllib.parse import parse_qs

from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
import psycopg
import pytest
import uvicorn

from app.main import create_app
from app.oidc import OIDC
from app.settings import Settings
from scripts.provision_oidc_member import provision_member

ROOT = Path(__file__).resolve().parents[2]
ORIGIN = 'http://127.0.0.1:33111'
ISSUER = 'https://identity.example'


@pytest.mark.skipif(os.environ.get('MONEYLENS_STATEMENT_BROWSER_TEST') != 'true',
                    reason='Requires a dedicated production web build and isolated PostgreSQL')
def test_browser_wise_import_against_isolated_api_and_postgres(database, monkeypatch):
    # Fail on occupied ports; never stop or reuse someone else's services.
    for port in (33111, 18030):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    with psycopg.connect(database['admin'], autocommit=True) as connection:
        for subject in ('wise-browser-a', 'wise-browser-b'):
            provision_member(connection, issuer=ISSUER, user_id=subject, expected_issuer=ISSUER)
        members = connection.execute("SELECT tenant_id,id FROM moneylens.users WHERE subject_issuer=%s AND subject_id=ANY(%s)",
            (ISSUER, ['wise-browser-a', 'wise-browser-b'])).fetchall()
    tenants, users = [row[0] for row in members], [row[1] for row in members]
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = {**jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key(), as_dict=True), 'kid': 'wise-browser'}
    config = Settings(environment='test', allow_demo=False, auth_enabled=True, app_origin=ORIGIN,
        database_url=database['runtime'], auth_database_url=database['auth'],
        session_secret='isolated-wise-browser-session-secret-32-characters',
        statement_imports_enabled=True, model_enabled=False, live_banking_enabled=False,
        oidc_issuer=ISSUER, oidc_client_id='moneylens', oidc_client_secret='test-only',
        oidc_authorization_url=ISSUER+'/authorize', oidc_token_url=ISSUER+'/token', oidc_jwks_url=ISSUER+'/keys')
    app = create_app(config)

    def respond(request):
        if str(request.url) == config.oidc_jwks_url:
            return httpx.Response(200, json={'keys': [public]})
        assert str(request.url) == config.oidc_token_url, 'Unexpected outbound identity request'
        form = parse_qs(request.content.decode())
        subject, state = form['code'][0].split(':', 1)
        assert subject in ('wise-browser-a', 'wise-browser-b', 'wise-browser-unknown')
        assert form['code_verifier'] == [app.state.oidc.verifier(state)]
        assert form['redirect_uri'] == [ORIGIN+'/api/v1/auth/callback']
        now = int(time.time())
        token = jwt.encode(dict(sub=subject, iss=ISSUER, aud='moneylens', iat=now, exp=now+600,
            auth_time=now, nonce=app.state.oidc.nonce(state)), private, algorithm='RS256', headers={'kid': 'wise-browser'})
        return httpx.Response(200, json={'id_token': token, 'access_token': 'test-server-only'})

    monkeypatch.setattr('app.main.OIDC', lambda settings: OIDC(settings, httpx.Client(transport=httpx.MockTransport(respond))))
    listener = socket.socket()
    listener.bind(('127.0.0.1', 18030))
    server = uvicorn.Server(uvicorn.Config(app, log_level='warning', access_log=False))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    clean = {k: v for k, v in os.environ.items() if not k.startswith(('MONEYLENS_', 'MONEY_COACH_', 'OPENAI_'))}
    web_env = {**clean, 'MONEYLENS_STATEMENT_BROWSER_TEST': 'true', 'MONEYLENS_API_URL': 'http://127.0.0.1:18030',
        'MONEYLENS_ALLOW_DEMO': 'false', 'MONEYLENS_OIDC_ISSUER': ISSUER}
    if os.environ.get('MONEYLENS_NEXT_DIST'):
        web_env['MONEYLENS_NEXT_DIST'] = os.environ['MONEYLENS_NEXT_DIST']
    web = None
    thread.start()
    try:
        web = subprocess.Popen(['node', 'node_modules/next/dist/bin/next', 'start', 'frontend/web',
            '--hostname', '127.0.0.1', '--port', '33111'], cwd=ROOT, env=web_env, creationflags=flags)
        for url in ('http://127.0.0.1:18030/health/ready', ORIGIN+'/'):
            for _ in range(100):
                try:
                    if httpx.get(url, timeout=1).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(.2)
            else:
                raise AssertionError('Isolated test server did not start')
        result = subprocess.run(['node', 'node_modules/@playwright/test/cli.js', 'test', '--config',
            'tests/config/playwright.statement.config.ts', '--reporter=line'], cwd=ROOT, env=web_env,
            timeout=180, creationflags=flags, capture_output=True, text=True)
        assert result.returncode == 0, (result.stdout+result.stderr)[-8000:]
        with psycopg.connect(database['admin']) as connection:
            assert connection.execute("SELECT count(*) FROM moneylens.users WHERE subject_id='wise-browser-unknown'").fetchone()[0] == 0
            assert connection.execute('SELECT count(*) FROM moneylens.tenants WHERE id=ANY(%s)', (tenants,)).fetchone()[0] == 2
            assert connection.execute('SELECT count(*) FROM moneylens.user_state WHERE owner_user_id=ANY(%s)', (users,)).fetchone()[0] == 2
            assert connection.execute('SELECT count(*) FROM moneylens.statement_previews WHERE owner_user_id=ANY(%s)', (users,)).fetchone()[0] == 0
            assert connection.execute('SELECT count(*),sum(row_count) FROM moneylens.statement_import_receipts WHERE owner_user_id=ANY(%s)', (users,)).fetchone() == (2, 4)
            counts = connection.execute('''SELECT owner_user_id,count(*),sum(amount_minor)
                FROM moneylens.transactions WHERE owner_user_id=ANY(%s) GROUP BY owner_user_id''', (users,)).fetchall()
            assert len(counts) == 2 and all(row[1:] == (2, -1000) for row in counts)
    finally:
        if web:
            web.terminate()
            try:
                web.wait(timeout=10)
            except subprocess.TimeoutExpired:
                web.kill()
                web.wait()
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
