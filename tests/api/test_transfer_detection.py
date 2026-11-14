from datetime import date
from uuid import uuid4

from app.transfer_detection import internal_transfer_ids


def rows(source):
    first,second=uuid4(),uuid4()
    return [
        {"id":f"{source}-debit","account_id":first,"account_name":"Main","counterparty":"Savings",
         "currency":"EUR","amount_minor":-2500,"booked_on":date(2026,10,10)},
        {"id":f"{source}-credit","account_id":second,"account_name":"Savings","counterparty":"Main",
         "currency":"EUR","amount_minor":2500,"booked_on":date(2026,10,12)},
        {"id":f"{source}-expense","account_id":first,"account_name":"Main","counterparty":"Shop",
         "currency":"EUR","amount_minor":-900,"booked_on":date(2026,10,10)},
    ]


def test_demo_csv_and_live_shapes_share_transfer_detection():
    for source in ("demo","csv","live"):
        ids=internal_transfer_ids(rows(source))
        assert ids=={f"{source}-debit",f"{source}-credit"}


def test_holder_name_counterparty_is_transfer_without_matching_amount():
    row={"id":"holder-transfer","account_id":uuid4(),"account_name":"Main",
         "counterparty":" main ","currency":"EUR","amount_minor":-100,"booked_on":date(2026,10,10)}
    assert internal_transfer_ids([row])=={"holder-transfer"}
