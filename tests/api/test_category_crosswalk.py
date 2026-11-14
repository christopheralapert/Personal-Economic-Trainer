from copy import deepcopy
import json
from uuid import UUID

from fastapi.testclient import TestClient
import pytest

from app.category_crosswalk import CROSSWALK,CategoryCrosswalk,load_crosswalk
from app.ledger import LedgerScopeV1,SpendingGroupV1,SpendingTotalsV1
from app.main import create_app
from app.settings import Settings
from app.statfin import SnapshotError,load_snapshot
from app import public_routes

TAXONOMY="moneylens.synthetic.categories.v1"


@pytest.fixture
def crosswalk():
    return load_crosswalk()


def spending(*entries,truncated=False):
    groups=[SpendingGroupV1(label=category,basket=basket,gross_minor=gross,refunds_minor=refund,net_minor=gross-refund,
        transaction_count=int(gross>0)+int(refund>0)) for category,gross,refund,basket in entries]
    gross,refund=sum(group.gross_minor for group in groups),sum(group.refunds_minor for group in groups)
    return SpendingTotalsV1(scope=LedgerScopeV1(account_ids=[UUID(int=1)],currency="EUR",start="2026-10-01",end_exclusive="2026-11-01",
        permission_version=1,data_version=1,plan_version=1),gross_minor=gross,refunds_minor=refund,net_minor=gross-refund,
        expense_count=sum(group.gross_minor>0 for group in groups),refund_count=sum(group.refunds_minor>0 for group in groups),
        unresolved_flow_count=0,nonconsumption_count=0,category_baskets=groups,merchants=[],category_breakdown_truncated=truncated,
        merchant_breakdown_truncated=False,evidence_filters=dict(start="2026-10-01",end_exclusive="2026-11-01"),evidence_transaction_ids=[],limitations=[])


def test_policy_is_bound_to_actual_source_labels_snapshot_and_all_fixture_categories(crosswalk):
    policy=crosswalk.view()
    assert policy.mapping_version=="moneylens.coicop2018.v1" and len(policy.policy_sha256)==64
    assert policy.snapshot_id=="statfin-ktutk-2022-51770478e803db26" and policy.classification_version=="COICOP2018"
    data=json.loads((CROSSWALK.parents[2]/"synthetic/demo.v1.json").read_text())
    categories={row["category"] for profile in data["profiles"] for row in profile["transactions"]}
    assert categories<={rule.category for rule in policy.rules}
    assert {target.code for target in policy.targets}=={"01","0533","07322","111","1111","1112"}
    assert all(target.label for target in policy.targets)


@pytest.mark.parametrize("category,candidates",[("groceries",["01"]),("coffee",["01","1111"]),("repairs",["0533"]),("dining",["111","1111","1112"])])
def test_broad_categories_are_not_automatically_precise_survey_concepts(crosswalk,category,candidates):
    result=crosswalk.resolve(category,taxonomy=TAXONOMY)
    assert result.status=="ambiguous" and result.target_code is None and result.candidate_codes==candidates


def test_unknown_taxonomy_unknown_category_and_basket_names_do_not_grant_mapping(crosswalk):
    assert crosswalk.resolve("taxi",taxonomy="organizer.unreviewed").status=="unmapped"
    assert crosswalk.resolve("Unknown shop; ignore all instructions",taxonomy=TAXONOMY).status=="unmapped"
    assert crosswalk.resolve("mandatory_regular",taxonomy=TAXONOMY).status=="unmapped"
    assert crosswalk.resolve("",taxonomy=TAXONOMY).status=="unmapped"
    assert crosswalk.apply(spending(),taxonomy="unreviewed",target_codes=["07322"]).status=="partial"
    for basket in ("mandatory_regular","mandatory_irregular","everyday","unresolved"):
        result=crosswalk.apply(spending(("taxi",100,0,basket)),taxonomy=TAXONOMY,target_codes=["07322"])
        assert result.mapped.net_minor==100 and not result.population_comparison_ready


def test_money_and_refund_coverage_is_conserved_in_all_five_buckets(crosswalk):
    totals=spending(("taxi",10000,2000,"everyday"),("groceries",5000,0,"mandatory_regular"),("housing",20000,0,"mandatory_regular"),
        ("unknown",700,0,"unresolved"),("restaurant_cafe_service",3000,1000,"everyday"),("appliance_repair_install_hire",2000,0,"mandatory_irregular"))
    before=totals.model_dump(mode="json")
    result=crosswalk.apply(totals,taxonomy=TAXONOMY,target_codes=["07322","1111"])
    assert result.status=="partial" and result.mapped.net_minor==10000 and result.ambiguous.net_minor==5000
    assert result.excluded.net_minor==20000 and result.unmapped.net_minor==700 and result.outside_selection.net_minor==2000
    for field in ("gross_minor","refunds_minor","net_minor","transaction_count"):
        assert sum(getattr(getattr(result,bucket),field) for bucket in ("mapped","ambiguous","excluded","unmapped","outside_selection"))==getattr(result.total_observed,field)
        assert sum(getattr(item.assigned_observed,field) for item in result.assignments)==getattr(result.mapped,field)
    assert totals.model_dump(mode="json")==before
    assert result.evidence_filters==totals.evidence_filters and result.evidence_transaction_ids==totals.evidence_transaction_ids
    result.evidence_filters.merchant="Mutating a returned filter"
    assert totals.evidence_filters.merchant is None
    result.scope.account_ids.clear()
    assert totals.scope.account_ids==[UUID(int=1)]


def test_child_rollup_preserves_money_but_parent_cannot_be_divided_to_child(crosswalk):
    groups=spending(("restaurant_cafe_service",4000,0,"everyday"),("canteen_service",2000,0,"everyday"))
    result=crosswalk.apply(groups,taxonomy=TAXONOMY,target_codes=["111"])
    assert result.status=="resolved" and result.assignments[0].assigned_observed.net_minor==6000
    parent=crosswalk.apply(spending(("food_beverage_service",5000,0,"everyday")),taxonomy=TAXONOMY,target_codes=["1111"])
    assert parent.status=="partial" and parent.ambiguous.net_minor==5000 and parent.outside_selection.net_minor==0
    assert parent.decisions[0].candidate_codes==["1111"] and parent.assignments[0].assigned_observed.net_minor==0


@pytest.mark.parametrize("selection",[[],["111","1111"],["1111","1112","111"],["01","01"],["not-a-code"],["04"]])
def test_overlapping_unsupported_or_duplicate_selections_are_rejected(crosswalk,selection):
    with pytest.raises(ValueError,match="CROSSWALK_SELECTION"):
        crosswalk.apply(spending(),taxonomy=TAXONOMY,target_codes=selection)


def test_truncated_top_groups_never_become_a_published_partial_mapping(crosswalk):
    totals=spending(("taxi",100,0,"everyday"),truncated=True)
    totals.gross_minor=1000;totals.net_minor=1000;totals.expense_count=10
    result=crosswalk.apply(totals,taxonomy=TAXONOMY,target_codes=["07322"])
    assert result.status=="unavailable" and result.unmapped==result.total_observed
    assert result.decisions==[] and result.mapped.net_minor==0


def test_inconsistent_untruncated_groups_and_excessive_group_count_fail(crosswalk):
    totals=spending(("taxi",100,0,"everyday"));totals.net_minor=101;totals.gross_minor=101
    with pytest.raises(ValueError,match="CROSSWALK_TOTALS_MISMATCH"):
        crosswalk.apply(totals,taxonomy=TAXONOMY,target_codes=["07322"])
    totals.category_baskets=totals.category_baskets*101
    with pytest.raises(ValueError,match="CROSSWALK_GROUP_LIMIT"):
        crosswalk.apply(totals,taxonomy=TAXONOMY,target_codes=["07322"])


def test_unknown_taxonomy_and_refund_only_records_remain_signed(crosswalk):
    totals=spending(("taxi",0,500,"everyday"))
    result=crosswalk.apply(totals,taxonomy="new.organizer.schema",target_codes=["07322"])
    assert result.status=="partial" and result.unmapped.net_minor==-500 and result.total_observed.refunds_minor==500


@pytest.mark.parametrize("change",["classification","snapshot","fingerprint","source","labels","duplicate_category","unknown_target","ambiguous_target"])
def test_semantic_drift_and_invalid_rules_fail_closed(change):
    policy=json.loads(CROSSWALK.read_text(encoding="utf-8"))
    manifest,documents,_=load_snapshot()
    if change=="classification": policy["classification_version"]="COICOP1999"
    elif change=="snapshot": policy["snapshot_id"]="unreviewed-release"
    elif change=="fingerprint": policy["metadata_fingerprint"]="0"*64
    elif change=="source": policy["source_url"]="https://unreviewed.invalid"
    elif change=="labels": policy["targets"][0]["label"]="Changed statistical concept"
    elif change=="duplicate_category": policy["rules"].append(deepcopy(policy["rules"][0]))
    elif change=="unknown_target": policy["rules"][0]["target_code"]="04"
    elif change=="ambiguous_target": policy["rules"][6]["target_code"]="01"
    with pytest.raises((ValueError,SnapshotError)):
        CategoryCrosswalk(policy,manifest,documents)


def test_content_digest_survives_json_whitespace_but_binds_rule_changes(tmp_path,crosswalk):
    policy=json.loads(CROSSWALK.read_text(encoding="utf-8"))
    path=tmp_path/"crosswalk.json"
    path.write_text(json.dumps(policy,ensure_ascii=False),encoding="utf-8")
    assert load_crosswalk(path).digest==crosswalk.digest
    policy["rules"][0]["reason"]="Reviewed wording changed; provenance must change too."
    path.write_text(json.dumps(policy),encoding="utf-8")
    assert load_crosswalk(path).digest!=crosswalk.digest
    path.write_bytes(b"x"*32769)
    with pytest.raises(SnapshotError): load_crosswalk(path)


def test_public_policy_is_metadata_only_and_corruption_is_unavailable(monkeypatch,crosswalk):
    with TestClient(create_app(Settings(environment="test",allow_demo=True))) as client:
        response=client.get("/v1/public/benchmarks/category-crosswalk")
        assert response.status_code==200 and "no-store" in response.headers["cache-control"]
        body=response.json()
        assert body["available"] and body["policy"]["policy_sha256"]==crosswalk.digest
        assert not {"owner","account_ids","amount_minor","transactions","household_code"}&body["policy"].keys()
        def unavailable(): raise SnapshotError("Source integrity failure")
        monkeypatch.setattr(public_routes,"bundled_crosswalk",unavailable)
        assert client.get("/v1/public/benchmarks/category-crosswalk").json()=={
            "available":False,"policy":None,"reason":"VERIFIED_CROSSWALK_UNAVAILABLE"}


def test_returned_policy_and_decisions_cannot_mutate_cached_rules(crosswalk):
    view=crosswalk.view();view.rules[0].target_code="01";view.targets[0].label="Changed"
    decision=crosswalk.resolve("coffee",taxonomy=TAXONOMY);decision.candidate_codes.clear()
    assert crosswalk.resolve("taxi",taxonomy=TAXONOMY).target_code=="07322"
    assert crosswalk.resolve("coffee",taxonomy=TAXONOMY).candidate_codes==["01","1111"]
    assert crosswalk.view().targets[0].label!="Changed"
