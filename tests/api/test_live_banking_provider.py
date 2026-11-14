"""Contract tests with synthetic HTTP transport; no real bank accessed."""
from datetime import date,datetime,timedelta,timezone
from uuid import uuid4
import json

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization

from app.live_banking_provider import (EnableBankingClient,LiveProviderError,amount_minor,
    normalize_transactions,classify_transaction)


@pytest.fixture
def signing_key():
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    return key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()).decode()


def mock_client(signing_key, handler):
    return EnableBankingClient(str(uuid4()),signing_key,transport=httpx.MockTransport(handler))


def test_catalog_is_country_filtered_and_server_host_is_fixed(signing_key):
    seen=[]
    def handler(request):
        seen.append((request.url.host,str(request.url.path),str(request.url.params),request.headers.get("authorization","")))
        return httpx.Response(200,json={"aspsps":[{"name":"LHV","country":"EE","psu_types":["personal"],"maximum_consent_validity":86400},{"name":"S-Pankki","country":"FI","psu_types":["personal"],"maximum_consent_validity":86400}]})
    banks=mock_client(signing_key,handler).institutions("EE")
    assert banks==[{"name":"LHV","country":"EE","maximum_consent_validity":86400}]
    assert seen[0][:3]==("api.enablebanking.com","/aspsps","country=EE")
    assert seen[0][3].startswith("Bearer ")
    with pytest.raises(LiveProviderError,match="BANK_COUNTRY_UNAVAILABLE"):
        mock_client(signing_key,handler).institutions("US")


def test_redirect_accepts_only_real_https_provider_host(signing_key):
    def handler(request):
        return httpx.Response(200,json={"url":"https://auth.enablebanking.com/ais/start?state=ok"})
    url=mock_client(signing_key,handler).start(name="LHV",country="EE",state="secret",callback="https://moneylens.example/api/v1/live-banking/callback")
    assert url.startswith("https://auth.enablebanking.com/")
    for url in ("http://auth.enablebanking.com/test","https://auth.enablebanking.com.attacker.com/", "https://x:pass@auth.enablebanking.com/"):
        with pytest.raises(LiveProviderError,match="BANK_PROVIDER_INVALID_REDIRECT"):
            mock_client(signing_key,lambda request:httpx.Response(200,json={"url":url})).start(
                name="LHV",country="EE",state="s",callback="https://example.org/")


def test_session_consent_is_bounded_and_expiring(signing_key):
    ids=[str(uuid4()) for _ in range(2)]
    post={"session_id":str(uuid4()),"accounts":[{"uid":uid} for uid in ids],
        "aspsp":{"name":"LHV","country":"EE"}}
    get={"accounts_data":[{"uid":uid,"identification_hash":"stable-account-"+uid} for uid in ids],"accounts":ids,"status":"AUTHORIZED","aspsp":{"name":"LHV","country":"EE"},
        "access":{"valid_until":(datetime.now(timezone.utc)+timedelta(days=30)).isoformat()}}
    def handler(request):return httpx.Response(200,json=post if request.method=="POST" else get)
    provider=mock_client(signing_key,handler)
    assert provider.authorize("my-auth-code",expected_name="LHV",expected_country="EE")[1]==ids
    post["accounts"]=[{"uid":str(uuid4())} for _ in range(11)]
    with pytest.raises(LiveProviderError,match="BANK_ACCOUNT_LIMIT"):
        provider.authorize("my-auth-code",expected_name="LHV",expected_country="EE")


def test_money_decimal_is_exact_and_unsafe_inputs_are_rejected():
    assert amount_minor({"amount":"12.35","currency":"EUR"})==1235
    assert amount_minor({"amount":"-12.35","currency":"EUR"})==-1235
    for bad in ({"amount":1.1,"currency":"EUR"},{"amount":"1.239","currency":"EUR"},
                {"amount":"NaN","currency":"EUR"},{"amount":"3.00","currency":"USD"}):
        with pytest.raises(LiveProviderError):amount_minor(bad)


def test_normalization_ignores_pending_and_duplicate_identity_fails_closed():
    uid=str(uuid4())
    entry={"status":"BOOK","entry_reference":"tx1","transaction_id":"volatile-details-1","credit_debit_indicator":"DBIT","booking_date":"2026-11-02",
        "transaction_amount":{"amount":"4.50","currency":"EUR"},"merchant_category_code":"5812","creditor":{"name":"Cafe"}}
    rows=normalize_transactions([entry,{**entry,"status":"PDNG"}],uid)
    assert rows[0]["amount_minor"]==-450
    assert rows[0]["basket"]=="everyday" and rows[0]["economic_flow"]=="expense"
    assert len(normalize_transactions([entry,{**entry,"transaction_id":"other-volatile-id"}],uid))==1
    with pytest.raises(LiveProviderError,match="BANK_DUPLICATE_SOURCE_ID"):
        normalize_transactions([entry,{**entry,"transaction_amount":{"amount":"9.00","currency":"EUR"}}],uid)
    assert classify_transaction({})==("unclassified","unresolved")


def test_duplicate_comparison_uses_ledger_values_not_unused_party_metadata():
    entry={"status":"BOOK","entry_reference":"stable-entry","credit_debit_indicator":"DBIT",
        "booking_date":"2026-10-18","transaction_amount":{"amount":"4.50","currency":"EUR"},
        "merchant_category_code":"5411","creditor":{"name":"Fixture shop","postal_address":{"country":"EE"}}}
    revised={**entry,"merchant_category_code":"5422","creditor":{"name":"Fixture shop","postal_address":{"country":"FI"}}}
    rows=normalize_transactions([entry,revised],str(uuid4()))
    assert len(rows)==1 and rows[0]["category"]=="groceries" and rows[0]["amount_minor"]==-450


@pytest.mark.parametrize("change,field",[
    ({"transaction_amount":{"amount":"9.99","currency":"EUR"}},"amount"),
    ({"booking_date":"2026-10-19"},"booking_date"),
    ({"creditor":{"name":"Other fixture shop"}},"merchant"),
    ({"merchant_category_code":"5812"},"category"),
])
def test_real_duplicate_conflicts_still_stop_and_logs_only_field_names(change,field,caplog):
    entry={"status":"BOOK","entry_reference":"private-reference-not-for-logs","credit_debit_indicator":"DBIT",
        "booking_date":"2026-10-18","transaction_amount":{"amount":"4.50","currency":"EUR"},
        "merchant_category_code":"5411","creditor":{"name":"Private fixture merchant"}}
    with pytest.raises(LiveProviderError,match="BANK_DUPLICATE_SOURCE_ID"):
        normalize_transactions([entry,{**entry,**change}],str(uuid4()))
    assert field in caplog.text
    for value in ("private-reference-not-for-logs","Private fixture merchant","Other fixture shop","2026-10-18","2026-10-19","9.99","4.50"):
        assert value not in caplog.text


@pytest.mark.parametrize("cash_type,expected_type",[("CACC","current"),("SVGS","savings"),("LOAN","credit"),(None,"restricted")])
def test_paginated_import_is_complete_or_rejected(signing_key,cash_type,expected_type):
    uid=str(uuid4())
    count=0
    def handler(request):
        nonlocal count
        if request.url.path.endswith("/details"):
            return httpx.Response(200,json={"currency":"EUR","name":"My account","cash_account_type":cash_type})
        if request.url.path.endswith("/balances"):
            return httpx.Response(200,json={"balances":[{"balance_type":"CLAV","balance_amount":{"amount":"100.20","currency":"EUR"}}]})
        if request.url.path.endswith("/transactions"):
            count+=1
            return httpx.Response(200,json={"transactions":[{
                "status":"BOOK","entry_reference":f"t{count}","credit_debit_indicator":"DBIT",
                "booking_date":"2026-11-01","transaction_amount":{"currency":"EUR","amount":"4.50"},
                "creditor":{"name":"Shop"},"merchant_category_code":"5411"}],
                "continuation_key":"next" if count==1 else None})
        raise AssertionError(request.url.path)
    item=mock_client(signing_key,handler).fetch_account(uid,from_date=date(2026,10,1),to_date=date(2026,11,11),identity_ref="a"*64)
    assert item["amount_minor"]==10020
    assert item["balance_kind"]=="available"
    assert item["account_type"]==expected_type
    assert len(item["transactions"])==2 and count==2


def test_api_failures_never_expose_provider_error_body(signing_key):
    provider=mock_client(signing_key,lambda request:httpx.Response(403,json={"secret":"do-not-leak"}))
    with pytest.raises(LiveProviderError) as caught:provider.institutions("EE")
    assert "do-not-leak" not in str(caught.value)


def test_returned_session_must_match_exact_bank(signing_key):
    response={"session_id":str(uuid4()),"accounts":[{"uid":str(uuid4())}],
        "aspsp":{"name":"SEB","country":"EE"}}
    provider=mock_client(signing_key,lambda request:httpx.Response(200,json=response))
    with pytest.raises(LiveProviderError,match="BANK_SESSION_MISMATCH"):
        provider.authorize("code",expected_name="LHV",expected_country="EE")


def test_session_status_is_verified_after_code_exchange(signing_key):
    uid=str(uuid4())
    post={"session_id":str(uuid4()),"accounts":[{"uid":uid}],"aspsp":{"name":"LHV","country":"EE"}}
    get={"status":"PENDING_AUTHORIZATION","accounts":[uid],"aspsp":{"name":"LHV","country":"EE"},
        "access":{"valid_until":(datetime.now(timezone.utc)+timedelta(days=5)).isoformat()}}
    provider=mock_client(signing_key,lambda request:httpx.Response(200,json=post if request.method=="POST" else get))
    with pytest.raises(LiveProviderError,match="BANK_SESSION_MISMATCH"):
        provider.authorize("code",expected_name="LHV",expected_country="EE")


def test_signed_jwt_and_read_only_path_boundary(signing_key):
    import jwt
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    provider=mock_client(signing_key,lambda request:httpx.Response(200,json={}))
    token=provider._jwt()
    claims=jwt.decode(token,load_pem_private_key(signing_key.encode(),password=None).public_key(),algorithms=["RS256"],audience="api.enablebanking.com",issuer="enablebanking.com")
    assert claims["exp"]-claims["iat"]==300
    assert jwt.get_unverified_header(token)["kid"]==provider.app_id
    with pytest.raises(LiveProviderError,match="BANK_PROVIDER_INVALID_REQUEST"):
        provider.request("POST","/payments",body={})


def test_application_environment_and_registered_callback_are_verified(signing_key):
    callback="https://moneylens.example/api/v1/live-banking/callback"
    data={}
    provider=mock_client(signing_key,lambda request:httpx.Response(200,json=data))
    data.update(kid=provider.app_id,active=True,environment="SANDBOX",services=["AIS"],redirect_urls=[callback])
    assert provider.application(callback)=="sandbox"
    data["environment"]="PRODUCTION"
    with pytest.raises(LiveProviderError,match="BANK_APPLICATION_NOT_READY"):provider.application(callback)
    data["environment"]="SANDBOX";data["redirect_urls"]=[]
    with pytest.raises(LiveProviderError,match="BANK_APPLICATION_NOT_READY"):provider.application(callback)


def test_missing_immutable_reference_never_falls_back_to_volatile_id():
    entry={"status":"BOOK","transaction_id":"volatile","credit_debit_indicator":"CRDT","booking_date":"2026-11-02","transaction_amount":{"amount":"4.50","currency":"EUR"}}
    with pytest.raises(LiveProviderError,match="BANK_TRANSACTION_ID_REQUIRED"):normalize_transactions([entry],str(uuid4()))
    entry["entry_reference"]="stable"
    row=normalize_transactions([entry],str(uuid4()))[0]
    assert row["economic_flow"]=="unknown"  # credit is not necessarily salary/refund


def test_repeated_pagination_cursor_never_returns_partial_results(signing_key):
    uid=str(uuid4())
    def handler(request):
        if request.url.path.endswith('/details'):return httpx.Response(200,json={"currency":"EUR"})
        if request.url.path.endswith('/balances'):return httpx.Response(200,json={"balances":[{"balance_type":"ITBD","balance_amount":{"amount":"10.00","currency":"EUR"}}]})
        return httpx.Response(200,json={"transactions":[],"continuation_key":"loop"})
    with pytest.raises(LiveProviderError,match="BANK_PROVIDER_INVALID_DATA"):
        mock_client(signing_key,handler).fetch_account(uid,from_date=date(2026,10,1),to_date=date(2026,11,11),identity_ref='a'*64)


def test_live_banking_defaults_off_and_refuses_incomplete_identity_config():
    from app.settings import Settings
    from pydantic import ValidationError
    assert Settings().live_banking_enabled is False
    with pytest.raises(ValidationError,match="Live banking requires"):
        Settings(live_banking_enabled=True)


def test_directory_keeps_all_personal_entries_and_prioritizes_without_claiming_eligibility(signing_key):
    requested=[]
    names=[f"Other fixture {i}" for i in range(100)]+["OP","POP Pankki","Nordea","S-Pankki","Danske Bank"]
    def handler(request):
        requested.append(request.url.path)
        return httpx.Response(200,json={"aspsps":[{"name":name,"country":"FI","psu_types":["personal"],"maximum_consent_validity":86400} for name in names]+[{"name":"Corporate only fixture","country":"FI","psu_types":["business"],"maximum_consent_validity":86400}]})
    banks=mock_client(signing_key,handler).institutions("FI")
    assert len(banks)==105
    assert [item["name"] for item in banks[:4]]==["S-Pankki","OP","Nordea","Danske Bank"]
    assert {item["name"] for item in banks}==set(names)
    assert requested==["/aspsps"]
