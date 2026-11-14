from datetime import timedelta
from uuid import uuid4

import psycopg
import pytest

from identity_support import authenticated_app, login
from test_planning_store import NOW, POLICY, reviewed, store
from test_planning_routes import seed_plan, session, command


def test_reloaded_history_preserves_receipts_review_and_current_release_versions(database, owners):
    plan = seed_plan(database,owners[0])
    url = f"/v1/plans/{plan['id']}"
    with authenticated_app(database,owners) as (client,app,config):
        app.state.planning_clock = lambda:NOW
        headers = session(client)
        receipt = client.post(url+"/allocations",headers=headers,json=command(owners[0])).json()
        review = client.get(url+"/review").json()
        assert review["current"] is True and review["inputs"]["plan_version"]==3
        assert sum(p["amount_minor"] for p in review["inputs"]["protections"] if p["kind"]=="savings")==5000
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
        app.state.planning_clock = lambda:NOW+timedelta(minutes=6)
        page = client.get(url+"/allocations").json()
        assert page["rows"]==[receipt] and page["data_version"]==2 and page["plan_version"]==3
        assert client.get(url+"/review").json()["current"] is False
        response = client.post(url+f"/allocations/{receipt['id']}/release",headers=headers,
            json=dict(key="release-after-reload",expected_data_version=page["data_version"],expected_plan_version=page["plan_version"]))
        assert response.status_code==200,response.text
        assert response.json()["state"]=="released"
        assert client.get(url).json()["analysis"]["result"]["amount_minor"] is None


def test_receipt_keyset_pages_are_complete_and_version_namespace_and_plan_bound(database, owners):
    inputs = reviewed(database,owners[0])
    with store(database,owners[0]) as repository:
        plan = repository.create(inputs,POLICY,key="first-plan")
        for index in range(7):
            repository.accept(plan["id"],key=f"save-{index}",expected_data_version=1,expected_plan_version=2+index,
                account_id=owners[0][2],amount_minor=100,desired_discretionary_minor=0)
    url = f"/v1/plans/{plan['id']}/allocations"
    with authenticated_app(database,owners) as (client,app,config):
        headers = session(client)
        cursor,seen = None,[]
        while True:
            response = client.get(url,params={"limit":2,**({"cursor":cursor} if cursor else {})})
            assert response.status_code==200,response.text
            page = response.json()
            seen.extend(row["id"] for row in page["rows"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        assert len(seen)==len(set(seen))==7
        first = client.get(url,params={"limit":2}).json()["next_cursor"]
        assert client.get(url,params={"cursor":first[:-5]+"aaaaa"}).status_code==400
        assert client.get("/v1/ledger/transactions",params={"start":"2026-10-01","end_exclusive":"2026-11-01","cursor":first}).status_code==409
        response = client.post(f"/v1/plans/{plan['id']}/allocations/{seen[0]}/release",headers=headers,
            json=dict(key="release-1",expected_data_version=1,expected_plan_version=9))
        assert response.status_code==200,response.text
        assert client.get(url,params={"cursor":first}).status_code==409


@pytest.mark.parametrize("index",[1,2])
def test_saved_review_and_receipt_pages_reject_foreign_resources(database, owners,index):
    plan = seed_plan(database,owners[index])
    with authenticated_app(database,owners) as (client,app,config):
        url = f"/v1/plans/{plan['id']}"
        assert client.get(url+"/review").status_code==401
        login(client)
        assert client.get(url+"/review").status_code==404
        assert client.get(url+"/allocations").status_code==404
        assert client.get(f"/v1/plans/{uuid4()}/allocations").status_code==404
