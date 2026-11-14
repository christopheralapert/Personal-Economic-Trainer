"""Generate explicitly synthetic fixed-clock records. Never reads customer data."""
import json
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

ROOT = Path(__file__).resolve().parents[1]


def ident(key):
    return str(uuid5(NAMESPACE_URL, f"https://moneylens.invalid/synthetic/{key}"))


def make_profile(key, name):
    owner = {"tenant_id": ident("demo-tenant"), "user_id": ident(key)}
    accounts = [{"id": ident(f"{key}-{bank}"), "owner": owner, "institution_id": bank,
                 "name": label, "currency": "EUR", "account_type": "current", "included": True}
                for bank, label in [("s-bank-demo", "S-Bank demo"), ("north-demo", "North demo bank")]]
    balances = [{"id": ident(f"{key}-balance-{i}"), "account_id": account["id"], "amount_minor": amount,
                 "currency": "EUR", "kind": "available", "observed_at": "2026-11-04T00:00:00+02:00",
                 "pending_reflection": "included", "included_credit_minor": 0}
                for i, (account, amount) in enumerate(zip(accounts, [50000, 30000]))]
    rows = [
        ("2026-10-09", "Taxi Helsinki", -1890, "taxi", "everyday", "expense", 0),
        ("2026-10-23", "City taxi", -2110, "taxi", "everyday", "expense", 1),
        ("2026-11-01", "Taxi Helsinki", -1250, "taxi", "unresolved", "expense", 0),
        ("2026-10-18", "Dining purchases", -25000, "dining", "everyday", "expense", 0),
        ("2026-09-18", "Dining purchases", -25000, "dining", "everyday", "expense", 0),
        ("2026-08-18", "Dining purchases", -25000, "dining", "everyday", "expense", 0),
        ("2026-10-02", "Housing payment", -35000, "housing", "mandatory_regular", "expense", 0),
        ("2026-10-26", "S-market", -12100, "groceries", "mandatory_irregular", "expense", 1),
        ("2026-10-27", "Grocery refund", 300, "groceries", "mandatory_irregular", "refund", 1),
        ("2026-10-16", "Appliance repair", -9000, "repairs", "mandatory_irregular", "expense", 1),
        ("2026-10-29", "Coffee purchases", -1650, "coffee", "everyday", "expense", 0),
        ("2026-10-30", "Transfer to own account", -10000, "transfer", "unresolved", "internal_transfer", 0),
        ("2026-10-30", "Transfer from own account", 10000, "transfer", "unresolved", "internal_transfer", 1),
    ]
    transactions = [{"id": ident(f"{key}-tx-{i}"), "owner": owner, "account_id": accounts[account]["id"],
                     "provider_id": f"synthetic-{i}", "amount_minor": amount, "currency": "EUR", "booked_on": day,
                     "status": "booked", "merchant": merchant, "category": category, "basket": basket,
                     "economic_flow": flow, "related_transaction_id": None}
                    for i, (day, merchant, amount, category, basket, flow, account) in enumerate(rows)]
    transactions[8]["related_transaction_id"] = transactions[7]["id"]
    transactions[11]["related_transaction_id"] = transactions[12]["id"]
    transactions[12]["related_transaction_id"] = transactions[11]["id"]
    return {"mode": "synthetic", "name": name, "fixture_version": "demo.v1", "as_of": "2026-11-04T00:00:00+02:00",
            "accounts": accounts, "balances": balances, "transactions": transactions,
            "bills_minor": 35000, "essentials_minor": 15000, "buffer_minor": 10000}


def generate():
    return {"notice": "Entirely synthetic development data; not organizer or customer records.", "seed": 311045,
        "profiles": [make_profile("household-a", "Demo household"), make_profile("household-b", "Second demo household")]}


if __name__ == "__main__":
    target = ROOT / "fixtures/synthetic/demo.v1.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(generate(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print("Generated fixtures/synthetic/demo.v1.json")
