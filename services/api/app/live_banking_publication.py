"""Bounded publication of verified real-bank AIS observations to the owned ledger.

No network I/O occurs inside an authenticated DB transaction. This intentionally
never claims that historical coverage or safe-to-spend inputs are complete.
"""
import hashlib
import json
from uuid import uuid5
from psycopg.types.json import Jsonb

from .live_banking_provider import LiveProviderError
from .transfer_detection import internal_transfer_ids


def _internal_transfer_ids(rows):
    return internal_transfer_ids([{
        "id":row["transaction_id"],"account_id":row["account_id"],"account_name":row["account_name"],
        "counterparty":row["txn"].get("merchant"),"currency":row["currency"],
        "amount_minor":row["txn"]["amount_minor"],"booked_on":row["txn"]["booked_on"],
    } for row in rows])


def _transaction_identity(account_id, txn, occurrence: int) -> str:
    """Create a repeatable source identity when a provider omits or repeats IDs."""
    reference = str(txn.get("reference") or "").strip()
    fingerprint = hashlib.sha256(json.dumps({
        "account": str(account_id),
        "date": str(txn.get("booked_on") or ""),
        "amount": txn.get("amount_minor"),
        "merchant": str(txn.get("merchant") or ""),
        "reference": reference,
    }, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    base = reference or f"hash:{fingerprint}"
    return base if occurrence == 0 else f"{base}:duplicate:{occurrence}:{fingerprint[:16]}"


def publish(connection, user, bank, observations):
    owner=(user.scope.tenant_id,user.scope.user_id)
    if not observations or len(observations)>10:
        raise LiveProviderError("BANK_ACCOUNT_LIMIT",422)
    now=max(item["observed_at"] for item in observations)
    if len(observations)!=len(bank["scopes"]) or set(item["id"] for item in observations)!=set(bank["scopes"]):
        raise LiveProviderError("BANK_CONSENT_CHANGED",409)
    total=0
    pending_transactions=[]
    # Full fetch/validation succeeded for ALL consented accounts before publication.
    for item in observations:
        provider_account_id=item["id"]
        canonical=hashlib.sha256((bank["provider"]+":"+item["identity_ref"]).encode()).hexdigest()
        account_id=uuid5(user.scope.user_id,"enable-banking-account:"+canonical)
        alias=connection.execute("""SELECT account_id,canonical_reference FROM moneylens.account_source_aliases
            WHERE tenant_id=%s AND owner_user_id=%s AND connection_id=%s AND provider_account_id=%s""",
            (*owner,bank["id"],provider_account_id)).fetchone()
        if alias and alias!=(account_id,canonical):
            raise LiveProviderError("BANK_ACCOUNT_IDENTITY_CHANGED",409)
        existing=connection.execute("""SELECT currency,account_type FROM moneylens.accounts
            WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(*owner,account_id)).fetchone()
        if existing and (existing[0],existing[1])!=(item["currency"],item["account_type"]):
            raise LiveProviderError("BANK_ACCOUNT_CHANGED",409)
        connection.execute("""INSERT INTO moneylens.accounts
            (tenant_id,owner_user_id,id,name,currency,account_type)
            VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
            (*owner,account_id,item["name"],item["currency"],item["account_type"]))
        prior=connection.execute("""SELECT max(observed_at) FROM moneylens.account_source_aliases
            WHERE tenant_id=%s AND owner_user_id=%s AND account_id=%s""",(*owner,account_id)).fetchone()[0]
        if prior and prior>item["observed_at"]:raise LiveProviderError("BANK_OBSERVATION_OUTDATED",409)
        alias_id=uuid5(bank["id"],provider_account_id)
        connection.execute("""INSERT INTO moneylens.account_source_aliases
            (tenant_id,owner_user_id,id,account_id,connection_id,provider_account_id,
            canonical_reference,source_version,observed_at,coverage_from,coverage_to_exclusive)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT(tenant_id,owner_user_id,connection_id,provider_account_id)
            DO UPDATE SET observed_at=excluded.observed_at,source_version=excluded.source_version,
                coverage_from=excluded.coverage_from,coverage_to_exclusive=excluded.coverage_to_exclusive""",
            (*owner,alias_id,account_id,bank["id"],provider_account_id,canonical,
            item["observed_at"].isoformat(),item["observed_at"],None,None))
        balance_id=uuid5(account_id,"enable-banking-balance:"+item["observed_at"].isoformat())
        connection.execute("""INSERT INTO moneylens.balance_snapshots
            (tenant_id,owner_user_id,id,account_id,amount_minor,currency,balance_kind,pending_reflection,
             included_credit_minor,observed_at,connection_id,source_version)
            VALUES (%s,%s,%s,%s,%s,%s,%s,'unknown',0,%s,%s,%s) ON CONFLICT DO NOTHING""",
            (*owner,balance_id,account_id,item["amount_minor"],item["currency"],item["balance_kind"],item["observed_at"],
                bank["id"],item["observed_at"].isoformat()))
        identities: dict[str, int] = {}
        for txn in sorted(item["transactions"], key=lambda value: json.dumps({
            "date": str(value.get("booked_on") or ""),
            "amount": value.get("amount_minor"),
            "merchant": str(value.get("merchant") or ""),
            "reference": str(value.get("reference") or ""),
        }, sort_keys=True, separators=(",", ":"))):
            reference = str(txn.get("reference") or "").strip()
            fingerprint_key = hashlib.sha256(json.dumps({
                "date": str(txn.get("booked_on") or ""),
                "amount": txn.get("amount_minor"),
                "merchant": str(txn.get("merchant") or ""),
                "reference": reference,
            }, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            occurrence = identities.get(reference or f"hash:{fingerprint_key}", 0)
            identities[reference or f"hash:{fingerprint_key}"] = occurrence + 1
            source_id = _transaction_identity(account_id, txn, occurrence)
            transaction_id=uuid5(account_id,"enable-banking-tx:"+source_id)
            payloadhash=hashlib.sha256(":|:".join(map(str,(txn["amount_minor"],txn["booked_on"],
                txn["status"],txn["merchant"],txn["category"],txn["basket"],txn["economic_flow"]))).encode()).hexdigest()
            pending_transactions.append({"account_id":account_id,"account_name":item["name"],"currency":item["currency"],
                "observed_at":item["observed_at"],"txn":txn,"source_id":source_id,"transaction_id":transaction_id,"payloadhash":payloadhash})
    transfer_ids=internal_transfer_ids([{
        "id":row["transaction_id"],"account_id":row["account_id"],"account_name":row["account_name"],
        "counterparty":row["txn"].get("merchant"),"currency":row["currency"],
        "amount_minor":row["txn"]["amount_minor"],"booked_on":row["txn"]["booked_on"],
    } for row in pending_transactions])
    for row in pending_transactions:
        transaction_id,source_id,payloadhash=row["transaction_id"],row["source_id"],row["payloadhash"]
        txn,account_id,observed_at=row["txn"],row["account_id"],row["observed_at"]
        previous=connection.execute("""SELECT account_id,source_id,source_payload_hash FROM moneylens.transactions
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",(*owner,transaction_id)).fetchone()
        if previous:
            if previous!=(account_id,source_id,payloadhash):
                raise LiveProviderError("BANK_TRANSACTION_CONFLICT",409)
            # Retain the stored amount, classification, transfer/refund links and source revision.
            connection.execute("""UPDATE moneylens.transactions SET connection_id=%s,
                    economic_flow=CASE WHEN %s AND NOT EXISTS (SELECT 1 FROM moneylens.classification_corrections c
                        WHERE c.tenant_id=moneylens.transactions.tenant_id AND c.owner_user_id=moneylens.transactions.owner_user_id
                            AND c.transaction_id=moneylens.transactions.id)
                        THEN 'internal_transfer' ELSE economic_flow END
                    WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                (bank["id"],transaction_id in transfer_ids,*owner,transaction_id))
        else:
            connection.execute("""INSERT INTO moneylens.transactions
                    (tenant_id,owner_user_id,id,account_id,connection_id,source_id,source_revision,
                     amount_minor,currency,booked_on,status,merchant,category,basket,economic_flow,
                     observed_at,source_economic_flow,source_payload_hash)
                    VALUES (%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (*owner,transaction_id,account_id,bank["id"],source_id,txn["amount_minor"],item["currency"],
                    txn["booked_on"],txn["status"],txn["merchant"],txn["category"],txn["basket"],
                    "internal_transfer" if transaction_id in transfer_ids else txn["economic_flow"],
                    observed_at,txn["economic_flow"],payloadhash))
        total+=1
    connection.execute("""UPDATE moneylens.connections SET sync_health='partial',last_success_at=%s,source_observed_at=%s,last_error_code=NULL,
        published_source_version=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
        (now,now,now.isoformat(),*owner,bank["id"]))
    # Mark financial projections stale: downstream planning rechecks source
    # confidence rather than reusing a previously approved amount.
    connection.execute("""UPDATE moneylens.user_state SET data_version=data_version+1
        WHERE tenant_id=%s AND owner_user_id=%s""",owner)
    from uuid import uuid4
    connection.execute("""INSERT INTO moneylens.audit_events
        (tenant_id,owner_user_id,id,action,resource_id,trace_id,metadata)
        VALUES (%s,%s,%s,'live_bank.observed',%s,%s,%s)""",
        (*owner,uuid4(),bank["id"],uuid4(),Jsonb({"observed_currency":"EUR",
            "source_currency_unspecified_accounts":sum(item.get("source_account_currency")=="XXX" for item in observations)})))
    return total
