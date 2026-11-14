"""Write independently authored, deterministic native CSV source files without bulk lists."""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"backend/api"))
from app.import_csv import COLUMNS,MAX_ROWS

CUSTOMER="authored-customer-1"
OBSERVED="2026-11-04T10:00:00Z"


def write_csv(path,role,rows):
    digest=hashlib.sha256();size=0
    with path.open("wb") as target:
        def emit(cells):
            nonlocal size
            buffer=io.StringIO(newline="")
            csv.writer(buffer,lineterminator="\n").writerow(cells)
            raw=buffer.getvalue().encode("utf-8")
            target.write(raw);digest.update(raw);size+=len(raw)
        emit(COLUMNS[role])
        for row in rows: emit(row)
    return {"role":role,"size_bytes":size,"sha256":digest.hexdigest()}


def transaction_rows(count):
    for index in range(count):
        # Distinct stable IDs preserve legitimate identical purchases.
        yield (CUSTOMER,"daily",f"purchase-{index+1}",1,-125,"EUR","2026-10-15","",OBSERVED,
            "booked","Synthetic cafe","coffee","everyday","expense","","")


def generate(output,count=12):
    if not 0<=count<=MAX_ROWS: raise ValueError("Choose zero to ten million source rows")
    output.mkdir(parents=True,exist_ok=True)
    accounts=[(CUSTOMER,"daily","Authored synthetic account","EUR","current","2026-10-01","2026-11-01",count,-125*count)]
    balances=[(CUSTOMER,"daily","balance-1",250000,"EUR","available","included",0,OBSERVED)]
    files=[write_csv(output/"accounts.csv","accounts",accounts),
        write_csv(output/"transactions.csv","transactions",transaction_rows(count)),
        write_csv(output/"balances.csv","balances",balances)]
    manifest={"mapping_version":"moneylens.synthetic-csv.v1","source_version":f"authored-coffee-{count}-v1",
        "source_customer_ref":CUSTOMER,"currency":"EUR","timezone":"Europe/Helsinki",
        "claimed_from":"2026-10-01","claimed_to_exclusive":"2026-11-01","files":sorted(files,key=lambda file:file["role"])}
    (output/"manifest.json").write_text(json.dumps(manifest,indent=2,sort_keys=True)+"\n",encoding="utf-8",newline="\n")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,default=ROOT/"fixtures/synthetic/import-v1")
    parser.add_argument("--rows",type=int,default=12)
    args=parser.parse_args()
    if not 0<=args.rows<=MAX_ROWS: parser.error("--rows must be zero to ten million")
    generate(args.output,args.rows)
    print(f"Generated authored native CSV source with {args.rows} transactions; no upstream generator or model used.")


if __name__=="__main__": main()
