from copy import deepcopy
from datetime import date,datetime,timezone

import pytest

from app.bank_adapter import BankError,BankTransactionV1
from app.bank_reconciliation import check_revision,merge_page,payload_hash

NOW=datetime(2026,11,4,tzinfo=timezone.utc)


def record(**changes):
    return BankTransactionV1(reference="one",account_reference="account",revision=1,amount_minor=-125,currency="EUR",
        booked_on=date(2026,11,3),status="pending",merchant="Synthetic cafe",category="coffee",basket="everyday",
        economic_flow="expense",**changes)


def stored(item):
    return {"source_revision":item.revision,"currency":item.currency,"status":item.status,"observed_at":NOW,
        "connection_id":"owned-connection","source_payload_hash":payload_hash(item),"amount_minor":item.amount_minor,
        "booked_on":item.booked_on,"merchant":item.merchant,"category":item.category,"basket":item.basket,
        "source_economic_flow":item.economic_flow,"provider_related_reference":item.related_reference,
        "provider_related_institution":item.related_institution}


def test_exact_page_overlap_preserves_distinct_identical_purchases():
    first=record();second=first.model_copy(update={"reference":"two"})
    merged=merge_page([first.model_dump(mode="json")],[first,second,second],"account")
    assert [item["reference"] for item in merged]==["one","two"]
    assert sum(item["amount_minor"] for item in merged)==-250
    assert merge_page(merged,[first,second],"account")==merged
    with pytest.raises(BankError,match="source_snapshot_conflict"):
        merge_page(merged,[first.model_copy(update={"revision":2,"amount_minor":-150})],"account")
    with pytest.raises(BankError,match="source_account_mismatch"):
        merge_page(merged,[first.model_copy(update={"account_reference":"foreign"})],"account")
    many=[first.model_copy(update={"reference":str(index)}).model_dump(mode="json") for index in range(2000)]
    with pytest.raises(BankError,match="source_row_budget_exceeded"): merge_page(many,[first],"account")


@pytest.mark.parametrize("field,value",[("merchant","Changed"),("category","housing"),("basket","mandatory_regular"),
    ("economic_flow","unknown"),("related_reference","other"),("amount_minor",-150),("booked_on",date(2026,11,2))])
def test_same_revision_cannot_change_any_source_payload(field,value):
    original=record()
    with pytest.raises(BankError,match="source_revision_conflict"):
        check_revision(stored(original),original.model_copy(update={field:value}),NOW)


@pytest.mark.parametrize("before,after,allowed",[("pending","pending",True),("pending","booked",True),
    ("pending","reversed",True),("booked","booked",True),("booked","reversed",True),("booked","pending",False),
    ("reversed","pending",False),("reversed","booked",False),("reversed","reversed",True)])
def test_status_is_monotonic_even_at_a_higher_revision(before,after,allowed):
    original=record().model_copy(update={"status":before})
    update=original.model_copy(update={"status":after,"revision":2,"amount_minor":-120})
    if allowed: assert check_revision(stored(original),update,NOW)==payload_hash(update)
    else:
        with pytest.raises(BankError,match="source_status_regressed"): check_revision(stored(original),update,NOW)


def test_original_hash_survives_classification_edits_and_legacy_baseline_fails_closed():
    original=record();prior=stored(original)
    prior.update(category="reviewed_category",basket="mandatory_irregular")
    assert check_revision(prior,original,NOW)==payload_hash(original)
    legacy=deepcopy(prior);legacy["source_payload_hash"]=None
    with pytest.raises(BankError,match="source_revision_conflict"): check_revision(legacy,original,NOW)
    legacy.update(category=original.category,basket=original.basket)
    assert check_revision(legacy,original,NOW)==payload_hash(original)
