"""Download public aggregates atomically, or verify the bundled snapshot entirely offline."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import shutil
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT / "services/api"))

from app.statfin import BASE,LICENCE,SNAPSHOT,SPEC,build_query,fingerprint,load_snapshot,sha256,validate_response
from app.statfin_client import ProviderError,StatFinClient


def download(destination,client):
    destination = Path(destination)
    if destination.exists():
        raise ValueError("Use a new release directory; an existing verified snapshot is never overwritten")
    parent = destination.parent
    parent.mkdir(parents=True,exist_ok=True)
    # Public data should inherit workspace ACLs, including Windows sandbox readers.
    stage = parent / (".statfin-stage-"+uuid4().hex)
    stage.mkdir()
    try:
        contents = {"config.json":client.configure(),"catalogue.json":client.request("GET",BASE)}
        catalogue = json.loads(contents["catalogue.json"])
        entries = {entry["id"]:entry for entry in catalogue if isinstance(entry,dict) and entry.get("type")=="t"}
        tables = {}
        for table in SPEC:
            if table+".px" not in entries:
                raise ValueError("Chosen table is absent from the current catalogue")
            url = BASE+"/"+table+".px"
            metadata_raw = client.request("GET",url)
            metadata = json.loads(metadata_raw)
            query = build_query(metadata,table,max_cells=client.max_cells)
            response_raw = client.request("POST",url,query)
            response = json.loads(response_raw)
            cells = validate_response(response,metadata,query,table)
            contents[table+".metadata.json"] = metadata_raw
            contents[table+".query.json"] = (json.dumps(query,indent=2,sort_keys=True)+"\n").encode()
            contents[table+".response.json"] = response_raw
            tables[table] = {"source_url":url,"metadata_url":url,"schema_fingerprint":fingerprint(metadata),
                "data_updated_at":response["updated"],"catalogue_updated_local_time":entries[table+".px"].get("updated"),
                "catalogue_timezone":"unspecified by catalogue; not treated as a UTC publication timestamp",
                "selected_cells":len(cells),"selected_codes":SPEC[table]}
        manifest = {"schema_version":1,"snapshot_id":"statfin-ktutk-2022-"+sha256(b"".join(contents[t+".response.json"] for t in sorted(SPEC)))[:16],
            "retrieved_at":datetime.now(timezone.utc).isoformat(),"reference_period":"2022",
            "statistic_type":"mean","unit":"EUR per household per reference year, current prices",
            "classification_version":"COICOP2018","mapping_version":"unmapped.v1",
            "attribution":"Source: Statistics Finland, households' consumption.","licence":"CC-BY-4.0","licence_url":LICENCE,
            "methodology_url":"https://stat.fi/en/documentation/documentation-of-statistics/ktutk",
            "api_migration_url":"https://stat.fi/en/services/statistical-data-services/open-data-and-interfaces/interface-use-of-databases/instructions-for-updating-interface-queries",
            "tables":tables,"files":{name:sha256(value) for name,value in contents.items()},
            "transforms":["Exact source bytes retained.","No inflation adjustment.","Missing/suppressed cells are not zero.",
                "Any monthly equivalent divides the published annual mean by 12; it is not an observed calendar-month statistic."]}
        for name,value in contents.items():
            (stage / name).write_bytes(value)
        (stage / "manifest.json").write_text(json.dumps(manifest,indent=2,sort_keys=True)+"\n",encoding="utf-8",newline="\n")
        load_snapshot(stage)
        stage.rename(destination)
        return manifest
    finally:
        # Only the exact temporary child created by this invocation can be removed.
        resolved_stage,resolved_parent = stage.resolve(),parent.resolve()
        if resolved_stage.exists() and resolved_stage.parent==resolved_parent and resolved_stage.name.startswith(".statfin-stage-"):
            shutil.rmtree(resolved_stage)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download",action="store_true")
    parser.add_argument("--directory",type=Path,default=SNAPSHOT)
    args = parser.parse_args(argv)
    if args.download:
        client = StatFinClient()
        try:
            manifest = download(args.directory,client)
        except ProviderError as error:
            print(error.code+"; previous snapshots remain unchanged.")
            return 1
        finally:
            client.close()
    else:
        manifest,_,_ = load_snapshot(args.directory)
    print("Verified public snapshot "+manifest["snapshot_id"]+" (42 expenditure cells and 21 household-background cells).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
