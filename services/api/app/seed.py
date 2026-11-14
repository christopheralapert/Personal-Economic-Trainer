"""Administrative, idempotent synthetic seed. Never runs inside request handlers."""
import json
from pathlib import Path
from uuid import UUID

from .demo import demo_id
from .identity import DEMO_ISSUER

ROOT = Path(__file__).resolve().parents[3]


def seed_synthetic(connection):
    artifact = json.loads((ROOT / "fixtures/synthetic/demo.v1.json").read_text(encoding="utf-8"))
    for profile,key,name in zip(artifact["profiles"],("aino","mika"),("Synthetic Aino","Synthetic Mika")):
        owner = profile["accounts"][0]["owner"]
        tenant,user = UUID(owner["tenant_id"]),UUID(owner["user_id"])
        prior = connection.execute("SELECT is_synthetic,subject_issuer,subject_id FROM moneylens.users WHERE tenant_id=%s AND id=%s",(tenant,user)).fetchone()
        if prior is not None and prior != (True,DEMO_ISSUER,key+".v1"):
            raise RuntimeError("Synthetic IDs must never overwrite a different identity")
        connection.execute("INSERT INTO moneylens.tenants (id,name) VALUES (%s,'Synthetic development tenant') ON CONFLICT DO NOTHING",(tenant,))
        connection.execute("""INSERT INTO moneylens.users (tenant_id,id,subject_issuer,subject_id,is_synthetic,display_name)
            VALUES (%s,%s,%s,%s,true,%s) ON CONFLICT DO NOTHING""",(tenant,user,DEMO_ISSUER,key+".v1",name))
        connection.execute("INSERT INTO moneylens.user_state (tenant_id,owner_user_id,id) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",(tenant,user,demo_id(key+"-state")))
        changed = 0
        for account in profile["accounts"]:
            changed += connection.execute("""INSERT INTO moneylens.accounts (tenant_id,owner_user_id,id,name,currency,account_type,included)
                VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (tenant,user,UUID(account["id"]),account["name"],account["currency"],account["account_type"],account["included"])).rowcount
        for balance in profile["balances"]:
            changed += connection.execute("""INSERT INTO moneylens.balance_snapshots
                (tenant_id,owner_user_id,id,account_id,amount_minor,currency,balance_kind,pending_reflection,included_credit_minor,observed_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (tenant,user,UUID(balance["id"]),UUID(balance["account_id"]),balance["amount_minor"],balance["currency"],balance["kind"],
                 balance["pending_reflection"],balance["included_credit_minor"],balance["observed_at"])).rowcount
        for transaction in profile["transactions"]:
            changed += connection.execute("""INSERT INTO moneylens.transactions
                (tenant_id,owner_user_id,id,account_id,source_id,amount_minor,currency,booked_on,status,merchant,category,basket,economic_flow,related_transaction_id)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (tenant,user,UUID(transaction["id"]),UUID(transaction["account_id"]),transaction["provider_id"],transaction["amount_minor"],
                 transaction["currency"],transaction["booked_on"],transaction["status"],transaction["merchant"],transaction["category"],
                 transaction["basket"],transaction["economic_flow"],transaction["related_transaction_id"])).rowcount
        if changed:
            connection.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",(tenant,user))
