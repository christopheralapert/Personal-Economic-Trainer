"""Bounded public PxWeb queries and verified immutable JSON-stat snapshots."""
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import itertools
import json
import math
from pathlib import Path

BASE = "https://pxdata.stat.fi/PXWeb/api/v1/en/StatFin/ktutk"
CONFIG_URL = "https://pxdata.stat.fi/PXWeb/api/v1/en/?config"
COICOP = "coicop_46_20231201"
HOUSEHOLD = "elinvaihe_13_20160101"
PERIOD = "timeperiod_y"
METRIC = "contentscode"
COHORTS = ("1","2","3","4","5","6","SSS")
SPEC = {
    "14ph":{PERIOD:["2022"],COICOP:["01","0533","07322","111","1111","1112"],HOUSEHOLD:list(COHORTS),METRIC:["kulu_kt_hk_1_1"]},
    "14lv":{PERIOD:["2022"],HOUSEHOLD:list(COHORTS),METRIC:["oklkm_sum","pklkm_sum","jlkm_mean"]},
}
ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT = ROOT / "fixtures/public/statfin/ktutk-2022-v1"
LICENCE = "https://stat.fi/en/about-us/get-to-know-statistics-finland/legislation/terms-of-use"
EXPENDITURE_UNIT = "EUR per household per reference year, current prices"
ATTRIBUTION = "Source: Statistics Finland, households' consumption."


class SnapshotError(ValueError):
    pass


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def fingerprint(metadata):
    # Labels matter too: changed statistical definitions need explicit mapping review.
    normalized = [{key:variable.get(key) for key in ("code","values","valueTexts")}
                  for variable in metadata["variables"]]
    return sha256(json.dumps(normalized,sort_keys=True,ensure_ascii=True,separators=(",",":")).encode())


def build_query(metadata,table,*,expected_fingerprint=None,max_cells=1000):
    if table not in SPEC:
        raise SnapshotError("UNSUPPORTED_TABLE")
    variables = metadata.get("variables",[])
    if not isinstance(variables,list) or len(variables)!=len(SPEC[table]) or any(not isinstance(variable,dict) for variable in variables):
        raise SnapshotError("SCHEMA_CHANGED")
    codes = [variable.get("code") for variable in variables]
    if len(set(codes))!=len(codes) or set(codes)!=set(SPEC[table]):
        raise SnapshotError("SCHEMA_CHANGED")
    if expected_fingerprint and fingerprint(metadata)!=expected_fingerprint:
        raise SnapshotError("SCHEMA_CHANGED")
    query,cells = [],1
    for variable in variables:
        values = list(SPEC[table][variable["code"]])
        source_values,labels = variable.get("values",[]),variable.get("valueTexts",[])
        if len(source_values)!=len(labels) or len(set(source_values))!=len(source_values) or not set(values)<=set(source_values):
            raise SnapshotError("VALUES_CHANGED")
        cells *= len(values)
        query.append({"code":variable["code"],"selection":{"filter":"item","values":values}})
    if cells>min(max_cells,1000):
        raise SnapshotError("QUERY_TOO_LARGE")
    return {"query":query,"response":{"format":"json-stat2"}}


def index_codes(dimension,size):
    index = dimension.get("category",{}).get("index")
    if isinstance(index,list):
        result = index
    elif isinstance(index,dict) and all(type(value) is int for value in index.values()) and set(index.values())==set(range(size)):
        result = [code for code,_ in sorted(index.items(),key=lambda item:item[1])]
    else:
        raise SnapshotError("INVALID_DIMENSION_INDEX")
    if len(result)!=size or len(set(result))!=size:
        raise SnapshotError("INVALID_DIMENSION_INDEX")
    return result


def validate_response(document,metadata,query,table):
    if document.get("version")!="2.0" or document.get("class")!="dataset":
        raise SnapshotError("INVALID_DATASET")
    ids,sizes = document.get("id",[]),document.get("size",[])
    selected = {item["code"]:item["selection"]["values"] for item in query["query"]}
    if not ids or len(set(ids))!=len(ids) or set(ids)!=set(selected) or len(ids)!=len(sizes):
        raise SnapshotError("SCHEMA_CHANGED")
    if any(type(size) is not int or size<1 for size in sizes) or math.prod(sizes)>1000:
        raise SnapshotError("INVALID_DATASET_SIZE")
    ordered = []
    for code,size in zip(ids,sizes):
        dimension = document.get("dimension",{}).get(code,{})
        codes = index_codes(dimension,size)
        if set(codes)!=set(selected[code]):
            raise SnapshotError("UNEXPECTED_SELECTION")
        source = next(variable for variable in metadata["variables"] if variable["code"]==code)
        labels = dict(zip(source["values"],source["valueTexts"]))
        received = dimension.get("category",{}).get("label",{})
        if any(received.get(value)!=labels[value] for value in codes):
            raise SnapshotError("LABELS_CHANGED")
        ordered.append(codes)
    count = math.prod(sizes)
    values,status = document.get("value"),document.get("status",{})
    if not isinstance(values,(list,dict)) or (isinstance(values,list) and len(values)!=count):
        raise SnapshotError("INVALID_VALUES")
    for mapping in (values,status):
        if isinstance(mapping,dict) and any(not str(key).isdigit() or str(int(key))!=str(key) or not 0<=int(key)<count for key in mapping):
            raise SnapshotError("INVALID_VALUE_INDEX")
    if not isinstance(status,(list,dict)) or (isinstance(status,list) and len(status)!=count):
        raise SnapshotError("INVALID_STATUS")
    if document.get("source") != "Statistics Finland, households' consumption":
        raise SnapshotError("UNEXPECTED_SOURCE")
    units = document["dimension"][METRIC]["category"].get("unit",{})
    if table=="14ph" and units.get("kulu_kt_hk_1_1")!={"base":"euros","decimals":0}:
        raise SnapshotError("UNITS_CHANGED")
    if table=="14lv" and units!={"oklkm_sum":{"decimals":0},"pklkm_sum":{"decimals":0},"jlkm_mean":{"decimals":2}}:
        raise SnapshotError("UNITS_CHANGED")
    cells = []
    for position,combination in enumerate(itertools.product(*ordered)):
        value = values[position] if isinstance(values,list) else values.get(str(position))
        flag = status[position] if isinstance(status,list) else status.get(str(position))
        if value is not None and (type(value) not in (int,float,Decimal) or not Decimal(str(value)).is_finite() or value<0 or value>90071992547409):
            raise SnapshotError("INVALID_OBSERVATION")
        if value is not None:
            metric = combination[ids.index(METRIC)]
            decimals = units.get(metric,{}).get("decimals")
            if type(decimals) is not int or not 0<=decimals<=6 or Decimal(str(value)).quantize(Decimal(1).scaleb(-decimals))!=Decimal(str(value)):
                raise SnapshotError("OBSERVATION_PRECISION_CHANGED")
        if flag is not None and not isinstance(flag,str):
            raise SnapshotError("INVALID_STATUS")
        cells.append({"coordinates":dict(zip(ids,combination)),"value":value,"status":flag})
    return cells


def load_snapshot(directory=SNAPSHOT):
    directory = Path(directory)
    try:
        manifest = json.loads((directory / "manifest.json").read_bytes())
        files = manifest["files"]
        required = {"catalogue.json","config.json"} | {table+suffix for table in SPEC for suffix in (".metadata.json",".query.json",".response.json")}
        if set(files)!=required or type(manifest["schema_version"]) is not int or manifest["schema_version"]!=1 or manifest["reference_period"]!="2022" or manifest["licence"]!="CC-BY-4.0":
            raise SnapshotError("INVALID_MANIFEST")
        if manifest["licence_url"]!=LICENCE or manifest["classification_version"]!="COICOP2018" or set(manifest["tables"])!=set(SPEC):
            raise SnapshotError("INVALID_PROVENANCE")
        if manifest["unit"]!=EXPENDITURE_UNIT or manifest["statistic_type"]!="mean" or manifest["mapping_version"]!="unmapped.v1" or manifest["attribution"]!=ATTRIBUTION:
            raise SnapshotError("INVALID_PROVENANCE")
        retrieved = datetime.fromisoformat(manifest["retrieved_at"])
        if retrieved.tzinfo is None:
            raise SnapshotError("INVALID_RETRIEVAL_DATE")
        raw = {}
        for name,expected in files.items():
            if Path(name).name!=name:
                raise SnapshotError("INVALID_ARTIFACT_PATH")
            content = (directory / name).read_bytes()
            if len(content)>1048576 or sha256(content)!=expected:
                raise SnapshotError("INTEGRITY_FAILURE")
            raw[name] = content
        if manifest["snapshot_id"]!="statfin-ktutk-2022-"+sha256(b"".join(raw[table+".response.json"] for table in sorted(SPEC)))[:16]:
            raise SnapshotError("INVALID_RELEASE_ID")
        parsed = {name:json.loads(value,parse_float=Decimal) for name,value in raw.items()}
        all_cells = {}
        for table in SPEC:
            metadata,query,response = (parsed[table+suffix] for suffix in (".metadata.json",".query.json",".response.json"))
            entry = manifest["tables"][table]
            if entry["source_url"]!=BASE+"/"+table+".px" or entry["metadata_url"]!=entry["source_url"] or entry["data_updated_at"]!=response["updated"] or entry["selected_codes"]!=SPEC[table]:
                raise SnapshotError("INVALID_PROVENANCE")
            expected = build_query(metadata,table,expected_fingerprint=entry["schema_fingerprint"])
            if expected!=query:
                raise SnapshotError("INVALID_QUERY")
            all_cells[table] = validate_response(response,metadata,query,table)
            if entry["selected_cells"]!=len(all_cells[table]):
                raise SnapshotError("INVALID_PROVENANCE")
        return manifest,parsed,all_cells
    except (OSError,KeyError,TypeError,json.JSONDecodeError,StopIteration,AttributeError) as error:
        raise SnapshotError("INVALID_SNAPSHOT") from error


def money_minor(value,divisor=1):
    if value is None:
        return None
    return int((Decimal(str(value))*100/Decimal(divisor)).quantize(Decimal(1),rounding=ROUND_HALF_UP))
