"""Bounded, exact source identity reconciliation; never guesses from purchase content."""
import hashlib
import json

from .bank_adapter import BankError,BankTransactionV1
from .planning_policy import utc

MAX_SOURCE_ROWS=2000
ALLOWED_STATES={"pending":{"pending","booked","reversed"},"booked":{"booked","reversed"},"reversed":{"reversed"}}
SOURCE_FIELDS=("reference","account_reference","revision","amount_minor","currency","booked_on","status",
    "merchant","category","basket","economic_flow","related_reference","related_institution")


def payload_hash(item:BankTransactionV1):
    values=item.model_dump(mode="json")
    raw=json.dumps({"schema":"bank-source-payload.v1","row":{field:values[field] for field in SOURCE_FIELDS}},
        sort_keys=True,separators=(",",":"),ensure_ascii=True).encode()
    return hashlib.sha256(raw).hexdigest()


def merge_page(previous,page,account_reference):
    """Exact page overlap is safe; conflicting copies of one identity are not."""
    if len(previous)>MAX_SOURCE_ROWS or len(page)>200: raise BankError("source_row_budget_exceeded")
    merged={}
    for raw in (*previous,*page):
        item=raw if isinstance(raw,BankTransactionV1) else BankTransactionV1.model_validate(raw)
        if item.account_reference!=account_reference: raise BankError("source_account_mismatch")
        prior=merged.get(item.reference)
        if prior is not None:
            if prior!=item.model_dump(mode="json"): raise BankError("source_snapshot_conflict")
            continue
        if len(merged)>=MAX_SOURCE_ROWS: raise BankError("source_row_budget_exceeded")
        merged[item.reference]=item.model_dump(mode="json")
    return list(merged.values())


def check_revision(previous,item:BankTransactionV1,observed_at):
    """Verify one already-owned identity before the atomic canonical update."""
    digest=payload_hash(item)
    if previous is None: return digest
    if previous["source_revision"]>item.revision: raise BankError("source_revision_regressed")
    if previous["currency"]!=item.currency: raise BankError("source_currency_conflict")
    if item.status not in ALLOWED_STATES[previous["status"]]: raise BankError("source_status_regressed")
    if previous["connection_id"] and previous["observed_at"] and utc(observed_at)<utc(previous["observed_at"]):
        raise BankError("source_observation_regressed")
    if previous["source_revision"]==item.revision:
        if previous.get("source_payload_hash"):
            if previous["source_payload_hash"]!=digest: raise BankError("source_revision_conflict")
        else:
            # Existing un-hashed rows have no recoverable original override metadata.
            # Previously published rows must agree exactly before establishing a baseline.
            core=(previous["amount_minor"],previous["currency"],previous["booked_on"],previous["status"])
            if core!=(item.amount_minor,item.currency,item.booked_on,item.status): raise BankError("source_revision_conflict")
            if previous["connection_id"]:
                stored=(previous["merchant"],previous["category"],previous["basket"],previous["source_economic_flow"],
                    previous["provider_related_reference"],previous["provider_related_institution"])
                incoming=(item.merchant,item.category,item.basket,item.economic_flow,item.related_reference,item.related_institution)
                if stored!=incoming: raise BankError("source_revision_conflict")
    return digest
