"""Real restricted PostgreSQL + HTTP/session pipeline, with a strictly offline AIS double."""
from datetime import datetime,timedelta,timezone
from uuid import uuid4,UUID
import hashlib
import hmac
import json
import time
import pytest
import psycopg
import httpx
from fastapi.testclient import TestClient
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from pydantic import SecretStr
from app.main import create_app
from app.settings import Settings
from app.auth_routes import cookie_name
from app.identity import authorized_transaction
from app.live_banking_provider import EnableBankingClient,LiveProviderError
from app.live_banking_routes import _rates

ORIGIN="http://127.0.0.1:3000"

class OfflineAIS:
    def configure_psu(self,headers,country,name):
        assert headers.get("Psu-Ip-Address") and headers.get("Psu-User-Agent")
    def __init__(self):
        self.state=None;self.session=str(uuid4());self.accounts=[str(uuid4()),str(uuid4())];self.fail=False;self.conflict=False;self.remote_failure=False;self.expired=False;self.calls=0
    def application(self,callback):
        assert callback==ORIGIN+"/api/v1/live-banking/callback"
        return "sandbox"
    def institutions(self,country):return [{"name":"LHV","country":country,"maximum_consent_validity":86400}]
    def start(self,**kwargs):self.state=kwargs["state"];return "https://auth.enablebanking.com/ais/start?test=offline"
    def authorize(self,code,**kwargs):
        self.calls+=1
        return self.session,self.accounts,datetime.now(timezone.utc)+timedelta(days=1)
    def verify_session(self,session_id,**kwargs):
        assert session_id==self.session
        if self.expired:raise LiveProviderError("BANK_CONSENT_EXPIRED",409)
        return self.accounts,datetime.now(timezone.utc)+timedelta(days=1),{account:hashlib.sha256(("stable"+str(i)).encode()).hexdigest() for i,account in enumerate(self.accounts)}
    def fetch_account(self,account,*,from_date,to_date,identity_ref):
        if self.fail and account==self.accounts[-1]:raise LiveProviderError("BANK_PAGE_LIMIT",422)
        return {"id":account,"identity_ref":identity_ref,"name":"Offline test account","currency":"EUR","account_type":"current","balance_kind":"booked","amount_minor":100000,"observed_at":datetime.now(timezone.utc),"transactions":[{"reference":"a"*64,"amount_minor":-900 if self.conflict else -450,"booked_on":to_date,"merchant":"Offline cafe","category":"dining","basket":"everyday","economic_flow":"expense","status":"booked"}]}
    def revoke(self,session_id):
        if self.remote_failure:raise LiveProviderError()
        assert session_id==self.session

@pytest.fixture
def live(database,owners):
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048).private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()
    config=Settings(environment="test",auth_enabled=True,allow_demo=True,app_origin=ORIGIN,model_enabled=False,database_url=database["runtime"],auth_database_url=database["auth"],session_secret="offline-test-session-secret-32-characters",live_banking_enabled=True,enable_banking_app_id=str(uuid4()),enable_banking_private_key_pem=key,live_banking_cipher_key=Fernet.generate_key().decode(),oidc_issuer="https://identity.invalid",oidc_client_id="offline-test",oidc_client_secret="offline-test-only",oidc_authorization_url="https://identity.invalid/auth",oidc_token_url="https://identity.invalid/token",oidc_jwks_url="https://identity.invalid/jwks")
    config.psu_proxy_secret=SecretStr("offline-test-proxy-secret-of-at-least-32-characters")
    app=create_app(config);provider=OfflineAIS()
    with TestClient(app,base_url=ORIGIN,client=("127.0.0.1",12345)) as client:
        def sign_manual(request):
            if request.method=="POST" and request.url.path.endswith("/refresh"):
                raw=json.dumps({"method":"POST","path":request.url.path,"time":time.time(),
                    "session":request.headers.get("x-moneylens-session-id"),
                    "headers":{"Psu-Ip-Address":"192.0.2.10","Psu-User-Agent":"Offline integration browser"}})
                request.headers["x-moneylens-psu-context"]=raw
                request.headers["x-moneylens-psu-signature"]=hmac.new(config.psu_proxy_secret.get_secret_value().encode(),raw.encode(),hashlib.sha256).hexdigest()
        client.event_hooks["request"].append(sign_manual)
        app.state.live_bank_client=lambda:provider
        def login(index=0):
            token=app.state.identity.login("integration",str(owners[index][1]))
            client.cookies.clear();client.cookies.set(cookie_name(config),token)
            session=client.get("/v1/auth/session").json()
            return {"Origin":ORIGIN,"X-CSRF-Token":session["csrf_token"],"X-MoneyLens-Session-ID":session["session_id"]}
        _rates.clear()
        yield client,app,provider,login,database,owners

def connect(live):
    client,app,provider,login,database,owners=live;headers=login()
    response=client.post("/v1/live-banking/connect",json={"name":"LHV","country":"EE"},headers=headers)
    assert response.status_code==200,response.text
    assert provider.session not in response.text
    callback=client.get("/v1/live-banking/callback",params={"state":provider.state,"code":"offline-authorization"},follow_redirects=False)
    assert callback.status_code==303,callback.text
    bank=client.get("/v1/live-banking/connections").json()[0]
    assert bank["mode"]=="sandbox" and bank["consent_state"]=="active"
    assert callback.headers['location'].endswith(f"/banks?live_status=connected&connection={bank['id']}")
    return headers,bank["id"]

def reset_refresh(database,owner,bank):
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.connections SET last_attempt_at=now()-interval '2 minutes' WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*owner[:2],bank))


def test_offline_production_luminor_is_isolated_from_wise_and_other_owner(live):
    """Offline bank doubles, not evidence of actual Luminor authorization."""
    client,app,_,login,database,owners=live
    headers=login();current=[None];banks={};providers={}
    app.state.live_bank_client=lambda:current[0]
    for name in ("Wise","Luminor"):
        provider=OfflineAIS();providers[name]=provider;current[0]=provider
        provider.application=lambda callback:"production"
        provider.institutions=lambda country:[{"name":n,"country":country,"maximum_consent_validity":86400} for n in ("Wise","Luminor")]
        _rates.clear()  # isolated fixture clock; do not bypass runtime throttles
        response=client.post("/v1/live-banking/connect",headers=headers,json={"name":name,"country":"EE"})
        assert response.status_code==200,response.text
        callback=client.get("/v1/live-banking/callback",params={"state":provider.state,"code":"offline"},follow_redirects=False)
        assert callback.status_code==303,callback.text
        banks[name]=next(b for b in client.get("/v1/live-banking/connections").json() if b["name"]==name)
        assert banks[name]["mode"]=="live" and banks[name]["consent_state"]=="active"
        url=f'/v1/live-banking/connections/{banks[name]["id"]}'
        assert client.post(url+"/refresh",headers={**headers,"X-CSRF-Token":"wrong"},json={}).status_code==403
        assert client.post(url+"/refresh",headers={**headers,"Origin":"https://wrong.invalid"},json={}).status_code==403
        assert client.get(url+"/data").json()["transactions"]==[]
        provider.conflict=name=="Luminor"  # different money, same references, separate bank/account
        assert client.post(url+"/refresh",headers=headers,json={}).status_code==200
        reset_refresh(database,owners[0],banks[name]["id"])
        assert client.post(url+"/refresh",headers=headers,json={}).status_code==200
    wise_url=f'/v1/live-banking/connections/{banks["Wise"]["id"]}'
    luminor_url=f'/v1/live-banking/connections/{banks["Luminor"]["id"]}'
    wise=client.get(wise_url+"/data").json();luminor=client.get(luminor_url+"/data").json()
    assert len(wise["transactions"])==len(luminor["transactions"])==2
    assert {r["id"] for r in wise["transactions"]}.isdisjoint(r["id"] for r in luminor["transactions"])
    assert {r["amount_minor"] for r in wise["transactions"]}=={-450}
    assert {r["amount_minor"] for r in luminor["transactions"]}=={-900}
    other=login(1)
    assert client.get(wise_url+"/data").status_code==404
    assert client.get(luminor_url+"/data").status_code==404
    assert client.post(luminor_url+"/refresh",headers=other,json={}).status_code==404


def test_offline_swedbank_preserves_blocked_wise_and_luminor(live):
    """Production-mode doubles only; never authorizes an actual Swedbank account."""
    client,app,_,login,database,owners=live
    headers=login();current=[None];banks={}
    app.state.live_bank_client=lambda:current[0]
    previous_errors={"Wise":"bank_duplicate_source_id","Luminor":"bank_transaction_id_required"}
    for name in ("Wise","Luminor","Swedbank"):
        provider=OfflineAIS();current[0]=provider
        if name=="Swedbank":
            fetch_account=provider.fetch_account
            provider.fetch_account=lambda *args,_fetch=fetch_account,**kwargs:{**_fetch(*args,**kwargs),"source_account_currency":"XXX"}
        provider.application=lambda callback:"production"
        provider.institutions=lambda country:[{"name":n,"country":country,"maximum_consent_validity":86400}
            for n in ("Wise","Luminor","Swedbank")]
        _rates.clear()  # isolated fixture only, not runtime rate-limit bypass
        started=client.post("/v1/live-banking/connect",headers=headers,json={"name":name,"country":"EE"})
        assert started.status_code==200,started.text
        returned=client.get("/v1/live-banking/callback",params={"state":provider.state,"code":"offline"},follow_redirects=False)
        assert returned.status_code==303,returned.text
        bank=next(b for b in client.get("/v1/live-banking/connections").json() if b["name"]==name)
        banks[name]=bank["id"]
        if name in previous_errors:
            with psycopg.connect(database["admin"]) as connection:
                connection.execute("""UPDATE moneylens.connections SET sync_health='error',last_error_code=%s
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                    (previous_errors[name],*owners[0][:2],bank["id"]))
    url=f'/v1/live-banking/connections/{banks["Swedbank"]}'
    assert client.post(url+"/refresh",headers={**headers,"X-CSRF-Token":"wrong"},json={}).status_code==403
    assert client.post(url+"/refresh",headers={**headers,"Origin":"https://wrong.invalid"},json={}).status_code==403
    result=client.post(url+"/refresh",headers=headers,json={})
    assert result.status_code==200 and result.json()["booked_transactions"]==2
    assert "general currency unspecified" in result.json()["notice"]
    with psycopg.connect(database["admin"]) as connection:
        metadata=connection.execute("""SELECT metadata FROM moneylens.audit_events
            WHERE tenant_id=%s AND owner_user_id=%s AND resource_id=%s AND action='live_bank.observed'
            ORDER BY created_at DESC LIMIT 1""",(*owners[0][:2],banks["Swedbank"])).fetchone()[0]
        assert metadata=={"observed_currency":"EUR","source_currency_unspecified_accounts":2}
    data=client.get(url+"/data").json()
    assert len(data["accounts"])==len(data["transactions"])==2
    assert all(t["currency"]=="EUR" and t["basket"]=="everyday" for t in data["transactions"])
    reset_refresh(database,owners[0],banks["Swedbank"])
    assert client.post(url+"/refresh",headers=headers,json={}).status_code==200
    assert {t["id"] for t in client.get(url+"/data").json()["transactions"]}=={t["id"] for t in data["transactions"]}
    after=client.get("/v1/live-banking/connections").json()
    for name,error in previous_errors.items():
        saved=next(b for b in after if b["name"]==name)
        assert saved["id"]==banks[name] and saved["consent_state"]=="active"
        assert saved["sync_health"]=="error" and saved["last_error_code"]==error
        assert saved["last_success_at"] is None
        assert client.get(f'/v1/live-banking/connections/{banks[name]}/data').json()["transactions"]==[]
    answer=client.post("/v1/coach/query",headers=headers,json={"question":"How much did I spend on dining out this month?"})
    assert answer.status_code==200,answer.text
    artifact=answer.json()["card"]["answer"]["artifact"]["result"]
    assert artifact["scope"]["data_mode"]=="live" and artifact["net_minor"]==900
    other=login(1)
    assert client.get(url+"/data").status_code==404
    assert client.post(url+"/refresh",headers=other,json={}).status_code==404

def test_authority_callback_rls_atomic_import_dedup_and_coach(live):
    client,app,provider,login,database,owners=live
    assert client.get("/v1/live-banking/connections").status_code==401
    headers,bank=connect(live)
    assert client.get("/v1/live-banking/callback",params={"state":provider.state,"code":"again"}).status_code==403
    assert provider.calls==1
    assert client.get("/v1/live-banking/callback",params=[("state",provider.state),("state",provider.state),("code","again")]).status_code==403
    url=f"/v1/live-banking/connections/{bank}"
    assert client.post(url+"/refresh",json={}).status_code==403
    provider.fail=True
    assert client.post(url+"/refresh",headers=headers,json={}).status_code==422
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==0
    provider.fail=False;reset_refresh(database,owners[0],bank)
    result=client.post(url+"/refresh",headers=headers,json={});assert result.status_code==200,result.text
    assert result.json()["booked_transactions"]==2 and result.json()["coverage"]=="partial"
    data=client.get(url+"/data");assert data.status_code==200,data.text
    assert len(data.json()["accounts"])==2 and len(data.json()["transactions"])==2
    assert provider.session not in data.text and provider.accounts[0] not in data.text
    start=datetime.now(timezone.utc).date().isoformat();end=(datetime.now(timezone.utc)+timedelta(days=1)).date().isoformat()
    totals=client.get("/v1/analysis/spending",params={"start":start,"end_exclusive":end});assert totals.status_code==200,totals.text
    assert totals.json()["scope"]["dataset_coverage"]=="partial" and totals.json()["scope"]["data_mode"]=="sandbox"
    answer=client.post("/v1/coach/query",headers=headers,json={"question":"How much did I spend on dining out this month?"})
    assert answer.status_code==200,answer.text
    artifact=answer.json()["card"]["answer"]["artifact"]["result"]
    assert artifact["net_minor"]==900 and artifact["scope"]["data_mode"]=="sandbox"
    assert answer.json()["card"]["answer"]["status"]=="limited"
    review=client.post("/v1/coach/query",headers=headers,json={"question":"What is safe for me to spend this week?"})
    assert review.status_code==200 and review.json()["interpretation"]["status"]=="review_required"
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.accounts SET included=false WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
    hidden=client.post("/v1/coach/query",headers=headers,json={"question":"How much did I spend on dining out this month?"})
    assert hidden.status_code==200 and hidden.json()["card"]["answer"]["artifact"]["result"]["net_minor"]==0
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.accounts SET included=true WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
    throttled=client.post(url+"/refresh",headers=headers,json={})
    assert throttled.status_code==429
    assert throttled.json()["error"]["code"]=="BANK_REFRESH_THROTTLED"
    assert "60 seconds" in throttled.json()["error"]["message"]
    assert throttled.headers["Retry-After"]=="60"
    reset_refresh(database,owners[0],bank);assert client.post(url+"/refresh",headers=headers,json={}).status_code==200
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*),sum(amount_minor) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()==(2,-900)
    other=login(1)
    assert client.get(url+"/data").status_code==404
    assert client.post(url+"/refresh",headers=other,json={}).status_code==404
    assert client.post(url+"/disconnect",headers=other,json={}).status_code==404
    assert client.get("/v1/live-banking/connections").json()==[]
    with app.state.pools.finance.connection() as connection:
        user=app.state.identity.resolve(client.cookies.get(cookie_name(app.state.settings)))
        with authorized_transaction(connection,user):
            assert connection.execute("SELECT count(*) FROM moneylens.live_bank_sessions").fetchone()[0]==0


def test_provider_throttle_preserves_consent_and_does_not_retry(live,monkeypatch):
    client,app,provider,login,database,owners=live
    headers,bank=connect(live);calls=[]
    def limited(*args,**kwargs):
        calls.append(True)
        raise LiveProviderError("BANK_PROVIDER_THROTTLED",429)
    monkeypatch.setattr(provider,"fetch_account",limited)
    response=client.post(f"/v1/live-banking/connections/{bank}/refresh",headers=headers,json={})
    assert response.status_code==429
    assert response.json()["error"]["code"]=="BANK_PROVIDER_THROTTLED"
    assert "Pause import attempts" in response.json()["error"]["message"]
    assert "session or requested access" not in response.text
    assert "Retry-After" not in response.headers  # Unknown provider deadline is separate from local safety pause.
    assert response.json()["error"]["retry_after_known"] is False
    assert len(calls)==1
    status=client.get("/v1/live-banking/connections").json()[0]
    assert status["consent_state"]=="active" and status["last_success_at"] is None
    assert status["last_error_code"]=="bank_provider_throttled"
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==0


def test_provider_wait_survives_restart_then_recovers_without_duplicates(live,monkeypatch):
    client,app,provider,login,database,owners=live
    headers,bank=connect(live);original=provider.fetch_account;calls=[]
    def limited(*args,**kwargs):
        calls.append(True)
        raise LiveProviderError("BANK_ASPSP_RATE_LIMIT_EXCEEDED",429,retry_at=datetime.now(timezone.utc)+timedelta(seconds=120),
            stage="transactions",provider_code="ASPSP_RATE_LIMIT_EXCEEDED",request_id=str(uuid4()))
    monkeypatch.setattr(provider,"fetch_account",limited)
    url=f"/v1/live-banking/connections/{bank}/refresh"
    first=client.post(url,headers=headers,json={})
    assert first.status_code==429 and 119<=int(first.headers["Retry-After"])<=120
    assert first.json()["error"]["stage"]=="transactions"
    assert first.json()["error"]["retry_after_known"] is True
    restarted=create_app(app.state.settings)
    with TestClient(restarted,base_url=ORIGIN,client=("127.0.0.1",12345),cookies=client.cookies) as again:
        restarted.state.live_bank_client=lambda:provider
        status=again.get("/v1/live-banking/connections").json()[0]
        assert status["retry_not_before"] and status["provider_error_code"]=="ASPSP_RATE_LIMIT_EXCEEDED"
        blocked=again.post(url,headers=headers,json={})
        assert blocked.status_code==429 and blocked.json()["error"]["code"]=="BANK_IMPORT_WAIT"
        assert len(calls)==1  # Restart and repeated clicks cannot contact the provider.
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.live_bank_sessions SET retry_not_before=%s WHERE connection_id=%s",(datetime.now(timezone.utc)-timedelta(minutes=2),bank))
    reset_refresh(database,owners[0],bank);monkeypatch.setattr(provider,"fetch_account",original)
    for _ in range(2):
        reset_refresh(database,owners[0],bank)
        recovered=client.post(url,headers=headers,json={})
        assert recovered.status_code==200,recovered.json()
    status=client.get("/v1/live-banking/connections").json()[0]
    assert status["retry_not_before"] is None and status["last_error_code"] is None
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*),count(DISTINCT id) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()==(2,2)


def test_unknown_provider_cooldown_allows_only_three_explicit_attempts(live,monkeypatch):
    client,app,provider,login,database,owners=live
    headers,bank=connect(live);calls=[]
    def limited(*args,**kwargs):
        calls.append(True);raise LiveProviderError("BANK_PROVIDER_THROTTLED",429,stage="balances")
    monkeypatch.setattr(provider,"fetch_account",limited)
    for _ in range(3):
        reset_refresh(database,owners[0],bank)
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.live_bank_sessions SET retry_not_before=%s WHERE connection_id=%s",(datetime.now(timezone.utc)-timedelta(minutes=2),bank))
        response=client.post(f"/v1/live-banking/connections/{bank}/refresh",headers=headers,json={})
        assert response.status_code==429 and response.json()["error"]["retry_after_known"] is False
        assert response.json()["error"]["code"]=="BANK_PROVIDER_THROTTLED"
    blocked=client.post(f"/v1/live-banking/connections/{bank}/refresh",headers=headers,json={})
    assert blocked.status_code==429 and blocked.json()["error"]["code"]=="BANK_RETRY_REVIEW_REQUIRED"
    assert len(calls)==3


def test_simultaneous_clicks_share_one_two_account_import(live,monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    client,app,provider,login,database,owners=live
    headers,bank=connect(live);entered=Event();release=Event();calls=[];original=provider.fetch_account
    def delayed(*args,**kwargs):
        calls.append(True);entered.set();assert release.wait(10)
        return original(*args,**kwargs)
    monkeypatch.setattr(provider,"fetch_account",delayed)
    url=f"/v1/live-banking/connections/{bank}/refresh"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first=pool.submit(client.post,url,headers=headers,json={})
        try:
            assert entered.wait(10)
            second=client.post(url,headers=headers,json={})
            assert second.status_code==202 and second.json()["state"]=="in_progress"
            assert len(calls)==1
        finally:release.set()
        assert first.result().status_code==200
    assert len(calls)==2  # One fetch per selected account, not one per click.


@pytest.mark.parametrize("failure",["foreign_second_balance","broken_second_page"])
def test_two_account_raw_provider_failure_never_publishes_first_account(live,monkeypatch,failure):
    client,app,provider,login,database,owners=live
    headers,bank=connect(live);seen=[]
    def handle(request):
        index=provider.accounts.index(request.url.path.split('/')[2]);seen.append((index,request.url.path.rsplit('/',1)[-1]))
        if request.url.path.endswith('/details'):
            return httpx.Response(200,json={"currency":"XXX","cash_account_type":"CACC"})
        if request.url.path.endswith('/balances'):
            currency="USD" if index==1 and failure=="foreign_second_balance" else "EUR"
            return httpx.Response(200,json={"balances":[{"balance_type":"ITBD","balance_amount":{"currency":currency,"amount":"100.00"}}]})
        if request.url.params.get("continuation_key"):
            return httpx.Response(200,json={"transactions":{"malformed":"private"}})
        row={"entry_reference":f"fixture-stable-{index}","status":"BOOK","credit_debit_indicator":"DBIT",
            "booking_date":datetime.now(timezone.utc).date().isoformat(),"transaction_amount":{"currency":"EUR","amount":"4.50"}}
        return httpx.Response(200,json={"transactions":[row],"continuation_key":"exact-cursor" if index==1 else None})
    raw=EnableBankingClient(str(uuid4()),app.state.settings.enable_banking_private_key_pem.get_secret_value(),transport=httpx.MockTransport(handle))
    monkeypatch.setattr(provider,"fetch_account",raw.fetch_account)
    response=client.post(f"/v1/live-banking/connections/{bank}/refresh",headers=headers,json={})
    expected="BANK_UNSUPPORTED_CURRENCY" if failure=="foreign_second_balance" else "BANK_PROVIDER_INVALID_DATA"
    assert response.json()["error"]["code"]==expected
    assert response.json()["error"]["stage"]==("balances" if failure=="foreign_second_balance" else "transaction_pagination")
    assert any(index==1 for index,_ in seen)
    with psycopg.connect(database["admin"]) as connection:
        for table in ("transactions","accounts","balance_snapshots","account_source_aliases"):
            # The owners fixture already owns one unrelated synthetic account.
            assert connection.execute(f"SELECT count(*) FROM moneylens.{table} WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==(1 if table=="accounts" else 0)


def test_conflicting_refresh_preserves_existing_money_and_local_disconnect_wins(live):
    client,app,provider,login,database,owners=live;headers,bank=connect(live);url=f"/v1/live-banking/connections/{bank}"
    assert client.post(url+"/refresh",headers=headers,json={}).status_code==200
    provider.conflict=True;reset_refresh(database,owners[0],bank)
    assert client.post(url+"/refresh",headers=headers,json={}).status_code==409
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*),sum(amount_minor) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()==(2,-900)
        encrypted=connection.execute("SELECT encrypted_session_id FROM moneylens.live_bank_sessions WHERE connection_id=%s",(bank,)).fetchone()[0]
        assert provider.session not in encrypted
    provider.remote_failure=True
    response=client.post(url+"/disconnect",headers=headers,json={});assert response.status_code==200,response.text
    assert response.json()["consent_state"]=="revoked" and response.json()["revocation_confirmed"] is False
    assert client.get(url+"/data").status_code==409
    assert client.post(url+"/refresh",headers=headers,json={}).status_code==409
    provider.remote_failure=False
    assert client.post(url+"/disconnect",headers=headers,json={}).json()["revocation_confirmed"] is True
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.live_bank_sessions WHERE connection_id=%s",(bank,)).fetchone()[0]==0
        assert connection.execute("SELECT count(*) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==2


def test_expired_callback_wrong_session_and_expired_provider_are_rejected(live):
    client,app,provider,login,database,owners=live;headers=login()
    assert client.post("/v1/live-banking/connect",headers=headers,json={"name":"LHV","country":"EE"}).status_code==200
    state=provider.state;login(1)
    assert client.get("/v1/live-banking/callback",params={"state":state,"code":"wrong-owner"}).status_code==403
    login()
    assert client.get("/v1/live-banking/callback",params={"state":state,"code":"wrong-session"}).status_code==403
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.connections SET authorization_expires_at=now()-interval '1 minute' WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
    assert client.get("/v1/live-banking/callback",params={"state":state,"code":"expired"}).status_code==403
    assert provider.calls==0


def test_demo_principal_cannot_cross_live_boundary(live):
    client,app,provider,login,database,owners=live
    from app.identity import DEMO_ISSUER
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.users SET is_synthetic=true,subject_issuer=%s,subject_id='aino.v1' WHERE tenant_id=%s AND id=%s",(DEMO_ISSUER,*owners[0][:2]))
    response=client.post('/v1/auth/demo',headers={"Origin":ORIGIN},json={"profile":"aino"});assert response.status_code==200
    assert client.get('/v1/live-banking/capabilities').json()['enabled'] is False
    assert client.get('/v1/live-banking/institutions').status_code==403
    assert client.get('/v1/live-banking/connections').status_code==403


def test_expired_consent_cannot_publish(live):
    client,app,provider,login,database,owners=live
    headers,bank=connect(live);provider.expired=True
    response=client.post(f"/v1/live-banking/connections/{bank}/refresh",headers=headers,json={})
    assert response.status_code==409
    assert client.get("/v1/live-banking/connections").json()[0]["consent_state"]=="expired"
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==0


def test_reauthorization_uses_stable_accounts_and_preserves_corrections(live):
    client,app,provider,login,database,owners=live
    headers,bank=connect(live);url=f"/v1/live-banking/connections/{bank}"
    assert client.post(url+"/refresh",headers=headers,json={}).status_code==200
    with psycopg.connect(database["admin"]) as connection:
        original=connection.execute("SELECT id,account_id FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s ORDER BY id",owners[0][:2]).fetchall()
        connection.execute("UPDATE moneylens.transactions SET category='utilities',basket='mandatory_regular' WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
        connection.execute("UPDATE moneylens.accounts SET included=false WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
    assert client.post(url+"/disconnect",headers=headers,json={}).status_code==200
    provider.session=str(uuid4());provider.accounts=[str(uuid4()),str(uuid4())];_rates.clear()
    headers,second=connect(live)
    assert second!=bank
    assert client.post(f"/v1/live-banking/connections/{second}/refresh",headers=headers,json={}).status_code==200
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT id,account_id FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s ORDER BY id",owners[0][:2]).fetchall()==original
        assert connection.execute("SELECT DISTINCT category,basket FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchall()==[('utilities','mandatory_regular')]
        assert connection.execute("SELECT count(*) FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s AND included",owners[0][:2]).fetchone()[0]==0


@pytest.mark.parametrize("change",["revoke","logout"])
def test_authority_change_during_network_fetch_prevents_publication(live,change):
    client,app,provider,login,database,owners=live
    headers,bank=connect(live);original=provider.fetch_account
    def fetch(*args,**kwargs):
        if change=="logout":
            app.state.identity.revoke(client.cookies.get(cookie_name(app.state.settings)))
        else:
            with psycopg.connect(database["admin"]) as connection:
                connection.execute("UPDATE moneylens.connections SET consent_state='revoked',consent_generation=consent_generation+1 WHERE id=%s",(bank,))
        return original(*args,**kwargs)
    provider.fetch_account=fetch
    response=client.post(f"/v1/live-banking/connections/{bank}/refresh",headers=headers,json={})
    assert response.status_code in (401,409)
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==0


def test_connection_data_respects_narrowed_account_grants(live):
    from psycopg.types.json import Jsonb
    client,app,provider,login,database,owners=live
    headers,bank=connect(live);url=f"/v1/live-banking/connections/{bank}"
    assert client.post(url+"/refresh",headers=headers,json={}).status_code==200
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.connections SET scopes=%s WHERE id=%s",(Jsonb([str(uuid4())]),bank))
    data=client.get(url+"/data")
    assert data.status_code==200 and data.json()["accounts"]==[] and data.json()["transactions"]==[]


def test_account_identity_cannot_change_under_an_existing_source_alias(live):
    client,app,provider,login,database,owners=live
    headers,bank=connect(live);url=f"/v1/live-banking/connections/{bank}"
    assert client.post(url+"/refresh",headers=headers,json={}).status_code==200
    original=provider.verify_session
    def changed_identity(*args,**kwargs):
        accounts,expiry,identities=original(*args,**kwargs)
        return accounts,expiry,{account:hashlib.sha256(("changed"+account).encode()).hexdigest() for account in accounts}
    provider.verify_session=changed_identity;reset_refresh(database,owners[0],bank)
    response=client.post(url+"/refresh",headers=headers,json={})
    assert response.status_code==409 and response.json()["error"]["code"]=="BANK_ACCOUNT_IDENTITY_CHANGED"
    with psycopg.connect(database["admin"]) as connection:
        assert connection.execute("SELECT count(*) FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()[0]==3  # includes pre-existing fixture account
        assert connection.execute("SELECT count(*),sum(amount_minor) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()==(2,-900)


def test_dashboard_observations_and_mydata_are_owned_consent_gated_and_versioned(live):
    client,app,provider,login,database,owners=live
    login()
    assert client.get('/v1/dashboard').json()['connected_bank_count']==0
    headers,bank=connect(live)
    assert client.post(f"/v1/live-banking/connections/{bank}/refresh",headers=headers,json={}).status_code==200
    dashboard=client.get('/v1/dashboard');assert dashboard.status_code==200,dashboard.text
    data=dashboard.json();visible=[a for a in data['accounts'] if a['balance']]
    assert data['connected_bank_count']==1
    assert len(visible)==2 and all(a['source']['mode']=='sandbox' for a in visible)
    assert provider.session not in dashboard.text
    identifier=visible[0]['id'];body={'included':False,'expected_data_version':data['data_version']}
    assert client.post(f'/v1/accounts/{identifier}/inclusion',json=body).status_code==403
    blocked={**headers,'Origin':'https://attacker.invalid'}
    assert client.post(f'/v1/accounts/{identifier}/inclusion',headers=blocked,json=body).status_code==403
    response=client.post(f'/v1/accounts/{identifier}/inclusion',headers=headers,json=body)
    assert response.status_code==200,response.text
    excluded=next(a for a in response.json()['accounts'] if a['id']==identifier)
    assert excluded['balance'] is None and excluded['access_status']=='excluded'
    assert response.json()['data_version']==data['data_version']+1
    assert client.post(f'/v1/accounts/{identifier}/inclusion',headers=headers,json=body).status_code==409
    from datetime import date
    today=datetime.now(timezone.utc).date();tomorrow=today+timedelta(days=1)
    scope={'start':today.isoformat(),'end_exclusive':tomorrow.isoformat(),'account_id':identifier}
    assert client.get('/v1/analysis/spending',params=scope).status_code==404
    other=login(1)
    assert client.post(f'/v1/accounts/{identifier}/inclusion',headers=other,json=body).status_code==404
    assert all(a['balance'] is None for a in client.get('/v1/dashboard').json()['accounts'])


def test_dashboard_revocation_and_future_balances_never_appear_as_current_money(live):
    client,app,provider,login,database,owners=live
    headers,bank=connect(live)
    assert client.post(f"/v1/live-banking/connections/{bank}/refresh",headers=headers,json={}).status_code==200
    with psycopg.connect(database['admin']) as connection:
        connection.execute("UPDATE moneylens.balance_snapshots SET observed_at=now()+interval '1 day' WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
    assert all(a['balance'] is None for a in client.get('/v1/dashboard').json()['accounts'])
    assert client.post(f"/v1/live-banking/connections/{bank}/disconnect",headers=headers,json={}).status_code==200
    assert all(a['balance'] is None for a in client.get('/v1/dashboard').json()['accounts'])


def test_latest_bank_question_is_owned_scoped_and_never_calls_model(live,monkeypatch):
    from datetime import date
    from test_ledger import put
    from app import coach_routes
    client,app,provider,login,database,owners=live
    auth,bank=connect(live)
    assert client.post(f"/v1/live-banking/connections/{bank}/refresh",headers=auth,json={}).status_code==200
    with psycopg.connect(database["admin"]) as connection:
        accounts=connection.execute("SELECT id FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s AND id IN (SELECT account_id FROM moneylens.account_source_aliases WHERE tenant_id=%s AND owner_user_id=%s AND connection_id=%s)",(*owners[0][:2],*owners[0][:2],bank)).fetchall()
        assert len(accounts)==2
        for i in range(7):
            put(connection,(*owners[0][:2],accounts[0][0]),day=(date.today()-timedelta(days=i)).isoformat(),flow="unknown",category="unclassified")
    app.state.settings.model_enabled=True
    app.state.settings.model_billing_policy="free_only"
    async def forbidden(*args,**kwargs):raise AssertionError("No provider model call is allowed")
    monkeypatch.setattr(coach_routes,"interpret_with_model",forbidden)
    answer=client.post("/v1/coach/query",headers=auth,json={"question":"Näita mu viit viimast LHVi tehingut"})
    assert answer.status_code==200,answer.text
    result=answer.json();assert result["interpretation"]["method"]=="bounded_english_patterns" and result["model_usage"] is None
    assert len(result["transactions"]["rows"])==5 and result["transactions"]["scope"]["dataset_coverage"]=="partial"
    scope=result["transactions"]["scope"]
    query=[("start",scope["start"]),("end_exclusive",scope["end_exclusive"]),("limit","5")]+[("account_id",a) for a in scope["account_ids"]]
    history=client.get("/v1/ledger/transactions",params=query)
    assert history.status_code==200 and history.json()["rows"]==result["transactions"]["rows"]
    other=login(1)
    denied=client.post("/v1/coach/query",headers=other,json={"question":"Show my last five LHV transactions"})
    assert denied.status_code==200 and denied.json()["transactions"] is None
    auth=login(0)
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("UPDATE moneylens.accounts SET included=false WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
    excluded=client.post("/v1/coach/query",headers=auth,json={"question":"Show my last five LHV transactions"})
    assert excluded.status_code==200 and excluded.json()["transactions"] is None
