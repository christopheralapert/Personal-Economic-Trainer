import csv
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import sys

import pytest

from app.import_contracts import ImportManifestV1
from app.import_csv import COLUMNS,InvalidRow,validate_row

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"scripts"))
from generate_scale_fixture import generate,owner_counts,transaction,verify

NOW=datetime(2026,11,6,tzinfo=timezone.utc)


def test_real_profile_allocations_are_exact_skewed_and_preserve_the_heavy_owner():
    for rows in (1_000_000,10_000_000):
        counts=owner_counts(rows)
        assert len(counts)==1000 and sum(counts)==rows and counts[0]==100000
        assert all(count>=20 and count%20==0 for count in counts)
        assert max(counts[1:])>min(counts[1:])*2
        assert max(counts[1:])<counts[0]
        assert counts==owner_counts(rows)


def test_streamed_owner_packages_are_reproducible_valid_and_have_exact_control_totals(tmp_path):
    outputs=[tmp_path/"first",tmp_path/"second"]
    results=[generate(output,rows=400,users=4,heavy_rows=120) for output in outputs]
    assert results[0]==results[1]
    first={str(path.relative_to(outputs[0])):path.read_bytes() for path in outputs[0].rglob("*") if path.is_file()}
    second={str(path.relative_to(outputs[1])):path.read_bytes() for path in outputs[1].rglob("*") if path.is_file()}
    assert first==second
    inventory,digest=results[0]
    assert hashlib.sha256((outputs[0]/"index.json").read_bytes()).hexdigest()==digest
    assert inventory["complete"] and inventory["base_transactions"]==400 and inventory["accounts"]==12
    assert verify(outputs[0],digest)["base_transactions"]==400
    for entry in inventory["owners"]:
        root=outputs[0]/entry["path"]
        raw=(root/"manifest.json").read_bytes()
        assert hashlib.sha256(raw).hexdigest()==entry["manifest_sha256"]
        manifest=ImportManifestV1.model_validate_json(raw)
        controls={account:[0,0] for account in ("daily","reserve","card")}
        accounts={}
        for file in manifest.files:
            source=(root/f"{file.role}.csv").read_bytes()
            assert len(source)==file.size_bytes and hashlib.sha256(source).hexdigest()==file.sha256
            with (root/f"{file.role}.csv").open(encoding="utf-8",newline="") as handle:
                reader=csv.reader(handle);assert tuple(next(reader))==COLUMNS[file.role]
                for row in reader:
                    parsed=validate_row(file.role,row,manifest,NOW)
                    if file.role=="transactions":
                        controls[parsed["account_ref"]][0]+=1;controls[parsed["account_ref"]][1]+=parsed["amount_minor"]
                    elif file.role=="accounts": accounts[parsed["account_ref"]]=[parsed["expected_transactions"],parsed["expected_net_minor"]]
        assert controls==accounts==entry["account_controls"]
        assert all(values[0]>0 for values in controls.values())
        assert entry["row_features"]["internal_transfer"]%2==0


def test_revision_variant_preserves_every_other_record_and_balances_the_same_id_transition(tmp_path):
    index,_=generate(tmp_path/"data",rows=200,users=3,heavy_rows=120)
    root=tmp_path/"data"
    def records(folder):
        with (root/folder/"transactions.csv").open(newline="",encoding="utf-8") as handle:
            return {row["source_id"]:row for row in csv.DictReader(handle)}
    original=records("owners/u00000");revised=records("variants/pending-booked")
    assert original.keys()==revised.keys()
    changed=[key for key in original if original[key]!=revised[key]]
    assert changed==["tx-000000004"]
    assert original[changed[0]]["status"]=="pending" and revised[changed[0]]["status"]=="booked"
    assert revised[changed[0]]["revision"]=="2"
    assert sum(int(row["amount_minor"]) for row in revised.values())-sum(int(row["amount_minor"]) for row in original.values())==50
    negative=root/"variants/invalid-money"
    manifest=ImportManifestV1.model_validate_json((negative/"manifest.json").read_bytes())
    with (negative/"transactions.csv").open(newline="",encoding="utf-8") as handle:
        rows=list(csv.reader(handle))[1:]
    rejected=[]
    for ordinal,row in enumerate(rows,1):
        try: validate_row("transactions",row,manifest,NOW)
        except InvalidRow as failure: rejected.append((ordinal,failure.code))
    assert rejected==[(8,"invalid_integer")]
    assert index["variants"][1]["row_ordinal"]==8


def test_transfer_references_match_and_all_twenty_four_months_are_present():
    days=set()
    for block in range(24):
        debit=transaction(311045,0,block*20);credit=transaction(311045,0,block*20+1)
        assert debit[4]+credit[4]==0 and debit[6]==credit[6]
        assert debit[14:]==(credit[1],credit[2]) and credit[14:]==(debit[1],debit[2])
        days.add(debit[6][:7])
    assert len(days)==24 and min(days)=="2024-11" and max(days)=="2026-10"


def test_generator_never_overwrites_an_existing_directory_and_rejects_infeasible_counts(tmp_path):
    sentinel=tmp_path/"keep.txt";sentinel.write_text("keep",encoding="utf-8")
    with pytest.raises(FileExistsError): generate(tmp_path,rows=200,users=3,heavy_rows=120)
    assert sentinel.read_text()=="keep"
    for args in ((100,3,120),(201,3,120),(200,1,120),(200,3,121),(200,3,True)):
        with pytest.raises(ValueError): owner_counts(*args)


def test_inventory_verification_rejects_changed_csv_index_or_paths(tmp_path):
    root=tmp_path/"data"
    index,digest=generate(root,rows=200,users=3,heavy_rows=120)
    csv_file=root/"owners/u00000/transactions.csv"
    original=csv_file.read_bytes();csv_file.write_bytes(original+b"unexpected\n")
    with pytest.raises(ValueError,match="integrity"): verify(root,digest)
    csv_file.write_bytes(original)
    with pytest.raises(ValueError,match="pinned digest"): verify(root,"0"*64)
    index["owners"][0]["path"]="../../outside"
    raw=(json.dumps(index,sort_keys=True)+"\n").encode()
    (root/"index.json").write_bytes(raw)
    with pytest.raises(ValueError,match="path"): verify(root,hashlib.sha256(raw).hexdigest())
