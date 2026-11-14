from datetime import date
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest

from app.database import TrustedScope,tenant_transaction
from app.ledger import Ledger,LedgerFilterV1
from app.scoped_keys import CursorCodec
from identity_support import authenticated_app,login

PERIOD = {"start":"2026-10-01","end_exclusive":"2026-11-01"}


def put(connection,owner,*,amount=-100,day="2026-10-15",flow="expense",merchant="Synthetic cafe",category="coffee",status="booked",currency="EUR"):
    tid = uuid4()
    connection.execute("""INSERT INTO moneylens.transactions
        (tenant_id,owner_user_id,id,account_id,source_id,amount_minor,currency,booked_on,status,merchant,category,basket,economic_flow)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'everyday',%s)""",
        (*owner[:2],tid,owner[2],str(tid),amount,currency,day,status,merchant,category,flow))
    return str(tid)


def test_keyset_pages_cover_same_day_purchases_without_duplicates(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        ids = {put(connection,owners[0]) for _ in range(7)}
        put(connection,owners[1],amount=-999999)
        put(connection,owners[2],amount=-999999)
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        seen,cursor = [],None
        while True:
            response = client.get("/v1/ledger/transactions",params={**PERIOD,"limit":2,**({"cursor":cursor} if cursor else {})})
            assert response.status_code == 200,response.text
            body = response.json()
            seen.extend(row["id"] for row in body["rows"])
            cursor = body["next_cursor"]
            if cursor is None:
                break
        assert len(seen) == 7 and set(seen) == ids
        assert body["scope"]["dataset_coverage"] == "unverified"


def test_unreviewed_money_out_is_owned_scoped_and_never_confirmed_spending(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        put(connection,owners[0],amount=-1200,flow="unknown",category="unclassified")
        put(connection,owners[0],amount=300,flow="unknown",category="unclassified")
        put(connection,owners[0],amount=-400,flow="internal_transfer")
        put(connection,owners[0],amount=-800,flow="expense",category="unclassified")
        put(connection,owners[0],amount=-9999,flow="unknown",day="2026-11-01")
        put(connection,owners[1],amount=-99999,flow="unknown")
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        inventory=client.get("/v1/ledger/inventory",params=PERIOD).json()
        assert (inventory['period_unreviewed_outgoing_minor'],inventory['period_unreviewed_outgoing_count'])==(1200,1)
        totals=client.get("/v1/analysis/spending",params=PERIOD).json()
        assert (totals['gross_minor'],totals['expense_count'])==(800,1)
        assert totals['category_baskets'][0]['label']=='unclassified'
        assert totals['unresolved_flow_count']==2


def test_totals_refunds_and_full_evidence_reconcile(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        expense = put(connection,owners[0],amount=-1000,merchant="Taxi A",category="taxi")
        refund = put(connection,owners[0],amount=200,flow="refund",merchant="Taxi refund",category="taxi")
        put(connection,owners[0],amount=-3000,flow="internal_transfer")
        put(connection,owners[0],amount=5000,flow="income")
        put(connection,owners[0],amount=-700,flow="unknown")
        put(connection,owners[0],amount=-400,status="pending")
        put(connection,owners[0],amount=-900,day="2026-11-01")
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        body = client.get("/v1/analysis/spending",params=PERIOD).json()
        assert (body["gross_minor"],body["refunds_minor"],body["net_minor"]) == (1000,200,800)
        assert (body["expense_count"],body["refund_count"],body["nonconsumption_count"],body["unresolved_flow_count"]) == (1,1,2,1)
        assert set(body["evidence_transaction_ids"]) == {expense,refund}
        rows = client.get("/v1/ledger/transactions",params={**PERIOD,"spending_only":True,"expected_data_version":body["scope"]["data_version"]}).json()["rows"]
        assert -sum(row["amount_minor"] for row in rows) == body["net_minor"]
        assert len(rows) == body["expense_count"]+body["refund_count"]
        assert sum(item["net_minor"] for item in body["category_baskets"]) == 800
        assert sum(item["net_minor"] for item in body["merchants"]) == 800


def test_literal_merchant_search_and_half_open_dates(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        included = put(connection,owners[0],day="2026-10-01",merchant="Discount 10%_ shop")
        put(connection,owners[0],day="2026-09-30",merchant="Discount 10%_ shop")
        put(connection,owners[0],day="2026-11-01",merchant="Discount 10%_ shop")
        put(connection,owners[0],merchant="Other shop")
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        rows = client.get("/v1/ledger/transactions",params={**PERIOD,"merchant":"10%_"}).json()["rows"]
        assert [row["id"] for row in rows] == [included]
        assert client.get("/v1/analysis/spending",params={**PERIOD,"merchant":"not present"}).json()["net_minor"] == 0


def test_cursor_is_tamper_resistant_and_profile_filter_and_version_bound(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        for _ in range(3):
            put(connection,owners[0])
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        cursor = client.get("/v1/ledger/transactions",params={**PERIOD,"limit":1}).json()["next_cursor"]
        assert client.get("/v1/ledger/transactions",params={**PERIOD,"cursor":cursor[:-5]+"aaaaa"}).status_code == 400
        assert client.get("/v1/ledger/transactions",params={**PERIOD,"category":"other","cursor":cursor}).status_code == 409
        login(client,"mika")
        assert client.get("/v1/ledger/transactions",params={**PERIOD,"cursor":cursor}).status_code == 409
        login(client)
        with psycopg.connect(database["admin"],autocommit=True) as connection:
            connection.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
        assert client.get("/v1/ledger/transactions",params={**PERIOD,"cursor":cursor}).status_code == 409
        assert client.get("/v1/analysis/spending",params={**PERIOD,"expected_data_version":1}).status_code == 409


def test_foreign_account_scope_does_not_grant_access(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        for foreign in owners[1:]:
            assert client.get("/v1/ledger/transactions",params={**PERIOD,"account_id":str(foreign[2])}).status_code == 404


def test_currencies_and_pending_records_are_never_silently_combined(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        foreign_account = uuid4()
        connection.execute("INSERT INTO moneylens.accounts (tenant_id,owner_user_id,id,name,currency,account_type) VALUES (%s,%s,%s,'USD account','USD','current')",(*owners[0][:2],foreign_account))
        put(connection,owners[0],amount=-123,status="pending")
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        assert client.get("/v1/ledger/transactions",params={**PERIOD,"account_id":str(foreign_account)}).status_code == 422
        assert client.get("/v1/analysis/spending",params={**PERIOD,"status":"pending"}).status_code == 422
        assert client.get("/v1/analysis/spending",params=PERIOD).json()["net_minor"] == 0
        assert len(client.get("/v1/ledger/transactions",params={**PERIOD,"status":"pending"}).json()["rows"]) == 1


def test_refund_only_period_and_invalid_flow_sign_are_explicit(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        put(connection,owners[0],amount=500,flow="refund")
        put(connection,owners[0],amount=123,flow="expense")
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        body = client.get("/v1/analysis/spending",params=PERIOD).json()
        assert body["net_minor"] == -500 and body["refunds_minor"] == 500 and body["gross_minor"] == 0
        assert body["unresolved_flow_count"] == 1


def test_aggregate_money_overflow_is_rejected_not_rounded(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        put(connection,owners[0],amount=-(2**53-1))
        put(connection,owners[0],amount=-1)
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        response = client.get("/v1/analysis/spending",params=PERIOD)
        assert response.status_code == 409 and response.json()["error"]["code"] == "AMOUNT_RANGE_EXCEEDED"


def test_repeatable_read_keeps_rows_and_version_coherent(database,owners):
    owner = owners[0]
    user = SimpleNamespace(scope=TrustedScope(owner[0],owner[1]),permission_version=1,synthetic=False)
    with psycopg.connect(database["runtime"],autocommit=True) as reader:
        with tenant_transaction(reader,user.scope,repeatable_read=True):
            ledger = Ledger(reader,user,LedgerFilterV1(start=date(2026,10,1),end_exclusive=date(2026,11,1)))
            with psycopg.connect(database["admin"]) as writer:
                put(writer,owner)
                writer.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owner[:2])
            assert ledger.totals().net_minor == 0
            assert ledger.page(CursorCodec("test-only-cursor-secret")).rows == []
            assert ledger.scope.data_version == 1
        with tenant_transaction(reader,user.scope,repeatable_read=True):
            ledger = Ledger(reader,user,LedgerFilterV1(start=date(2026,10,1),end_exclusive=date(2026,11,1)))
            assert ledger.totals().net_minor == 100 and ledger.scope.data_version == 2
