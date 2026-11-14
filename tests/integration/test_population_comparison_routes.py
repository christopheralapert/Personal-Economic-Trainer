import psycopg
import pytest

from app import benchmark_routes
from app.statfin import SnapshotError
from identity_support import authenticated_app
from test_bank_publication import connect,synchronize
from test_bank_routes import headers,start,finish

PATH="/v1/benchmarks/comparison"
BODY=dict(household_code="1",reference_period="2022",start="2026-10-01",end_exclusive="2026-11-01",coicop_codes=["07322"],
    comparison_basis="monthly_equivalent",household_coverage_confirmed=True,allow_short_period_approximation=True,allow_reference_year_mismatch=True)


def published(database,owners,client,app,config):
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("DELETE FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",owners[0])
    auth,first,user=connect(client,app,"s-bank-demo","benchmark-first")
    synchronize(database,client,app,config,auth,first,user)
    second=start(client,auth,"north-demo","benchmark-second");finish(client,auth,second)
    synchronize(database,client,app,config,auth,second,user,key="benchmark-north-refresh")
    accounts=[item["id"] for item in client.get("/v1/accounts/sources").json() if item["source"]]
    return auth,first,{**BODY,"account_ids":accounts}


def test_real_two_bank_household_comparison_is_scoped_approximate_and_read_only(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,body=published(database,owners,client,app,config)
        taxi=client.get("/v1/analysis/spending",params={"start":BODY["start"],"end_exclusive":BODY["end_exclusive"],"category":"taxi"}).json()
        response=client.post(PATH,headers=auth,json={**body,"expected_data_version":taxi["scope"]["data_version"]})
        assert response.status_code==200,response.text
        result=response.json()
        assert "no-store" in response.headers["cache-control"] and result["status"]=="approximate"
        assert result["rows"][0]["observed_equivalent_minor"]==taxi["net_minor"]
        assert result["selection"]["cohort"]["code"]=="1" and not result["selection"]["fallback_used"]
        assert result["mapping"]["scope"]["data_version"]==taxi["scope"]["data_version"]
        assert result["source"]["reference_period"]=="2022" and result["source"]["licence_url"]
        omitted=client.post(PATH,headers=auth,json={**body,"account_ids":body["account_ids"][:1]}).json()
        assert omitted["status"]=="withheld" and not omitted["known_owned_scope_complete"]
        assert client.get("/v1/analysis/spending",params={"start":BODY["start"],"end_exclusive":BODY["end_exclusive"]}).json()["scope"]["data_version"]==taxi["scope"]["data_version"]
        mixed=client.post(PATH,headers=auth,json={**body,"coicop_codes":["07322","01"]}).json()
        assert mixed["status"]=="partial" and mixed["rows"][0]["status"]=="approximate" and mixed["rows"][1]["status"]=="withheld"
        assert client.post(PATH,headers=auth,json={**body,"expected_data_version":1}).status_code==409
        client.post(f"/v1/bank-connections/{first['connection']['id']}/disconnect",headers=auth,json={})
        assert client.post(PATH,headers=auth,json=body).status_code==409


@pytest.mark.parametrize("foreign",[1,2])
def test_household_confirmation_never_grants_other_account_access(database,owners,foreign):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        assert client.post(PATH,headers=auth,json={**BODY,"account_ids":[str(owners[foreign][2])]}).status_code==404


def test_unverified_empty_history_does_not_become_zero_household_spending(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        result=client.post(PATH,headers=auth,json=BODY).json()
        assert result["status"]=="withheld" and result["mapping"]["total_observed"]["net_minor"]==0
        assert result["rows"][0]["observed_equivalent_minor"] is None and result["rows"][0]["difference_minor"] is None
        assert "INCOMPLETE_ACCOUNT_HISTORY" in {item["code"] for item in result["reasons"]}


def test_source_failure_and_strict_auth_body_period_and_category_bounds(database,owners,monkeypatch):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.post(PATH,json=BODY).status_code==401
        auth=headers(client)
        assert client.post(PATH,json=BODY).status_code==403
        assert client.post(PATH,json=BODY,headers={**auth,"Origin":"https://foreign.invalid"}).status_code==403
        assert client.post(PATH,json=BODY,headers={**auth,"X-MoneyLens-Session-ID":"00000000-0000-0000-0000-000000000000"}).status_code==409
        assert client.post(PATH,headers=auth,content=b"x"*8193).status_code==413
        assert client.post(PATH,headers=auth,json={**BODY,"start":"2026-10-02"}).status_code==422
        assert client.post(PATH,headers=auth,json={**BODY,"coicop_codes":["111","1111"]}).json()["error"]["code"]=="INVALID_BENCHMARK_CATEGORIES"
        assert client.post(PATH,headers=auth,json={**BODY,"coicop_codes":["04"]}).status_code==422
        assert client.post(PATH,headers=auth,json={**BODY,"scope":{"dataset_coverage":"covered_synthetic_snapshot"}}).status_code==422
        def broken(): raise SnapshotError("Integrity failure")
        monkeypatch.setattr(benchmark_routes,"bundled_public_context",broken)
        result=client.post(PATH,headers=auth,json=BODY).json()
        assert result["status"]=="unavailable" and result["rows"]==[] and result["source"] is None


def test_material_bank_failure_never_advances_observed_population_comparison(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,body=published(database,owners,client,app,config)
        result=client.post(PATH,headers=auth,json=body).json()
        observed=result["mapping"]["scope"]["sources"][0]["observed_at"]
        client.post(f"/v1/bank-connections/{first['connection']['id']}/scenario",headers=auth,json={"fault":"unavailable"})
        after=client.post(PATH,headers=auth,json=body).json()
        assert after["status"]=="withheld" and after["rows"][0]["difference_minor"] is None
        assert not after["material_bank_sources_complete"]
        assert after["mapping"]["scope"]["sources"][0]["observed_at"]==observed


def test_new_granted_unpublished_bank_is_material_even_before_it_has_an_account_alias(database,owners):
    with psycopg.connect(database["admin"]) as connection:
        connection.execute("DELETE FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",owners[0])
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","unpublished-first")
        synchronize(database,client,app,config,auth,first,user)
        second=start(client,auth,"north-demo","unpublished-second");finish(client,auth,second)
        result=client.post(PATH,headers=auth,json=BODY).json()
        assert result["status"]=="withheld" and result["known_owned_scope_complete"]
        assert not result["material_bank_sources_complete"]
        assert "MATERIAL_BANK_SOURCE_INCOMPLETE" in {item["code"] for item in result["reasons"]}
