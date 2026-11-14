from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import shutil

from fastapi.testclient import TestClient
import httpx
import pytest

from app.main import create_app
from app.settings import Settings
from app.statfin import BASE,COICOP,HOUSEHOLD,SNAPSHOT,SPEC,SnapshotError,build_query,fingerprint,load_snapshot,money_minor,validate_response
from app.statfin_client import ProviderError,StatFinClient
from app import public_routes


@pytest.fixture
def source():
    return load_snapshot()


def test_bundled_snapshot_contains_actual_attributed_data_and_suppression(source):
    manifest,documents,cells = source
    assert manifest["snapshot_id"] == "statfin-ktutk-2022-51770478e803db26"
    assert len(cells["14ph"]) == 42 and len(cells["14lv"]) == 21
    assert any(cell["value"] is None and cell["status"]=="..." for cell in cells["14ph"])
    assert manifest["licence"] == "CC-BY-4.0" and "Statistics Finland" in manifest["attribution"]
    assert manifest["tables"]["14ph"]["data_updated_at"] == "2024-04-11T05:00:00Z"
    assert documents["config.json"]["maxCalls"] == 40


def test_current_metadata_drives_query_codes_not_translated_labels(source):
    _,documents,_ = source
    metadata = documents["14ph.metadata.json"]
    query = build_query(metadata,"14ph",expected_fingerprint=fingerprint(metadata))
    assert {item["code"] for item in query["query"]} == set(SPEC["14ph"])
    old = deepcopy(metadata)
    old["variables"][0]["code"] = "Vuosi"
    with pytest.raises(SnapshotError):
        build_query(old,"14ph")
    with pytest.raises(SnapshotError):
        build_query(metadata,"14ph",max_cells=10)


def test_schema_fingerprint_detects_semantic_label_changes(source):
    _,documents,_ = source
    original = documents["14ph.metadata.json"]
    changed = deepcopy(original)
    changed["variables"][1]["valueTexts"][0] = "Changed statistical concept"
    with pytest.raises(SnapshotError):
        build_query(changed,"14ph",expected_fingerprint=fingerprint(original))


@pytest.mark.parametrize("change", ["unit","labels","selection","shape","negative","non_numeric","wrong_source","status","duplicate_index","precision","too_large"])
def test_incompatible_response_is_rejected(source,change):
    _,documents,_ = source
    response = deepcopy(documents["14ph.response.json"])
    if change == "unit":
        response["dimension"]["contentscode"]["category"]["unit"]["kulu_kt_hk_1_1"]["base"] = "percent"
    elif change == "labels":
        response["dimension"][HOUSEHOLD]["category"]["label"]["1"] = "Invented intersection"
    elif change == "selection":
        response["dimension"][HOUSEHOLD]["category"]["index"]["another"] = response["dimension"][HOUSEHOLD]["category"]["index"].pop("1")
    elif change == "shape":
        response["value"].pop()
    elif change == "negative":
        response["value"][0] = -1
    elif change == "non_numeric":
        response["value"][0] = "suppressed"
    elif change == "wrong_source":
        response["source"] = "Unverified source"
    elif change == "status":
        response["status"] = {"999": "..."}
    elif change == "precision":
        response["value"][0] = 123.45
    elif change == "too_large":
        response["value"][0] = 10**100
    else:
        response["dimension"][HOUSEHOLD]["category"]["index"]["2"] = 0
    with pytest.raises(SnapshotError):
        validate_response(response,documents["14ph.metadata.json"],documents["14ph.query.json"],"14ph")


def test_sparse_values_follow_explicit_coordinate_indexes(source):
    _,documents,cells = source
    response = deepcopy(documents["14ph.response.json"])
    response["value"] = {str(index):value for index,value in enumerate(response["value"]) if value is not None}
    actual = validate_response(response,documents["14ph.metadata.json"],documents["14ph.query.json"],"14ph")
    assert actual == cells["14ph"]


def test_corruption_and_changed_query_fail_offline_integrity(tmp_path):
    target = tmp_path / "snapshot"
    shutil.copytree(SNAPSHOT,target)
    path = target / "14ph.response.json"
    path.write_bytes(path.read_bytes()+b" ")
    with pytest.raises(SnapshotError,match="INTEGRITY_FAILURE"):
        load_snapshot(target)


def test_public_context_discloses_reference_units_without_personal_ranking():
    with TestClient(create_app(Settings(environment="test"))) as client:
        response = client.get("/v1/public/benchmarks/consumption")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] and body["snapshot"]["statistic_type"] == "mean"
    assert body["snapshot"]["reference_period"] == "2022"
    assert len(body["cohorts"]) == 7 and len(body["observations"]) == 42
    assert any(item["annual_mean_minor"] is None and item["monthly_equivalent_minor"] is None for item in body["observations"])
    assert "not a median, percentile" in " ".join(body["limitations"])
    assert response.headers["cache-control"] == "private, no-store"


def test_unavailable_snapshot_does_not_invent_population_numbers(monkeypatch):
    def broken():
        raise SnapshotError("INTEGRITY_FAILURE")
    monkeypatch.setattr(public_routes,"bundled_public_context",broken)
    with TestClient(create_app(Settings(environment="test"))) as client:
        body = client.get("/v1/public/benchmarks/consumption").json()
    assert body["available"] is False and body["observations"] == [] and body["snapshot"] is None


def test_integer_conversion_rounding_and_missing_are_distinct():
    assert money_minor(0) == 0 and money_minor(None) is None
    assert money_minor(1143) == 114300 and money_minor(1143,12) == 9525
    assert money_minor(1,12) == 8


class Clock:
    def __init__(self):
        self.value = 0
    def now(self):
        return self.value
    def sleep(self,seconds):
        self.value += seconds


def test_provider_budget_is_read_and_local_pacing_is_bounded():
    clock = Clock()
    transport = httpx.MockTransport(lambda request:httpx.Response(200,json={"maxCalls":40,"timeWindow":60,"maxCells":120000}))
    client = StatFinClient(httpx.Client(transport=transport),clock=clock.now,sleep=clock.sleep)
    try:
        client.configure()
        client.request("GET",BASE)
        assert clock.value == 2 and client.max_cells == 1000
    finally:
        client.close()


def test_throttle_honors_retry_after_without_busy_retry():
    requests,clock = [],Clock()
    def respond(request):
        requests.append(request)
        return httpx.Response(429,headers={"Retry-After":"120"})
    client = StatFinClient(httpx.Client(transport=httpx.MockTransport(respond)),clock=clock.now,sleep=clock.sleep)
    try:
        for _ in range(2):
            with pytest.raises(ProviderError) as error:
                client.request("GET",BASE)
            assert error.value.code == "PROVIDER_THROTTLED"
        assert len(requests) == 1 and clock.value == 0
    finally:
        client.close()


def test_personal_parameters_and_arbitrary_urls_never_reach_provider():
    requests = []
    client = StatFinClient(httpx.Client(transport=httpx.MockTransport(lambda request:requests.append(request))))
    try:
        with pytest.raises(ValueError):
            client.request("GET","https://evil.example/private")
        with pytest.raises(ValueError):
            client.request("POST",BASE+"/14ph.px",{"user_id":"private-user","transactions":[]})
        assert requests == []
    finally:
        client.close()


def test_oversized_provider_response_is_bounded():
    client = StatFinClient(httpx.Client(transport=httpx.MockTransport(lambda request:httpx.Response(200,content=b" "*1048577))))
    try:
        with pytest.raises(ProviderError) as error:
            client.request("GET",BASE)
        assert error.value.code == "PROVIDER_RESPONSE_LIMIT"
    finally:
        client.close()


def test_failed_download_never_overwrites_previous_snapshot_or_publishes_partial(tmp_path):
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("snapshot_script",root / "scripts/statfin_snapshot.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    class BrokenClient:
        def configure(self):
            return (SNAPSHOT / "config.json").read_bytes()
        def request(self,*args):
            raise ProviderError("PROVIDER_UNAVAILABLE")
    target = tmp_path / "new-release"
    with pytest.raises(ProviderError):
        script.download(target,BrokenClient())
    assert not target.exists() and list(tmp_path.iterdir()) == []
    with pytest.raises(ValueError):
        script.download(SNAPSHOT,BrokenClient())
    assert load_snapshot()[0]["snapshot_id"] == "statfin-ktutk-2022-51770478e803db26"
