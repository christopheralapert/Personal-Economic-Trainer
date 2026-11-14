import pytest

from app.statfin import SnapshotError
from app import benchmark_routes
from identity_support import authenticated_app
from test_bank_routes import headers

PATH="/v1/benchmarks/cohort-selection"
BODY={"household_code":"1","reference_period":"2022"}


def test_cohort_choice_requires_verified_session_origin_csrf_and_expected_session(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.post(PATH,json=BODY).status_code==401
        auth=headers(client)
        assert client.post(PATH,json=BODY).status_code==403
        assert client.post(PATH,json=BODY,headers={**auth,"Origin":"https://foreign.invalid"}).status_code==403
        assert client.post(PATH,json=BODY,headers={**auth,"X-MoneyLens-Session-ID":"00000000-0000-0000-0000-000000000000"}).status_code==409
        response=client.post(PATH,json=BODY,headers=auth)
        assert response.status_code==200 and "no-store" in response.headers["cache-control"]
        result=response.json()
        assert result["cohort"]["code"]=="1" and result["catalog"]["snapshot"]["statistic_type"]=="mean"
        assert "owner" not in result and not result["fallback_used"]


@pytest.mark.parametrize("extra",[{"region":"Helsinki"},{"income_band":"high"},{"owner_user_id":"other"},{"age":25}])
def test_personal_intersections_and_authority_are_not_accepted(database,owners,extra):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        assert client.post(PATH,json={**BODY,**extra},headers=auth).status_code==422


def test_unknown_choices_body_bounds_and_snapshot_failure_are_explicit(database,owners,monkeypatch):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        result=client.post(PATH,json={**BODY,"household_code":"unavailable"},headers=auth).json()
        assert result["status"]=="unavailable" and result["reason"]=="HOUSEHOLD_COHORT_UNAVAILABLE"
        assert client.post(PATH,content=b"x"*8193,headers=auth).status_code==413
        def broken(*args): raise SnapshotError("Integrity failure")
        monkeypatch.setattr(benchmark_routes,"select_cohort",broken)
        result=client.post(PATH,json=BODY,headers=auth).json()
        assert result["reason"]=="VERIFIED_COHORTS_UNAVAILABLE" and result["cohort"] is None and result["catalog"] is None
