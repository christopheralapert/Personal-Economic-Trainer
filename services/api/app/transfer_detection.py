"""Shared deterministic detection of transfers between an owner's accounts."""
from datetime import date


def internal_transfer_ids(rows):
    """Return IDs matching an account-holder or opposite-account transfer."""
    transfers=set()
    holders={str(row.get("account_name") or "").strip().casefold() for row in rows}
    for row in rows:
        counterparty=str(row.get("counterparty") or "").strip().casefold()
        if counterparty and counterparty in holders:
            transfers.add(row["id"])
    for index,left in enumerate(rows):
        for right in rows[index+1:]:
            if left["account_id"]==right["account_id"] or left["currency"]!=right["currency"]:
                continue
            if left["amount_minor"] != -right["amount_minor"] or not left["amount_minor"]:
                continue
            if abs((date.fromisoformat(str(left["booked_on"]))-
                    date.fromisoformat(str(right["booked_on"]))).days)<=3:
                transfers.update((left["id"],right["id"]))
    return transfers
