"""Shared exact-cent, receipt-bound bulk publication of normalized statement rows."""
import hashlib
import json
from uuid import uuid5
from psycopg.types.json import Jsonb


def publish_rows(connection, owner, identifier, account, digest, records, classifications=None):
    from .transaction_classification import local_classification,load_rules
    if classifications is None:
        rules=load_rules(connection,owner)
        classifications=[local_classification(row,rules) for row in records]
    rows = []
    for index, row in enumerate(records):
        source = dict(reference=row.reference, booked_on=row.booked_on.isoformat(),
            amount_minor=row.amount_minor, currency=row.currency, description=row.description)
        encoded = json.dumps(source, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode()
        rows.append(dict(id=str(uuid5(identifier, str(index))), source_id=digest+':'+str(index),
            amount_minor=row.amount_minor, currency=row.currency, booked_on=row.booked_on.isoformat(),
            merchant=getattr(row,'merchant',None) or row.description or 'Unknown counterparty', source_payload_hash=hashlib.sha256(encoded).hexdigest(),
            category=classifications[index].category or 'unclassified',basket=classifications[index].basket,
            economic_flow=classifications[index].economic_flow,classification_basis=classifications[index].basis))
    connection.execute('''INSERT INTO moneylens.transactions
        (tenant_id,owner_user_id,id,account_id,source_id,amount_minor,currency,booked_on,status,
            merchant,category,basket,economic_flow,statement_receipt_id,source_payload_hash,classification_basis)
        SELECT %s,%s,r.id,%s,r.source_id,r.amount_minor,r.currency,r.booked_on,'booked',
            r.merchant,r.category,r.basket,r.economic_flow,%s,r.source_payload_hash,r.classification_basis
        FROM jsonb_to_recordset(%s) AS r(id uuid,source_id text,amount_minor bigint,currency text,
            booked_on date,merchant text,source_payload_hash text,category text,basket text,economic_flow text,classification_basis text)''', (*owner,account,identifier,Jsonb(rows)))
