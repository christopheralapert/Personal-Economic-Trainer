from datetime import date
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import psycopg
import pytest

from app.ledger import Ledger
from identity_support import authenticated_app,login
from test_ledger import put

QUERY={"start":"2026-10-01","end_exclusive":"2026-11-01","mode":"previous_month"}
PATH="/v1/analysis/spending/comparison"


def test_comparison_filters_counts_refunds_and_complete_evidence(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        before=put(connection,owners[0],day="2026-09-10",amount=-200,category="taxi",merchant="Taxi 10%_")
        after=put(connection,owners[0],amount=-500,category="taxi",merchant="Taxi 10%_")
        refund=put(connection,owners[0],amount=100,flow="refund",category="taxi",merchant="Taxi 10%_")
        put(connection,owners[0],amount=-1000,category="coffee")
        put(connection,owners[0],amount=-700,flow="internal_transfer",category="taxi",merchant="Taxi 10%_")
        put(connection,owners[1],amount=-99999,category="taxi",merchant="Taxi 10%_")
    with authenticated_app(database,owners) as (client,app,config):
        assert client.get(PATH,params=QUERY).status_code==401
        login(client)
        response=client.get(PATH,params={**QUERY,"category":"taxi","merchant":"10%_"})
        assert response.status_code==200,response.text
        assert "no-store" in response.headers["cache-control"]
        body=response.json()
        assert body["status"]=="limited_comparison" and not body["equal_duration"]
        assert (body["baseline"]["net_minor"],body["current"]["net_minor"],body["change"]["net_minor"])==(200,400,200)
        assert body["change"]["net_change_basis_points"]==10000
        assert body["frequency"]["current_expense_count"]==body["frequency"]["baseline_expense_count"]==1
        assert body["current"]["scope"]["data_version"]==body["baseline"]["scope"]["data_version"]==1
        assert body["merchants"][0]["change_minor"]==200
        assert set(body["current"]["evidence_transaction_ids"])=={after,refund}
        assert body["baseline"]["evidence_transaction_ids"]==[before]
        for period in ("current","baseline"):
            window=body[period]["evidence_filters"]
            evidence=client.get("/v1/ledger/transactions",params={"start":window["start"],"end_exclusive":window["end_exclusive"],
                "category":"taxi","merchant":"10%_","spending_only":True,"expected_data_version":1}).json()
            assert -sum(row["amount_minor"] for row in evidence["rows"])==body[period]["net_minor"]


@pytest.mark.parametrize("foreign",[1,2])
def test_comparison_does_not_accept_foreign_scope(database,owners,foreign):
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        assert client.get(PATH,params={**QUERY,"account_id":str(owners[foreign][2])}).status_code==404


def test_comparison_rejects_wrong_versions_currencies_pending_and_windows(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        assert client.get(PATH,params={**QUERY,"expected_data_version":2}).status_code==409
        assert client.get(PATH,params={**QUERY,"status":"pending"}).status_code==422
        assert client.get(PATH,params={**QUERY,"start":"2026-10-02"}).json()["error"]["code"]=="INVALID_COMPARISON_PERIOD"
        assert client.get(PATH,params={**QUERY,"mode":"custom","baseline_start":"2026-09-01"}).status_code==422
        assert client.get(PATH,params={**QUERY,"mode":"previous_period","baseline_start":"2026-09-01"}).status_code==422
        assert client.get(PATH,params={**QUERY,"currency":"USD","account_id":str(owners[0][2])}).status_code==422


def test_custom_overlap_refund_and_no_match_remain_explicit(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        put(connection,owners[0],amount=500,flow="refund")
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        params={**QUERY,"mode":"custom","baseline_start":"2026-10-15","baseline_end_exclusive":"2026-10-25"}
        body=client.get(PATH,params=params).json()
        assert body["overlapping_windows"] and body["status"]=="limited_comparison"
        assert body["baseline"]["net_minor"]==body["current"]["net_minor"]==-500
        assert body["change"]["percentage_unavailable_reason"]=="baseline_not_positive"
        body=client.get(PATH,params={**params,"merchant":"No observed match"}).json()
        assert body["change"]["net_minor"]==0 and body["current"]["expense_count"]==0
        assert body["status"]=="limited_comparison" and any("zero rows" in note for note in body["limitations"])


def test_both_windows_remain_in_the_same_snapshot_during_a_writer(database,owners,monkeypatch):
    original=Ledger.totals
    reads=[]
    started=Event()
    workers=ThreadPoolExecutor(max_workers=1)
    future=None
    def write():
        with psycopg.connect(database["admin"]) as writer:
            put(writer,owners[0],amount=-123,day="2026-09-10")
            started.set()
            # The reader's owned-state fence serializes this version commit.
            writer.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
    def totals(self):
        nonlocal future
        result=original(self)
        reads.append(self.filters.start)
        if len(reads)==1:
            future=workers.submit(write)
            assert started.wait(3)
        return result
    monkeypatch.setattr(Ledger,"totals",totals)
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        response=client.get(PATH,params=QUERY)
        assert response.status_code==200,response.text
        body=response.json()
        assert reads==[date(2026,10,1),date(2026,9,1)]
        assert body["baseline"]["net_minor"]==0 and body["baseline"]["scope"]["data_version"]==1
        future.result(timeout=5)
        assert client.get(PATH,params={**QUERY,"expected_data_version":1}).status_code==409
    workers.shutdown(wait=True)


def test_difference_overflow_is_rejected_without_rounding(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        put(connection,owners[0],amount=-(2**53-1))
        put(connection,owners[0],amount=2**53-1,flow="refund",day="2026-09-10")
    with authenticated_app(database,owners) as (client,app,config):
        login(client)
        response=client.get(PATH,params=QUERY)
        assert response.status_code==409 and response.json()["error"]["code"]=="AMOUNT_RANGE_EXCEEDED"


def test_published_coverage_and_consent_apply_to_both_comparison_windows(database,owners):
    from test_bank_publication import connect,synchronize
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","comparison-consent")
        synchronize(database,client,app,config,auth,first,user)
        account=next(row for row in client.get("/v1/accounts/sources").json() if row["source"])
        params={**QUERY,"account_id":account["id"],"category":"taxi"}
        body=client.get(PATH,params=params).json()
        assert body["status"]=="covered_comparison"
        assert body["baseline"]["scope"]["dataset_coverage"]==body["current"]["scope"]["dataset_coverage"]=="covered_synthetic_snapshot"
        unresolved=client.get(PATH,params={**QUERY,"account_id":account["id"]}).json()
        assert unresolved["status"]=="limited_comparison" and unresolved["current"]["unresolved_flow_count"]>0
        partial=client.get(PATH,params={**params,"mode":"custom","baseline_start":"2026-07-01","baseline_end_exclusive":"2026-08-01"}).json()
        assert partial["status"]=="limited_comparison" and partial["baseline"]["scope"]["dataset_coverage"]=="partial"
        client.post(f"/v1/bank-connections/{first['connection']['id']}/disconnect",headers=auth,json={})
        assert client.get(PATH,params=params).json()["error"]["code"]=="BANK_ACCOUNT_ACCESS_REQUIRED"
