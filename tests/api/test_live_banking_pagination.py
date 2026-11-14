"""Synthetic transport only: exact continuation rules and privacy-safe evidence."""
from datetime import date
import json
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import pytest

from app.live_banking_provider import EnableBankingClient, LiveProviderError


@pytest.fixture
def key():
    return rsa.generate_private_key(public_exponent=65537,key_size=2048).private_bytes(
        serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()


def entry(amount="4.50", booked="2026-10-18", status="BOOK"):
    return {"entry_reference":"private-source-reference", "status":status,
        "credit_debit_indicator":"DBIT", "transaction_amount":{"currency":"EUR","amount":amount},
        "booking_date":booked, "creditor":{"name":"Private fixture merchant"}}


def provider(key, pages, observed, *, currency="EUR", balances=None):
    def handler(request):
        if request.url.path.endswith("/details"):
            return httpx.Response(200,json={"currency":currency,"cash_account_type":"CACC"})
        if request.url.path.endswith("/balances"):
            return httpx.Response(200,json={"balances":balances if balances is not None else [{"balance_type":"ITBD",
                "balance_amount":{"amount":"10.00","currency":"EUR"}}]})
        observed.append(request)
        return httpx.Response(200,json=pages[len(observed)-1],headers={
            "x-request-id":str(uuid4()),"set-cookie":"secret-cookie", "x-correlation-id":"unsafe-secret"})
    return EnableBankingClient(str(uuid4()),key,transport=httpx.MockTransport(handler))


def fetch(client, uid=None):
    return client.fetch_account(uid or str(uuid4()),from_date=date(2026,10,1),
        to_date=date(2026,11,11),identity_ref="a"*64)


def test_empty_page_continues_with_exact_key_and_identical_filters(key):
    observed=[]
    client=provider(key,[{"transactions":[],"continuation_key":"opaque +/= key"},
        {"transactions":[entry()],"continuation_key":None}],observed)
    assert len(fetch(client)["transactions"])==1
    first=dict(observed[0].url.params); second=dict(observed[1].url.params)
    assert first=={"date_from":"2026-10-01","date_to":"2026-11-11","transaction_status":"BOOK"}
    assert second=={**first,"continuation_key":"opaque +/= key"}
    assert observed[0].url.path==observed[1].url.path


def test_multi_step_cursor_cycle_stops_before_reusing_any_key(key):
    observed=[]
    client=provider(key,[{"transactions":[],"continuation_key":value} for value in ("a","b","a")],observed)
    with pytest.raises(LiveProviderError,match="BANK_PROVIDER_INVALID_DATA"):
        fetch(client)
    assert len(observed)==3
    assert [r.url.params.get("continuation_key") for r in observed]==[None,"a","b"]


@pytest.mark.parametrize("same_page",[True,False])
def test_raw_conflict_is_proven_before_normalization_with_only_safe_evidence(key,caplog,monkeypatch,same_page):
    import app.live_banking_provider as module
    observed=[];uid=str(uuid4())
    rows=[entry(),entry("9.99","2026-10-19")]
    pages=([{"transactions":rows}] if same_page else [
        {"transactions":[rows[0]],"continuation_key":"secret-cursor"}, {"transactions":[rows[1]]}])
    client=provider(key,pages,observed)
    original=module.normalize_transactions
    def checked_normalizer(entries, account):
        assert "BANK_FETCH_DIAGNOSTICS" in caplog.text  # evidence already exists
        assert account==uid
        return original(entries,account)
    monkeypatch.setattr(module,"normalize_transactions",checked_normalizer)
    with pytest.raises(LiveProviderError,match="BANK_DUPLICATE_SOURCE_ID"):
        fetch(client,uid)
    record=next(r.message for r in caplog.records if "BANK_FETCH_DIAGNOSTICS" in r.message)
    evidence=json.loads(record.split("BANK_FETCH_DIAGNOSTICS ")[1])
    assert evidence["same_page"] is same_page
    assert evidence["raw_amount_differs"] and evidence["raw_booking_date_differs"]
    assert evidence["both_booked"] and evidence["single_account_endpoint"]
    assert evidence["pagination_complete"] and evidence["stable_query_parameters"]
    ids=[item["observed_request_ids"] for item in evidence["request_metadata"] if item["resource"]=="transactions"]
    assert len(ids)==len(pages) and all(list(item)==["x-request-id"] for item in ids)
    for secret in (uid,"private-source-reference","Private fixture merchant","secret-cursor",
                   "secret-cookie","unsafe-secret","2026-10-18","2026-10-19","9.99","4.50"):
        assert secret not in caplog.text


def test_pending_rows_and_separate_accounts_do_not_create_false_conflicts(key,caplog):
    observed=[]
    client=provider(key,[{"transactions":[entry(),entry("9.99","2026-10-19","PDNG")]},
        {"transactions":[entry("8.00","2026-10-20")]}],observed)
    assert fetch(client)["transactions"][0]["amount_minor"]==-450
    assert fetch(client)["transactions"][0]["amount_minor"]==-800
    assert "BANK_FETCH_DIAGNOSTICS" not in caplog.text
    assert observed[0].url.path!=observed[1].url.path


@pytest.mark.parametrize("currency,multicurrency",[("USD",False),(None,False)])
def test_non_eur_is_rejected_before_balance_or_transaction_reads(key,caplog,currency,multicurrency):
    observed=[]
    with pytest.raises(LiveProviderError,match="BANK_UNSUPPORTED_CURRENCY"):
        fetch(provider(key,[],observed,currency=currency))
    assert observed==[]
    evidence=json.loads(next(r.message for r in caplog.records if "BANK_CURRENCY_DIAGNOSTICS" in r.message).split("BANK_CURRENCY_DIAGNOSTICS ")[1])
    assert evidence["stage"]=="account_details" and evidence["currency_eur"] is False
    assert evidence["declared_multicurrency"] is multicurrency
    assert evidence["currency_missing"] is (currency is None)
    assert evidence["currency_code_shape_valid"] is (currency is not None)
    for value in ("USD","XXX"):
        assert value not in caplog.text


def test_unspecified_descriptor_requires_explicit_eur_observations(key):
    observed=[]
    item=fetch(provider(key,[{"transactions":[entry()]}],observed,currency="XXX"))
    assert item["source_account_currency"]=="XXX" and item["currency"]=="EUR"
    assert item["amount_minor"]==1000 and item["transactions"][0]["amount_minor"]==-450


def test_unspecified_descriptor_never_drops_a_foreign_balance(key):
    observed=[]
    balances=[{"balance_type":"ITBD","balance_amount":{"amount":"10.00","currency":"EUR"}},
              {"balance_type":"CLAV","balance_amount":{"amount":"5.00","currency":"USD"}}]
    with pytest.raises(LiveProviderError,match="BANK_UNSUPPORTED_CURRENCY"):
        fetch(provider(key,[{"transactions":[entry()]}],observed,currency="XXX",balances=balances))
    assert observed==[]


@pytest.mark.parametrize("failure",["missing","conflicting","foreign"])
def test_unspecified_descriptor_preserves_booked_identity_and_currency_guards(key,failure):
    observed=[];row=entry()
    if failure=="missing":
        row["entry_reference"]=None;rows=[row];code="BANK_TRANSACTION_ID_REQUIRED"
    elif failure=="conflicting":
        rows=[row,entry("9.00")];code="BANK_DUPLICATE_SOURCE_ID"
    else:
        row["transaction_amount"]["currency"]="USD";rows=[row];code="BANK_UNSUPPORTED_CURRENCY"
    with pytest.raises(LiveProviderError,match=code):
        fetch(provider(key,[{"transactions":rows}],observed,currency="XXX"))


def test_foreign_booked_amount_fails_closed_with_structural_flags_only(key,caplog):
    row=entry();row["transaction_amount"]={"currency":"USD","amount":"12345.67"}
    uid=str(uuid4());observed=[]
    with pytest.raises(LiveProviderError,match="BANK_UNSUPPORTED_CURRENCY"):
        fetch(provider(key,[{"transactions":[row]}],observed),uid)
    evidence=json.loads(next(r.message for r in caplog.records if "BANK_CURRENCY_DIAGNOSTICS" in r.message).split("BANK_CURRENCY_DIAGNOSTICS ")[1])
    assert evidence["stage"]=="booked_transaction" and evidence["currency_eur"] is False
    assert evidence["amount_is_string"] is True
    for secret in (uid,"USD","12345.67","private-source-reference","Private fixture merchant"):
        assert secret not in caplog.text


@pytest.mark.parametrize("case,value",[
    ("reference_absent", None), ("reference_null", None),
    ("reference_empty", ""), ("reference_wrong_type", 42),
    ("reference_too_long", "x" * 2001),
])
def test_missing_booked_identity_is_proven_raw_and_never_uses_volatile_locator(key,caplog,case,value):
    broken=entry();broken["transaction_id"]="private-volatile-locator"
    if case=="reference_absent":
        broken.pop("entry_reference")
    else:
        broken["entry_reference"]=value
    pending={**broken,"status":"PDNG"}
    observed=[];uid=str(uuid4())
    client=provider(key,[{"transactions":[entry(),broken,pending]}],observed)
    with pytest.raises(LiveProviderError,match="BANK_TRANSACTION_ID_REQUIRED"):
        fetch(client,uid)
    record=next(r.message for r in caplog.records if "BANK_IDENTITY_DIAGNOSTICS" in r.message)
    evidence=json.loads(record.split("BANK_IDENTITY_DIAGNOSTICS ")[1])
    assert evidence["booked_rows_seen"]==2 and evidence["booked_missing_reference"]==1
    assert evidence[case]==1 and evidence["missing_reference_with_volatile_locator"]==1
    assert evidence["single_account_endpoint"] and evidence["verified_identity_supplied"]
    assert evidence["pagination_complete"] and evidence["page_count"]==1
    assert evidence["request_metadata"][-1]["observed_request_ids"]["x-request-id"]
    for secret in (uid,"private-source-reference","Private fixture merchant","private-volatile-locator","2026-10-18","4.50","x"*100):
        assert secret not in caplog.text


def test_pending_missing_identity_is_not_reported_as_booked_error(key,caplog):
    pending=entry(status="PDNG");pending.pop("entry_reference")
    observed=[]
    result=fetch(provider(key,[{"transactions":[entry(),pending]}],observed))
    assert len(result["transactions"])==1
    assert "BANK_IDENTITY_DIAGNOSTICS" not in caplog.text


@pytest.mark.parametrize("case,stage",[("date","transaction_normalization"),
    ("direction","transaction_normalization"),("window","requested_booking_window"),
    ("precision","balances"),("cursor","transaction_pagination")])
def test_invalid_data_reports_stage_without_financial_data(key,caplog,case,stage):
    row=entry(); balances=None; page={"transactions":[row]}
    if case=="date": row["booking_date"]="private-invalid-date"
    if case=="direction": row["credit_debit_indicator"]="private-invalid-direction"
    if case=="window": row["booking_date"]="2025-01-01"
    if case=="precision": balances=[{"balance_type":"ITBD", "balance_amount":{"amount":"123.456", "currency":"EUR"}}]
    if case=="cursor": page["continuation_key"]=42
    uid=str(uuid4()); observed=[]
    with pytest.raises(LiveProviderError,match="BANK_PROVIDER_INVALID_DATA"):
        fetch(provider(key,[page],observed,currency="XXX",balances=balances),uid)
    evidence=json.loads(next(r.message for r in caplog.records if "BANK_VALIDATION_DIAGNOSTICS" in r.message).split("BANK_VALIDATION_DIAGNOSTICS ")[1])
    assert evidence["stage"]==stage
    assert evidence["request_metadata"]
    for secret in (uid,"private-source-reference","Private fixture merchant","private-invalid-date",
                   "private-invalid-direction","2025-01-01","123.456","4.50"):
        assert secret not in caplog.text
