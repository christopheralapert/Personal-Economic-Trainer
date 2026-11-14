"""Offline provider errors and signed active-PSU context; no bank calls."""
from datetime import datetime,timezone
from types import SimpleNamespace
from uuid import uuid4
import hashlib
import hmac
import json
import time

import httpx
import pytest
from pydantic import SecretStr
from starlette.requests import Request

from app.identity import AuthError
from app.live_banking_psu import manual_psu
from app.live_banking_provider import EnableBankingClient,LiveProviderError,retry_after_time


@pytest.mark.parametrize("value,seconds",[("120",120),("Fri, 13 Nov 2026 12:03:00 GMT",180),
    ("invalid",None),("-3",None),("9"*120,None),(None,None)])
def test_retry_after_forms(value,seconds):
    now=datetime(2026,11,13,12,tzinfo=timezone.utc)
    result=retry_after_time(value,now)
    assert (int((result-now).total_seconds()) if result else None)==seconds


@pytest.mark.parametrize("upstream,code",[("ASPSP_RATE_LIMIT_EXCEEDED","BANK_ASPSP_RATE_LIMIT_EXCEEDED"),
    ("private-provider-error","BANK_PROVIDER_THROTTLED")])
def test_rate_limit_source_and_request_id_are_allowlisted(monkeypatch,upstream,code):
    calls=[];rid=str(uuid4())
    def handle(request):
        calls.append(request)
        return httpx.Response(429,json={"error":upstream,"detail":"private-bank-data"},
            headers={"Retry-After":"120","x-request-id":rid})
    client=EnableBankingClient(str(uuid4()),"unused",transport=httpx.MockTransport(handle))
    monkeypatch.setattr(client,"_jwt",lambda:"offline")
    with pytest.raises(LiveProviderError) as caught:
        client.request("GET",f"/accounts/{uuid4()}/transactions")
    error=caught.value
    assert error.code==code and error.stage=="transactions" and error.request_id==rid
    assert error.retry_at>datetime.now(timezone.utc)
    assert "private" not in str(error) and len(calls)==1


def test_manual_psu_is_ephemeral_required_metadata_checked_and_never_used_by_jobs(monkeypatch):
    calls=[]
    def handle(request):
        calls.append(request)
        if request.url.path=="/aspsps":
            return httpx.Response(200,json={"aspsps":[{"name":"Swedbank","country":"EE","psu_types":["personal"],
                "maximum_consent_validity":86400,"required_psu_headers":["Psu-Ip-Address","Psu-User-Agent"]}]})
        return httpx.Response(200,json={})
    client=EnableBankingClient(str(uuid4()),"unused",transport=httpx.MockTransport(handle))
    monkeypatch.setattr(client,"_jwt",lambda:"offline")
    with pytest.raises(LiveProviderError,match="BANK_PSU_HEADERS_REQUIRED"):
        client.configure_psu({"Psu-Ip-Address":"192.0.2.10"},"EE","Swedbank")
    client.request("GET",f"/accounts/{uuid4()}/details")
    assert "psu-ip-address" not in calls[-1].headers
    client.configure_psu({"Psu-Ip-Address":"192.0.2.10","Psu-User-Agent":"Actual fixture browser"},"EE","Swedbank")
    client.request("GET",f"/accounts/{uuid4()}/details")
    assert calls[-1].headers["psu-user-agent"]=="Actual fixture browser"
    assert all("psu-user-agent" not in call.headers for call in calls if call.url.path=="/aspsps")


@pytest.mark.parametrize("tamper",[None,"signature","peer","session","expired","path"])
def test_only_signed_loopback_request_bound_psu_is_accepted(tamper):
    secret="offline-proxy-secret-with-at-least-32-characters"
    payload={"time":time.time()-90 if tamper=="expired" else time.time(),"method":"POST","path":"/v1/live-banking/connections/test/refresh",
        "session":"other" if tamper=="session" else "fixture-session",
        "headers":{"Psu-Ip-Address":"192.0.2.10","Psu-User-Agent":"Fixture browser"}}
    raw=json.dumps(payload)
    signature=hmac.new(secret.encode(),raw.encode(),hashlib.sha256).hexdigest()
    request=Request({"type":"http","method":"POST","path":"/wrong" if tamper=="path" else payload["path"],
        "client":("192.0.2.1" if tamper=="peer" else "127.0.0.1",12345),"scheme":"https","server":("test",443),"query_string":b"",
        "headers":[(b"x-moneylens-session-id",b"fixture-session"),(b"x-moneylens-psu-context",raw.encode()),
            (b"x-moneylens-psu-signature",("0"*64 if tamper=="signature" else signature).encode())],
        "app":SimpleNamespace(state=SimpleNamespace(settings=SimpleNamespace(psu_proxy_secret=SecretStr(secret))))})
    if tamper:
        with pytest.raises(AuthError,match="BANK_PSU_CONTEXT_REQUIRED"):manual_psu(request)
    else:assert manual_psu(request)==payload["headers"]
