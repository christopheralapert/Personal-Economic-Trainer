"""Explicitly isolated preview: signed test OIDC, PostgreSQL, native Gemini with fake HTTP.

Never imported by the ordinary API. Does not read .env or permit paid inference.
"""
import argparse
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import html
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend/api'))
import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException, Request
from fastapi.responses import HTMLResponse
from psycopg.conninfo import conninfo_to_dict
import uvicorn
import app.main as main_module
from app.gemini_adapter import GEMINI_ENDPOINT, GeminiFunctions
from app.oidc import OIDC
from app.settings import Settings

SUBJECTS = ('model-review', 'other-owner', 'fresh-preview')
CONTROL = 'synthetic-amount-guard'
QUESTIONS = {
    'how much did i spend on taxis last month?',
    'paljonko käytin takseihin viime kuussa?',
    'kui palju kulutasin taksodele eelmisel kuul?',
    'how much did i spend on taxis in october 2026?',
    'paljonko käytin takseihin lokakuussa 2026?',
    'kui palju kulutasin taksodele oktoobris 2026?',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-only', action='store_true', required=True)
    parser.add_argument('--port', type=int, default=33129)
    parser.add_argument('--api-port', type=int, default=18049)
    parser.add_argument('--dist', default='.next/amount-guard-33129')
    args = parser.parse_args()
    if not all(1024 <= port <= 65535 for port in (args.port, args.api_port)) or args.port == args.api_port:
        raise SystemExit('Choose two distinct unprivileged loopback ports.')
    artifact = (ROOT / 'frontend/web' / args.dist).resolve()
    if not artifact.is_relative_to((ROOT / 'frontend/web/.next').resolve()) or not (artifact / 'BUILD_ID').is_file():
        raise SystemExit('Build the dedicated production artifact inside frontend/web/.next first.')
    dsn = os.environ.get('MONEYLENS_TEST_DATABASE_URL')
    if not dsn or conninfo_to_dict(dsn).get('host') not in ('127.0.0.1', 'localhost'):
        raise SystemExit('Set MONEYLENS_TEST_DATABASE_URL to a dedicated loopback test administrator database.')
    for port in (args.port, args.api_port):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    spec = importlib.util.spec_from_file_location('guard_preview_database', ROOT / 'tests/integration/conftest.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    generator = module.database.__wrapped__()
    database = next(generator)
    web = None
    origin = f'http://127.0.0.1:{args.port}'
    api_origin = f'http://127.0.0.1:{args.api_port}'
    issuer = 'https://identity.example'
    try:
        config = Settings(environment='test', allow_demo=False, auth_enabled=True, app_origin=origin,
            database_url=database['runtime'], auth_database_url=database['auth'],
            session_secret='isolated-guard-preview-session-secret-at-least-32-characters',
            statement_imports_enabled=True, oidc_self_signup_enabled=True, live_banking_enabled=False,
            oidc_issuer=issuer, oidc_client_id='moneylens', oidc_client_secret='test-only',
            oidc_authorization_url=issuer+'/authorize', oidc_token_url=issuer+'/token', oidc_jwks_url=issuer+'/keys',
            model_enabled=True, model_provider='gemini', model_name='gemini-3.5-flash',
            model_billing_policy='paid_allowed', gemini_api_key='synthetic-test-transport-only',
            model_input_microusd_per_token=1, model_output_microusd_per_token=5)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = {**jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True), 'kid':'guard-preview'}
        counts = {'gemini':0, 'verda':0}
        def identity_response(request):
            if str(request.url) == config.oidc_jwks_url:
                return httpx.Response(200, json={'keys':[public]})
            assert str(request.url) == config.oidc_token_url
            form = parse_qs(request.content.decode())
            subject, state = form['code'][0].split(':', 1)
            assert subject in SUBJECTS
            assert form['code_verifier'] == [app.state.oidc.verifier(state)]
            assert form['redirect_uri'] == [origin+'/api/v1/auth/callback']
            now = int(time.time())
            token = jwt.encode(dict(sub=subject, iss=issuer, aud='moneylens', iat=now, exp=now+600,
                auth_time=now, nonce=app.state.oidc.nonce(state)), key, algorithm='RS256', headers={'kid':'guard-preview'})
            return httpx.Response(200, json={'id_token':token, 'access_token':'synthetic-only'})
        class LocalIdentity(OIDC):
            def authorization_url(self, state, *, reauthenticate=False):
                query = urlsplit(super().authorization_url(state, reauthenticate=reauthenticate)).query
                return api_origin+'/rehearsal/authorize?'+query
        main_module.OIDC = lambda settings: LocalIdentity(settings, httpx.Client(transport=httpx.MockTransport(identity_response)))
        app = main_module.create_app(config)
        def fake_gemini(request):
            assert str(request.url) == GEMINI_ENDPOINT
            counts['gemini'] += 1
            payload = json.loads(request.content)
            question = payload['contents'][0]['parts'][0]['text'].rsplit('\nNew question: ', 1)[-1].strip().casefold()
            supported = question in QUESTIONS
            values = dict(intent='spending' if supported else 'clarification',
                start='2026-10-01' if supported else None, end_exclusive='2026-11-01' if supported else None,
                category='taxi' if supported else None, merchant=None, reduction_basis_points=None, comparison_mode=None)
            return httpx.Response(200, json=dict(candidates=[dict(finishReason='STOP', content=dict(parts=[dict(
                functionCall=dict(name='interpret_money_question', args=values))]))],
                usageMetadata=dict(promptTokenCount=100, candidatesTokenCount=100, totalTokenCount=200)))
        original_lifespan = app.router.lifespan_context
        @asynccontextmanager
        async def lifespan(application):
            async with original_lifespan(application):
                await application.state.model.close()
                application.state.model = GeminiFunctions(config, transport=httpx.MockTransport(fake_gemini))
                application.state.coach_clock = lambda: datetime(2026,11,14,12,tzinfo=timezone.utc)
                yield
        app.router.lifespan_context = lifespan
        def controlled(request):
            if request.headers.get('x-moneylens-rehearsal') != CONTROL:
                raise HTTPException(403)
        @app.get('/rehearsal/counts')
        def model_counts(request:Request):
            controlled(request)
            return {'transport':'mocked-native-gemini', 'real_text':False, 'real_audio':False, **counts}
        @app.get('/rehearsal/authorize', response_class=HTMLResponse)
        def authorize(request:Request):
            state = request.query_params.get('state', '')
            links = []
            for subject in SUBJECTS:
                callback = origin+'/api/v1/auth/callback?'+urlencode(dict(code=subject+':'+state, state=state, iss=issuer))
                links.append('<p><a href="'+html.escape(callback, quote=True)+'">'+subject+'</a></p>')
            return ('<!doctype html><meta name="viewport" content="width=device-width"><title>Isolated test identity</title>'
                '<h1>Isolated synthetic identity</h1><p>Signed local test OIDC, not Auth0 or a bank. Gemini uses a simulated HTTP transport; no paid text or hosted audio.</p>'
                '<p>model-review: sample data after browser setup. fresh-preview: empty workspace. No password.</p>'+''.join(links))
        env = {name:value for name,value in os.environ.items()
            if not name.startswith(('MONEYLENS_', 'MONEY_COACH_', 'GEMINI_', 'OPENAI_', 'VERDA_'))}
        env.update(MONEYLENS_API_URL=api_origin, MONEYLENS_ALLOW_DEMO='false', MONEYLENS_OIDC_ISSUER=issuer,
            MONEYLENS_NEXT_DIST=args.dist, MONEY_COACH_PUBLIC_GEMINI_ENABLED='false', MONEY_COACH_LOCAL_AI_EVALUATION='false',
            MONEY_COACH_GEMINI_VOICE_ENABLED='false', NEXT_TELEMETRY_DISABLED='1')
        web = subprocess.Popen(['node','node_modules/next/dist/bin/next','start','frontend/web',
            '--hostname','127.0.0.1','--port',str(args.port)], cwd=ROOT, env=env,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=args.api_port, log_level='warning', access_log=False))
        @app.post('/rehearsal/shutdown')
        def shutdown(request:Request):
            controlled(request)
            server.should_exit = True
            return {'stopping':'owned isolated preview only'}
        def stop(signum,frame):
            server.should_exit = True
        signal.signal(signal.SIGTERM,stop)
        print(f'Isolated preview {origin}; signed test OIDC; real model text/audio OFF; build '+(artifact/'BUILD_ID').read_text().strip(), flush=True)
        server.run()
    finally:
        if web:
            web.terminate()
            try:
                web.wait(timeout=10)
            except subprocess.TimeoutExpired:
                web.kill()
                web.wait()
        generator.close()


if __name__ == '__main__':
    main()
